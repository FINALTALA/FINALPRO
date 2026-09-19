import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import { AuditLogService } from '../audit/audit-log.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { PlatformRole, Prisma } from '../../generated/prisma/client';
import { RequirePlatformRole } from '../auth/platform-role.decorator';
import { PlatformRoleGuard } from '../auth/platform-role.guard';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { IdempotencyCompletionService } from '../common/idempotency/idempotency-completion.service';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCanonicalProductDto } from './dto/create-canonical-product.dto';
import { CreateCanonicalVariantDto } from './dto/create-canonical-variant.dto';

// FR-MATCH-008 / BL-MATCH-001: level 1 + 2 of the four-level canonical
// model. Read routes are public; writes require PLATFORM_ADMIN (Part 3:
// CanonicalProduct/CanonicalProductVariant are Platform-owned).
@Controller('canonical-products')
export class CanonicalProductsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly idempotencyCompletion: IdempotencyCompletionService,
  ) {}

  private toDto(product: {
    id: string;
    brandId: string;
    categoryId: string;
    modelName: string;
    status: string;
  }) {
    return {
      id: product.id,
      brand_id: product.brandId,
      category_id: product.categoryId,
      model_name: product.modelName,
      status: product.status,
    };
  }

  private variantToDto(variant: {
    id: string;
    canonicalProductId: string;
    structuralAttributes: Prisma.JsonValue;
    mpn: string | null;
    gtin: string | null;
  }) {
    return {
      id: variant.id,
      canonical_product_id: variant.canonicalProductId,
      structural_attributes: variant.structuralAttributes,
      mpn: variant.mpn,
      gtin: variant.gtin,
    };
  }

  @Get()
  async list() {
    const products = await this.prisma.canonicalProduct.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return products.map((p) => this.toDto(p));
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const product = await this.prisma.canonicalProduct.findUnique({
      where: { id },
      include: { variants: true },
    });
    if (!product) {
      throw new NotFoundException({
        code: 'CANONICAL_PRODUCT_NOT_FOUND',
        message: 'Canonical product not found',
      });
    }
    return {
      ...this.toDto(product),
      variants: product.variants.map((v) => this.variantToDto(v)),
    };
  }

  @Post()
  @HttpCode(201)
  @UseGuards(SessionAuthGuard, PlatformRoleGuard)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCanonicalProductDto,
    @Req() req: Request,
  ) {
    const [brand, category] = await Promise.all([
      this.prisma.brand.findUnique({ where: { id: dto.brand_id } }),
      this.prisma.category.findUnique({ where: { id: dto.category_id } }),
    ]);
    if (!brand) {
      throw new NotFoundException({
        code: 'BRAND_NOT_FOUND',
        message: 'brand_id does not reference an existing brand',
      });
    }
    if (!category) {
      throw new NotFoundException({
        code: 'CATEGORY_NOT_FOUND',
        message: 'category_id does not reference an existing category',
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const product = await tx.canonicalProduct.create({
        data: {
          brandId: dto.brand_id,
          categoryId: dto.category_id,
          modelName: dto.model_name,
          status: dto.status,
        },
      });

      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action: 'canonical_product.created',
          entityType: 'CanonicalProduct',
          entityId: product.id,
          afterState: this.toDto(product),
        },
        tx,
      );

      const body = this.toDto(product);
      await this.idempotencyCompletion.complete(
        tx,
        req.idempotencyClaimId,
        body,
        201,
      );
      return body;
    });
  }

  @Post(':id/variants')
  @HttpCode(201)
  @UseGuards(SessionAuthGuard, PlatformRoleGuard)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  async createVariant(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') productId: string,
    @Body() dto: CreateCanonicalVariantDto,
    @Req() req: Request,
  ) {
    const product = await this.prisma.canonicalProduct.findUnique({
      where: { id: productId },
    });
    if (!product) {
      throw new NotFoundException({
        code: 'CANONICAL_PRODUCT_NOT_FOUND',
        message: 'Canonical product not found',
      });
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const variant = await tx.canonicalProductVariant.create({
          data: {
            canonicalProductId: productId,
            structuralAttributes:
              dto.structural_attributes as Prisma.InputJsonValue,
            mpn: dto.mpn,
            gtin: dto.gtin,
          },
        });

        await this.auditLog.record(
          {
            actorId: user.id,
            correlationId: req.correlationId,
            action: 'canonical_product_variant.created',
            entityType: 'CanonicalProductVariant',
            entityId: variant.id,
            afterState: this.variantToDto(variant),
          },
          tx,
        );

        const body = this.variantToDto(variant);
        await this.idempotencyCompletion.complete(
          tx,
          req.idempotencyClaimId,
          body,
          201,
        );
        return body;
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException({
          code: 'VARIANT_IDENTIFIER_ALREADY_EXISTS',
          message: 'A variant with this mpn/gtin already exists',
        });
      }
      throw err;
    }
  }

  @Get(':id/variants')
  async listVariants(@Param('id') productId: string) {
    const product = await this.prisma.canonicalProduct.findUnique({
      where: { id: productId },
    });
    if (!product) {
      throw new NotFoundException({
        code: 'CANONICAL_PRODUCT_NOT_FOUND',
        message: 'Canonical product not found',
      });
    }
    const variants = await this.prisma.canonicalProductVariant.findMany({
      where: { canonicalProductId: productId },
      orderBy: { createdAt: 'asc' },
    });
    return variants.map((v) => this.variantToDto(v));
  }
}
