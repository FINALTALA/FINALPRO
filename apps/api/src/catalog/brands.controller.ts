import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
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
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBrandDto } from './dto/create-brand.dto';

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
    let brand;
    try {
      brand = await this.prisma.brand.create({
        data: { name: dto.name, normalizedName: normalize(dto.name) },
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

    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'brand.created',
      entityType: 'Brand',
      entityId: brand.id,
      afterState: { name: brand.name },
    });

    return { id: brand.id, name: brand.name };
  }
}
