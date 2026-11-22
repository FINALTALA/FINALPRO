import {
  Controller,
  Get,
  NotFoundException,
  Param,
  UseGuards,
} from '@nestjs/common';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 2026-11-18 (store workspace notifications): where a version (colour x
 * size) of THIS store lives - its product, colour and size - so a store
 * notification that names only the version (the low-stock notice) can open
 * the product it is about and highlight that colour and size. A read; a
 * version of another store is a 404 (never confirmed).
 */
@Controller('vendors/:vendorId/offer-variants/:variantId/locate')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
export class VariantLocateController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequireVendorRole('OWNER', 'BRANCH_EMPLOYEE')
  async locate(
    @Param('vendorId') vendorId: string,
    @Param('variantId') variantId: string,
  ) {
    const v = await this.prisma.offerVariant.findUnique({
      where: { id: variantId },
      select: {
        id: true,
        colour: true,
        size: true,
        colorCode: true,
        sizeCode: true,
        offerColor: { select: { nameAr: true, nameEn: true } },
        vendorOffer: {
          select: { id: true, vendorId: true, titleAr: true, titleEn: true },
        },
      },
    });
    if (!v || v.vendorOffer.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'OFFER_VARIANT_NOT_FOUND',
        message: 'Version not found',
      });
    }
    return {
      variant_id: v.id,
      offer_id: v.vendorOffer.id,
      title_ar: v.vendorOffer.titleAr,
      title_en: v.vendorOffer.titleEn,
      color_name_ar: v.offerColor?.nameAr ?? v.colour,
      color_name_en: v.offerColor?.nameEn ?? null,
      color_code: v.colorCode,
      size_code: v.sizeCode,
      size: v.size,
    };
  }
}
