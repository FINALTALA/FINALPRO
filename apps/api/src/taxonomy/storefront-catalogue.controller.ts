import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { ProductAudience } from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { BlockWhenSuspended } from '../auth/vendor-suspended.guard';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateStorefrontCatalogueDto } from './dto/storefront-catalogue.dto';
import { DEPARTMENTS, storeDepartments } from './storefront-catalogue';
import { TaxonomyService } from './taxonomy.service';

function bad(code: string, message: string, details: unknown[] = []): never {
  throw new BadRequestException({ code, message, details });
}

// The owner's storefront catalogue structure: the main departments the
// store offers (WOMEN/MEN/KIDS - its store types, which discovery's
// `segment` reads too) and the detailed taxonomy categories under each.
// Owner only; the public side only reads it (GET /storefronts/:slug/products).
@Controller('vendors/:vendorId/storefront/catalogue')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class StorefrontCatalogueController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly auditLog: AuditLogService,
  ) {}

  private async requireVendor(vendorId: string) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { id: true },
    });
    if (!vendor) {
      throw new NotFoundException({
        code: 'VENDOR_NOT_FOUND',
        message: 'Vendor not found',
      });
    }
  }

  @Get()
  @RequireVendorRole('OWNER')
  async get(@Param('vendorId') vendorId: string) {
    await this.requireVendor(vendorId);
    return {
      departments: await storeDepartments(
        this.prisma,
        vendorId,
        await this.taxonomy.get(),
      ),
    };
  }

  /**
   * Full replacement: `departments` (any of WOMEN/MEN/KIDS) and, for each
   * offered department, the detailed categories in display order. Every
   * code must be a taxonomy category of THAT audience. At least one store
   * type must remain (PDR-013) - an ACCESSORIES store type is kept as is.
   */
  @BlockWhenSuspended()
  @Put()
  @RequireVendorRole('OWNER')
  async update(
    @Param('vendorId') vendorId: string,
    @Body() dto: UpdateStorefrontCatalogueDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    await this.requireVendor(vendorId);
    const t = await this.taxonomy.get();
    const departments = dto.departments;
    const categories = dto.categories ?? {};
    for (const key of Object.keys(categories)) {
      if (!DEPARTMENTS.includes(key as ProductAudience)) {
        bad('UNKNOWN_AUDIENCE', `Unknown department: ${key}`, [key]);
      }
      if (!departments.includes(key as ProductAudience)) {
        bad(
          'DEPARTMENT_NOT_OFFERED',
          `Categories were sent for ${key}, which is not one of the store's departments`,
          [key],
        );
      }
      const codes = categories[key];
      if (
        !Array.isArray(codes) ||
        codes.some((c) => typeof c !== 'string') ||
        new Set(codes).size !== codes.length ||
        codes.length > 60
      ) {
        bad(
          'INVALID_CATEGORIES',
          `categories.${key} must be a list of distinct category codes`,
          [key],
        );
      }
      const unknown = codes.filter((c) => !t.categoryAudiences.has(c));
      if (unknown.length) {
        bad(
          'UNKNOWN_CATEGORY',
          `Unknown category code(s): ${unknown.join(', ')}`,
          unknown,
        );
      }
      const outside = codes.filter(
        (c) => !t.categoryAudiences.get(c)!.has(key as ProductAudience),
      );
      if (outside.length) {
        bad(
          'CATEGORY_NOT_IN_AUDIENCE',
          `Category ${outside.join(', ')} does not belong to ${key}`,
          outside,
        );
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM vendors WHERE id = ${vendorId} FOR UPDATE`;
      const others = await tx.vendorApplicableCategory.count({
        where: { vendorId, category: { notIn: DEPARTMENTS } },
      });
      if (departments.length + others === 0) {
        bad(
          'STORE_TYPE_REQUIRED',
          'At least one store type (Women/Men/Kids/Accessories) must remain set (PDR-013)',
        );
      }
      await tx.vendorApplicableCategory.deleteMany({
        where: {
          vendorId,
          category: { in: DEPARTMENTS.filter((d) => !departments.includes(d)) },
        },
      });
      for (const category of departments) {
        await tx.vendorApplicableCategory.upsert({
          where: { vendorId_category: { vendorId, category } },
          create: { vendorId, category },
          update: {},
        });
      }
      // Each department in the body replaces its list; a department not
      // mentioned keeps its stored categories (also while it is switched
      // off, so turning it back on restores them).
      for (const [audience, codes] of Object.entries(categories)) {
        await tx.storefrontCategory.deleteMany({
          where: { vendorId, audience: audience as ProductAudience },
        });
        if (codes.length) {
          await tx.storefrontCategory.createMany({
            data: codes.map((categoryCode, sortOrder) => ({
              vendorId,
              audience: audience as ProductAudience,
              categoryCode,
              sortOrder,
            })),
          });
        }
      }
    });

    const result = {
      departments: await storeDepartments(this.prisma, vendorId, t),
    };
    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'vendor.storefront_catalogue_updated',
      entityType: 'Vendor',
      entityId: vendorId,
      afterState: {
        departments: result.departments.map((d) => ({
          audience: d.audience,
          categories: d.categories.map((c) => c.code),
        })),
      },
    });
    return result;
  }
}
