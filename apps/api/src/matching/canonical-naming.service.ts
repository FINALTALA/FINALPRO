import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';

/**
 * Sprint 7 (RB-MATCH-003, approved-product-decisions-2026-09.md
 * Sec 3.2): "The first confirmed matched offer supplies a provisional
 * canonical name... A later matching vendor must adopt the canonical
 * name if it accepts that the product is identical."
 *
 * Shared between VendorOffersController.confirmMatch() (the exact-
 * identifier match flow) and MatchReviewController.decide() (the non-
 * exact review-queue flow) - both are "a vendor just confirmed their
 * offer matches this CanonicalProduct," and this is the one place that
 * decides what happens to the name as a result, so the two flows can
 * never drift into different naming behavior.
 *
 * MUST be called only after the caller has already locked the target
 * CanonicalProduct row (`SELECT ... FOR UPDATE`) in the same
 * transaction, and locked it BEFORE locking whatever VendorOffer row
 * it also locks (both call sites lock canonical_products first, then
 * vendor_offers, in that fixed order) - this method does not itself
 * acquire any lock. The fixed lock order across both call sites is
 * what actually prevents both the race this sprint's own requirement
 * calls out (two stores confirming to the same CanonicalProduct at the
 * same instant, each thinking they are "first") and any deadlock
 * between the two locks (two concurrent transactions taking
 * canonical_products then vendor_offers, vs. vendor_offers then
 * canonical_products, could deadlock if the order weren't fixed the
 * same way everywhere).
 */
@Injectable()
export class CanonicalNamingService {
  constructor(private readonly auditLog: AuditLogService) {}

  async applyOnConfirm(
    tx: Prisma.TransactionClient,
    canonicalProductId: string,
    vendorOfferId: string,
    actorId: string,
    correlationId: string,
  ): Promise<void> {
    const canonicalProduct = await tx.canonicalProduct.findUniqueOrThrow({
      where: { id: canonicalProductId },
    });
    const offer = await tx.vendorOffer.findUniqueOrThrow({
      where: { id: vendorOfferId },
    });

    if (
      canonicalProduct.canonicalNameAr === null ||
      canonicalProduct.canonicalNameEn === null
    ) {
      // First confirmer for this product - their own offer title
      // becomes the provisional canonical name.
      await tx.canonicalProduct.update({
        where: { id: canonicalProductId },
        data: {
          canonicalNameAr: offer.titleAr,
          canonicalNameEn: offer.titleEn,
        },
      });
      await this.auditLog.record(
        {
          actorId,
          correlationId,
          action: 'canonical_product.name_set_provisional',
          entityType: 'CanonicalProduct',
          entityId: canonicalProductId,
          afterState: {
            canonical_name_ar: offer.titleAr,
            canonical_name_en: offer.titleEn,
            source_vendor_offer_id: vendorOfferId,
          },
        },
        tx,
      );
      return;
    }

    // A canonical name already exists - this vendor's own offer must
    // adopt it, so no two different names remain for the same matched
    // product. A no-op (no write, no audit row) if this offer's title
    // already happens to match already.
    if (
      offer.titleAr !== canonicalProduct.canonicalNameAr ||
      offer.titleEn !== canonicalProduct.canonicalNameEn
    ) {
      await tx.vendorOffer.update({
        where: { id: vendorOfferId },
        data: {
          titleAr: canonicalProduct.canonicalNameAr,
          titleEn: canonicalProduct.canonicalNameEn,
        },
      });
      await this.auditLog.record(
        {
          actorId,
          correlationId,
          action: 'vendor_offer.title_adopted_canonical_name',
          entityType: 'VendorOffer',
          entityId: vendorOfferId,
          beforeState: { title_ar: offer.titleAr, title_en: offer.titleEn },
          afterState: {
            title_ar: canonicalProduct.canonicalNameAr,
            title_en: canonicalProduct.canonicalNameEn,
          },
        },
        tx,
      );
    }
  }

  /**
   * RB-MATCH-003: applies an admin-approved rename to the
   * CanonicalProduct itself and every VendorOffer currently matched to
   * it (via any of its variants' confirmed OfferVariants) - "the new
   * name becomes canonical for every related matched offer." Called
   * from CanonicalProductsController.decideNameChangeRequest() after
   * the request row itself is already locked/re-validated by the
   * caller; this only performs the propagation writes.
   */
  async applyApprovedRename(
    tx: Prisma.TransactionClient,
    canonicalProductId: string,
    nameAr: string,
    nameEn: string,
    actorId: string,
    correlationId: string,
  ): Promise<void> {
    const before = await tx.canonicalProduct.findUniqueOrThrow({
      where: { id: canonicalProductId },
    });
    await tx.canonicalProduct.update({
      where: { id: canonicalProductId },
      data: { canonicalNameAr: nameAr, canonicalNameEn: nameEn },
    });
    await this.auditLog.record(
      {
        actorId,
        correlationId,
        action: 'canonical_product.name_change_approved',
        entityType: 'CanonicalProduct',
        entityId: canonicalProductId,
        beforeState: {
          canonical_name_ar: before.canonicalNameAr,
          canonical_name_en: before.canonicalNameEn,
        },
        afterState: { canonical_name_ar: nameAr, canonical_name_en: nameEn },
      },
      tx,
    );

    // VendorOffer.canonicalProductId mirrors its confirmed variant's
    // canonical product (see that field's own schema comment) - a
    // direct, indexed filter, simpler than joining through variants.
    const matchedOffers = await tx.vendorOffer.findMany({
      where: { canonicalProductId },
    });
    for (const offer of matchedOffers) {
      if (offer.titleAr === nameAr && offer.titleEn === nameEn) {
        continue;
      }
      await tx.vendorOffer.update({
        where: { id: offer.id },
        data: { titleAr: nameAr, titleEn: nameEn },
      });
      await this.auditLog.record(
        {
          actorId,
          correlationId,
          action: 'vendor_offer.title_adopted_canonical_name',
          entityType: 'VendorOffer',
          entityId: offer.id,
          beforeState: { title_ar: offer.titleAr, title_en: offer.titleEn },
          afterState: { title_ar: nameAr, title_en: nameEn },
        },
        tx,
      );
    }
  }
}
