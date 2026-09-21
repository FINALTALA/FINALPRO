import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AuditLogService } from '../audit/audit-log.service';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  AuthenticatedUser,
  SessionAuthGuard,
} from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateApplicableCategoriesDto } from './dto/update-applicable-categories.dto';
import { UpdateStorefrontDto } from './dto/update-storefront.dto';

// Sprint 7 (RB-STOREF-001, PDR-011/PDR-007). Owner-only throughout,
// per-method (not class-level) @RequireVendorRole('OWNER') - the same
// requirement documented on VendorOffersController/MatchReviewController:
// VendorMembershipGuard reads @RequireVendorRole via
// Reflector.get(KEY, context.getHandler()), which never sees a class-
// level decorator. "الموظف ممنوع من تعديل أو قراءة إعدادات المحل
// الحساسة" (an employee may neither edit nor even read these settings) -
// every route here, reads included, is owner-only; the *public*
// storefront (name/logo/bio/contacts only, never these full settings)
// is StorefrontPublicController below, a completely separate,
// unauthenticated route.
function ownerStorefrontDto(vendor: {
  id: string;
  slug: string;
  displayName: string | null;
  legalName: string;
  logoUrl: string | null;
  bio: string | null;
  coverImageUrl: string | null;
  coverColor: string | null;
  instagramUrl: string | null;
  facebookUrl: string | null;
  whatsappUrl: string | null;
  storefrontPublished: boolean;
}) {
  return {
    vendor_id: vendor.id,
    slug: vendor.slug,
    display_name: vendor.displayName ?? vendor.legalName,
    logo_url: vendor.logoUrl,
    bio: vendor.bio,
    cover_image_url: vendor.coverImageUrl,
    cover_color: vendor.coverColor,
    instagram_url: vendor.instagramUrl,
    facebook_url: vendor.facebookUrl,
    whatsapp_url: vendor.whatsappUrl,
    is_published: vendor.storefrontPublished,
  };
}

@Controller('vendors')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class StorefrontController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  private async requireVendor(vendorId: string) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
    });
    if (!vendor) {
      throw new NotFoundException({
        code: 'VENDOR_NOT_FOUND',
        message: 'Vendor not found',
      });
    }
    return vendor;
  }

  @Get(':vendorId/storefront')
  @RequireVendorRole('OWNER')
  async getSettings(@Param('vendorId') vendorId: string) {
    const vendor = await this.requireVendor(vendorId);
    return ownerStorefrontDto(vendor);
  }

  @Put(':vendorId/storefront')
  @RequireVendorRole('OWNER')
  async updateSettings(
    @Param('vendorId') vendorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateStorefrontDto,
    @Req() req: Request,
  ) {
    const vendor = await this.requireVendor(vendorId);
    const updated = await this.prisma.vendor.update({
      where: { id: vendorId },
      data: {
        displayName: dto.display_name,
        logoUrl: dto.logo_url,
        bio: dto.bio,
        coverImageUrl: dto.cover_image_url,
        coverColor: dto.cover_color,
        instagramUrl: dto.instagram_url,
        facebookUrl: dto.facebook_url,
        whatsappUrl: dto.whatsapp_url,
      },
    });
    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'vendor.storefront_updated',
      entityType: 'Vendor',
      entityId: vendorId,
      beforeState: ownerStorefrontDto(vendor),
      afterState: ownerStorefrontDto(updated),
    });
    return ownerStorefrontDto(updated);
  }

  // PDR-007: "Each store must publish at least one external contact
  // route: Instagram, Facebook, or WhatsApp" - checked only at this
  // moment, not continuously (an owner may still freely edit other
  // storefront fields while unpublished with no contact set yet).
  //
  // Sprint 8 round 2 review fix (RB-STOREF-004, PDR-013): PDR-013
  // requires applicable_categories at REGISTRATION now
  // (VendorsController.apply() - see CreateVendorDto's own comment),
  // not merely before publishing - this check stays here too, purely as
  // a backstop for any vendor row that predates that fix (this
  // migration never touches historical data), not as the primary
  // enforcement point anymore.
  @Post(':vendorId/storefront/publish')
  @HttpCode(200)
  @RequireVendorRole('OWNER')
  async publish(
    @Param('vendorId') vendorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const vendor = await this.requireVendor(vendorId);
    if (!vendor.instagramUrl && !vendor.facebookUrl && !vendor.whatsappUrl) {
      throw new ForbiddenException({
        code: 'CONTACT_METHOD_REQUIRED',
        message:
          'At least one contact method (Instagram, Facebook, or WhatsApp) is required before publishing (PDR-007)',
      });
    }
    const applicableCategoryCount =
      await this.prisma.vendorApplicableCategory.count({ where: { vendorId } });
    if (applicableCategoryCount === 0) {
      throw new ForbiddenException({
        code: 'APPLICABLE_CATEGORY_REQUIRED',
        message:
          'At least one applicable store category (Women/Men/Kids/Accessories) is required before publishing (PDR-013)',
      });
    }
    const updated = await this.prisma.vendor.update({
      where: { id: vendorId },
      data: { storefrontPublished: true },
    });
    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'vendor.storefront_published',
      entityType: 'Vendor',
      entityId: vendorId,
      afterState: { is_published: true },
    });
    return ownerStorefrontDto(updated);
  }

  @Post(':vendorId/storefront/unpublish')
  @HttpCode(200)
  @RequireVendorRole('OWNER')
  async unpublish(
    @Param('vendorId') vendorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    await this.requireVendor(vendorId);
    const updated = await this.prisma.vendor.update({
      where: { id: vendorId },
      data: { storefrontPublished: false },
    });
    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'vendor.storefront_unpublished',
      entityType: 'Vendor',
      entityId: vendorId,
      afterState: { is_published: false },
    });
    return ownerStorefrontDto(updated);
  }

  // Sprint 8 (RB-STOREF-004, PDR-013). Owner-only read/replace of the
  // vendor's applicable discovery categories - see
  // UpdateApplicableCategoriesDto's own comment for why this is not part
  // of VendorsController.apply()'s request contract.
  @Get(':vendorId/applicable-categories')
  @RequireVendorRole('OWNER')
  async getApplicableCategories(@Param('vendorId') vendorId: string) {
    await this.requireVendor(vendorId);
    const rows = await this.prisma.vendorApplicableCategory.findMany({
      where: { vendorId },
      orderBy: { category: 'asc' },
    });
    return { categories: rows.map((r) => r.category) };
  }

  @Put(':vendorId/applicable-categories')
  @RequireVendorRole('OWNER')
  async updateApplicableCategories(
    @Param('vendorId') vendorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateApplicableCategoriesDto,
    @Req() req: Request,
  ) {
    await this.requireVendor(vendorId);
    const updated = await this.prisma.$transaction(async (tx) => {
      // Full replace, not a delta (see the DTO's own comment) - delete
      // every existing row for this vendor, then insert the submitted
      // set. Small, owner-scoped table (at most 4 possible categories),
      // so a delete+recreate is simpler and just as safe as a diffed
      // upsert here.
      await tx.vendorApplicableCategory.deleteMany({ where: { vendorId } });
      if (dto.categories.length > 0) {
        await tx.vendorApplicableCategory.createMany({
          data: dto.categories.map((category) => ({ vendorId, category })),
        });
      }
      return tx.vendorApplicableCategory.findMany({
        where: { vendorId },
        orderBy: { category: 'asc' },
      });
    });
    await this.auditLog.record({
      actorId: user.id,
      correlationId: req.correlationId,
      action: 'vendor.applicable_categories_updated',
      entityType: 'Vendor',
      entityId: vendorId,
      afterState: { categories: updated.map((r) => r.category) },
    });
    return { categories: updated.map((r) => r.category) };
  }
}
