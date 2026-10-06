import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
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
import { findSimilarBrands } from './duplicate-check.util';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

// FR-CAT-002 / BL-CAT-002's FK-satisfying minimum only (see Brand's
// schema comment) - a governed, non-duplicate name list, not the full
// fuzzy duplicate-detection feature (deferred, Should/stretch).
@Controller('brands')
export class BrandsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly idempotencyCompletion: IdempotencyCompletionService,
  ) {}

  @Get()
  async list() {
    const brands = await this.prisma.brand.findMany({
      orderBy: { name: 'asc' },
    });
    return brands.map((b) => ({ id: b.id, name: b.name }));
  }

  @Post()
  @HttpCode(201)
  @UseGuards(SessionAuthGuard, PlatformRoleGuard)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  @UseInterceptors(IdempotencyInterceptor)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBrandDto,
    @Req() req: Request,
  ) {
    if (!dto.confirm_despite_duplicate_warning) {
      const similar = await findSimilarBrands(this.prisma, dto.name);
      if (similar.length > 0) {
        throw new ConflictException({
          code: 'POSSIBLE_DUPLICATE',
          message:
            'A similarly-named brand already exists - resubmit with confirm_despite_duplicate_warning to proceed anyway',
          details: similar.map((s) => ({
            id: s.id,
            name: s.name,
            similarity: s.similarity,
          })),
        });
      }
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const brand = await tx.brand.create({
          data: { name: dto.name, normalizedName: normalize(dto.name) },
        });

        await this.auditLog.record(
          {
            actorId: user.id,
            correlationId: req.correlationId,
            action: 'brand.created',
            entityType: 'Brand',
            entityId: brand.id,
            afterState: { name: brand.name },
          },
          tx,
        );

        const body = { id: brand.id, name: brand.name };
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
          code: 'BRAND_ALREADY_EXISTS',
          message: 'A brand with this name already exists',
        });
      }
      throw err;
    }
  }

  // Sprint 17b (FR-CAT-002): brand admin completion - create+list was
  // all Sprint 3 shipped (see this controller's own top comment); edit
  // and delete were the real gap.
  @Patch(':id')
  @UseGuards(SessionAuthGuard, PlatformRoleGuard)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateBrandDto,
    @Req() req: Request,
  ) {
    const existing = await this.prisma.brand.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException({
        code: 'BRAND_NOT_FOUND',
        message: 'Brand not found',
      });
    }
    try {
      const brand = await this.prisma.brand.update({
        where: { id },
        data: { name: dto.name, normalizedName: dto.name.trim().toLowerCase() },
      });
      await this.auditLog.record({
        actorId: user.id,
        correlationId: req.correlationId,
        action: 'brand.updated',
        entityType: 'Brand',
        entityId: id,
        beforeState: { name: existing.name },
        afterState: { name: brand.name },
      });
      return { id: brand.id, name: brand.name };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException({
          code: 'BRAND_ALREADY_EXISTS',
          message: 'A brand with this name already exists',
        });
      }
      throw err;
    }
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(SessionAuthGuard, PlatformRoleGuard)
  @RequirePlatformRole(PlatformRole.PLATFORM_ADMIN)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    const existing = await this.prisma.brand.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException({
        code: 'BRAND_NOT_FOUND',
        message: 'Brand not found',
      });
    }
    if (existing.isNoBrandSentinel) {
      throw new ConflictException({
        code: 'BRAND_SENTINEL_IMMUTABLE',
        message: 'The "No brand" sentinel cannot be deleted',
      });
    }
    const [inUseCanonical, inUseOffer] = await Promise.all([
      this.prisma.canonicalProduct.findFirst({
        where: { brandId: id },
        select: { id: true },
      }),
      this.prisma.vendorOffer.findFirst({
        where: { brandId: id },
        select: { id: true },
      }),
    ]);
    if (inUseCanonical || inUseOffer) {
      throw new ConflictException({
        code: 'BRAND_IN_USE',
        message: 'Brand has canonical products or offers and cannot be deleted',
      });
    }
    await this.prisma.brand.delete({ where: { id } });
    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'brand.deleted',
      entityType: 'Brand',
      entityId: id,
      beforeState: { name: existing.name },
    });
  }
}
