import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Sprint 7 (RB-STOREF-001, PDR-011): the actual public storefront -
// deliberately NO guard at all (no SessionAuthGuard, reachable by
// anyone, logged in or not). Never includes: warehouse (hidden per
// PDR-010, has no public read path anywhere in this codebase - see
// Warehouse's own schema comment), legalName (the registration
// identity, distinct from the public displayName), subscriptionStatus,
// or storeType. Everything StorefrontController's owner-only settings
// expose beyond what's returned here (there is nothing extra there,
// in fact - the two DTOs happen to carry the same public fields plus
// is_published) stays behind that separate, authenticated controller.
@Controller('storefronts')
export class StorefrontPublicController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':slug')
  async getBySlug(@Param('slug') slug: string) {
    const vendor = await this.prisma.vendor.findUnique({ where: { slug } });
    if (!vendor) {
      throw new NotFoundException({
        code: 'STOREFRONT_NOT_FOUND',
        message: 'No store found for this URL',
      });
    }

    // "إن كان المحل غير متاح، يبقى الاسم/الهوية ظاهرين مع حالة واضحة" -
    // identity always shows; is_available combines the owner's own
    // publish action with the vendor's real lifecycle status (a
    // published-but-since-SUSPENDED store must not read as available
    // just because the owner once published it) - never a 404 either
    // way, matching the requirement literally.
    const isAvailable =
      vendor.storefrontPublished && vendor.status === 'ACTIVE';

    return {
      slug: vendor.slug,
      display_name: vendor.displayName ?? vendor.legalName,
      logo_url: vendor.logoUrl,
      bio: vendor.bio,
      cover_image_url: vendor.coverImageUrl,
      cover_color: vendor.coverColor,
      instagram_url: vendor.instagramUrl,
      facebook_url: vendor.facebookUrl,
      whatsapp_url: vendor.whatsappUrl,
      is_available: isAvailable,
    };
  }
}
