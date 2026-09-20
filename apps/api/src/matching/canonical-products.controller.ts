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
import { randomUUID } from 'crypto';
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
import { generatePlatformProductBarcode } from '../common/barcode.util';
import { IdempotencyCompletionService } from '../common/idempotency/idempotency-completion.service';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { CanonicalNamingService } from './canonical-naming.service';
import { CreateCanonicalProductDto } from './dto/create-canonical-product.dto';
import { CreateCanonicalVariantDto } from './dto/create-canonical-variant.dto';
import { DecideNameChangeRequestDto } from './dto/decide-name-change-request.dto';
import { nameChangeRequestDto } from './match-review.controller';

// FR-MATCH-008 / BL-MATCH-001: level 1 + 2 of the four-level canonical
// model. Read routes are public; writes require PLATFORM_ADMIN (Part 3:
// CanonicalProduct/CanonicalProductVariant are Platform-owned).
@Controller('canonical-products')
export class CanonicalProductsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly canonicalNaming: CanonicalNamingService,
    private readonly idempotencyCompletion: IdempotencyCompletionService,
  ) {}

  private toDto(product: {
    id: string;
    brandId: string;
    categoryId: string;
    modelName: string;
    status: string;
    canonicalNameAr: string | null;
    canonicalNameEn: string | null;
  }) {
    return {
      id: product.id,
      brand_id: product.brandId,
      category_id: product.categoryId,
      model_name: product.modelName,
      status: product.status,
      // Sprint 7 (RB-MATCH-003): the customer-facing name, once a
      // first vendor has confirmed a match - null until then. Never
      // the internal platformProductBarcode (see that field's own
      // comment on CanonicalProductVariant, which this DTO already
      // never includes either).
      canonical_name_ar: product.canonicalNameAr,
      canonical_name_en: product.canonicalNameEn,
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

  // Sprint 7 (RB-MATCH-003): the admin queue - every vendor's PENDING
  // rename request across every canonical product, oldest first (a
  // reviewer works through it in submission order). Created by
  // MatchReviewController.requestNameChange() (owner-only, vendor-
  // scoped); only ever decided here. Declared before @Get(':id') below
  // deliberately - NestJS/Express matches routes in declaration order,
  // and :id would otherwise swallow the literal "name-change-requests"
  // segment as if it were an id.
  @Get('name-change-requests')
  @UseGuards(SessionAuthGuard, PlatformRoleGuard)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  async listNameChangeRequests() {
    const requests = await this.prisma.canonicalNameChangeRequest.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    });
    return requests.map(nameChangeRequestDto);
  }

  // Approval propagates the new name to the CanonicalProduct itself and
  // every VendorOffer currently matched to it (CanonicalNamingService.
  // applyApprovedRename()) - "the new name becomes canonical for every
  // related matched offer." Locks the CanonicalProduct row first (same
  // fixed lock order as confirmMatch()/decide(), so this can never race
  // a concurrent first-confirmation or another decision for the same
  // product) and auto-rejects every other still-PENDING request for
  // the same product - only one name can stand, the same "no
  // conflicting outcome left dangling" pattern this codebase already
  // uses for match candidates/staff invites. Same route-ordering
  // reasoning as listNameChangeRequests above - must precede
  // @Get(':id').
  @Post('name-change-requests/:requestId/decision')
  @HttpCode(200)
  @UseGuards(SessionAuthGuard, PlatformRoleGuard)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  async decideNameChangeRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Param('requestId') requestId: string,
    @Body() dto: DecideNameChangeRequestDto,
    @Req() req: Request,
  ) {
    const preCheck = await this.prisma.canonicalNameChangeRequest.findUnique({
      where: { id: requestId },
    });
    if (!preCheck) {
      throw new NotFoundException({
        code: 'NAME_CHANGE_REQUEST_NOT_FOUND',
        message: 'Name change request not found',
      });
    }

    const body = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM canonical_products WHERE id = ${preCheck.canonicalProductId} FOR UPDATE`;

      const request = await tx.canonicalNameChangeRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      if (request.status !== 'PENDING') {
        throw new ConflictException({
          code: 'NAME_CHANGE_REQUEST_ALREADY_DECIDED',
          message: 'This name change request has already been decided',
        });
      }

      let updated;
      if (dto.decision === 'reject') {
        updated = await tx.canonicalNameChangeRequest.update({
          where: { id: requestId },
          data: {
            status: 'REJECTED',
            decidedById: user.id,
            decidedAt: new Date(),
          },
        });
      } else {
        updated = await tx.canonicalNameChangeRequest.update({
          where: { id: requestId },
          data: {
            status: 'APPROVED',
            decidedById: user.id,
            decidedAt: new Date(),
          },
        });
        await this.canonicalNaming.applyApprovedRename(
          tx,
          request.canonicalProductId,
          request.requestedNameAr,
          request.requestedNameEn,
          user.id,
          req.correlationId,
        );
        await tx.canonicalNameChangeRequest.updateMany({
          where: {
            canonicalProductId: request.canonicalProductId,
            status: 'PENDING',
            id: { not: requestId },
          },
          data: {
            status: 'REJECTED',
            decidedById: user.id,
            decidedAt: new Date(),
          },
        });
      }

      await this.auditLog.record(
        {
          actorId: user.id,
          correlationId: req.correlationId,
          action:
            dto.decision === 'approve'
              ? 'canonical_name_change_request.approved'
              : 'canonical_name_change_request.rejected',
          entityType: 'CanonicalNameChangeRequest',
          entityId: requestId,
          afterState: nameChangeRequestDto(updated),
        },
        tx,
      );

      const responseBody = nameChangeRequestDto(updated);
      await this.idempotencyCompletion.complete(
        tx,
        req.idempotencyClaimId,
        responseBody,
        200,
      );
      return responseBody;
    });

    return body;
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
        // Sprint 5 (RB-INV-001): the id is generated up front (rather
        // than left to the column's own @default(uuid())) so
        // platformProductBarcode can be derived from it deterministically
        // before the row is inserted - see barcode.util.ts.
        const id = randomUUID();
        const variant = await tx.canonicalProductVariant.create({
          data: {
            id,
            canonicalProductId: productId,
            structuralAttributes:
              dto.structural_attributes as Prisma.InputJsonValue,
            mpn: dto.mpn,
            gtin: dto.gtin,
            platformProductBarcode: generatePlatformProductBarcode(id),
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
