import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ClothingCategoryTemplate,
  Prisma,
  VendorOffer,
} from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import {
  liveReservedQuantityByKey,
  totalAvailableStockLive,
} from '../common/availability.util';
import { OutboxEventService } from '../outbox/outbox-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { SizeGuidesService } from '../size-guides/size-guides.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { validateTemplateAttributes } from './catalog/clothing-category-templates';

type Db = PrismaService | Prisma.TransactionClient;

export interface OfferPublishProblems {
  /** Fixed codes: title, brand, brand_pending, template_attributes, primary_image, available_stock, size_guide. */
  missing: string[];
  /** Sizes a category guide applies to but does not describe (with size_guide). */
  sizesNotInGuide: string[];
}

/**
 * Phase A+: the ONE judgement of whether an offer can be published, and the
 * one way an offer becomes ACTIVE. Used by the status change (PATCH
 * .../status), by publishing from the product-entry wizard (inside its
 * creating transaction) and, read-only, by the product page's publish check.
 *
 * `problems()` never writes anything - no audit, no notification, no
 * counter. Inside the publishing transaction it is called with
 * `lock: true`, which takes the same FOR SHARE locks on branch_stock as
 * before (the Sprint 17 race-free availability read); the read-only check
 * takes none.
 */
@Injectable()
export class OfferPublishService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly outbox: OutboxEventService,
    private readonly sizeGuides: SizeGuidesService,
    private readonly featureFlags: FeatureFlagsService,
  ) {}

  async problems(
    db: Db,
    vendorId: string,
    offer: {
      id: string;
      titleAr: string;
      brandId: string | null;
      categoryTemplate: string | null;
      templateAttributes: Prisma.JsonValue | null;
    },
    opts: { lock: boolean },
  ): Promise<OfferPublishProblems> {
    const missing: string[] = [];

    // One required title (the Arabic one); the English name is optional.
    if (!offer.titleAr.trim()) missing.push('title');
    if (!offer.brandId) {
      // A brand the seller asked for that is still under review is named
      // as such (the product cannot be published until it is approved).
      const pending = await db.brandRequest.count({
        where: { offerId: offer.id, status: 'PENDING' },
      });
      missing.push(pending > 0 ? 'brand_pending' : 'brand');
    }
    if (offer.categoryTemplate) {
      const problems = validateTemplateAttributes(
        offer.categoryTemplate as ClothingCategoryTemplate,
        offer.templateAttributes,
      );
      if (problems.length > 0) missing.push('template_attributes');
    }

    const variants = await db.offerVariant.findMany({
      where: { vendorOfferId: offer.id },
      select: { id: true },
    });
    if (variants.length === 0) {
      missing.push('primary_image', 'available_stock');
    } else {
      const variantIds = variants.map((v) => v.id);
      const primaryImage = await db.offerVariantMedia.findFirst({
        where: {
          offerVariantId: { in: variantIds },
          kind: 'PRIMARY',
          mediaType: 'IMAGE',
        },
        select: { id: true },
      });
      if (!primaryImage) missing.push('primary_image');

      // Sprint 17: when publishing, every relevant branch_stock row is
      // locked FOR SHARE in the canonical stockLockKey order BEFORE live
      // availability is read, so a concurrent reserve()/POS movement is
      // either fully before or fully after this read.
      const stocks = await db.branchStock.findMany({
        where: { vendorId, offerVariantId: { in: variantIds } },
        select: { branchId: true, offerVariantId: true, quantity: true },
      });
      const sortedStocks = [...stocks].sort((a, b) => {
        const ka = `${vendorId}:${a.branchId}:${a.offerVariantId}`;
        const kb = `${vendorId}:${b.branchId}:${b.offerVariantId}`;
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
      if (opts.lock) {
        for (const s of sortedStocks) {
          await db.$queryRaw`SELECT id FROM branch_stock WHERE "vendorId" = ${vendorId} AND "branchId" = ${s.branchId} AND "offerVariantId" = ${s.offerVariantId} FOR SHARE`;
        }
      }
      const liveReserved = await liveReservedQuantityByKey(
        db as Prisma.TransactionClient,
        sortedStocks,
      );
      if (totalAvailableStockLive(sortedStocks, liveReserved) <= 0)
        missing.push('available_stock');
    }

    // Barcodes and in-store sales (2026-11-20): while the store's barcodes are
    // on, a product is published - or an INACTIVE one put back - only with a
    // store barcode. An older product already ACTIVE stays online; it simply
    // cannot be sold at the cashier until it has one. Never generated silently.
    if (
      (await this.featureFlags.isEnabled('store_cashier_enabled')) &&
      (await db.offerBarcode.count({ where: { vendorOfferId: offer.id } })) ===
        0
    )
      missing.push('barcode');

    // PD-4 (decision 4): only when a published guide applies; the offer's
    // own measurements (phase A+) never hold it back.
    const sizeGuide = await this.sizeGuides.compatibilityForOffer(offer.id, db);
    if (sizeGuide.mismatched.length > 0) missing.push('size_guide');

    return { missing, sizesNotInGuide: sizeGuide.mismatched };
  }

  /** The offer's problems for its owner (read-only; no locks, no writes). */
  async check(vendorId: string, offerId: string) {
    const offer = await this.prisma.vendorOffer.findUnique({
      where: { id: offerId },
    });
    if (!offer || offer.vendorId !== vendorId) {
      throw new NotFoundException({
        code: 'VENDOR_OFFER_NOT_FOUND',
        message: 'Offer not found',
      });
    }
    const p = await this.problems(this.prisma, vendorId, offer, {
      lock: false,
    });
    return {
      offer_id: offerId,
      status: offer.status,
      ready: p.missing.length === 0,
      missing: p.missing,
      sizes_not_in_guide: p.sizesNotInGuide,
    };
  }

  /** Throws OFFER_NOT_PUBLISHABLE with the problems (inside the publishing transaction). */
  async assertPublishable(
    tx: Prisma.TransactionClient,
    vendorId: string,
    offer: Parameters<OfferPublishService['problems']>[2],
  ): Promise<void> {
    const p = await this.problems(tx, vendorId, offer, { lock: true });
    if (p.missing.length > 0) {
      const sizeNote = p.sizesNotInGuide.length
        ? ` (sizes not in the size guide: ${p.sizesNotInGuide.join(', ')})`
        : '';
      // HttpExceptionFilter forwards only code/message/details - the list
      // travels in `details`, like CHECKOUT_PRICE_CHANGED.
      throw new BadRequestException({
        code: 'OFFER_NOT_PUBLISHABLE',
        message: `This offer cannot be published yet: ${p.missing.join(', ')}${sizeNote}`,
        details: p.missing,
      });
    }
  }

  /**
   * Makes the (already locked) offer ACTIVE: the gate first, then the
   * status, firstPublishedAt on the very first publish, the audit row and
   * - only on that first publish - the followers' notification. The caller
   * holds the offer row FOR UPDATE in `tx`.
   */
  async activate(
    tx: Prisma.TransactionClient,
    actorId: string,
    correlationId: string,
    vendorId: string,
    offer: VendorOffer,
    /** Bulk publishing: false - the run sends ONE summary to the followers instead. */
    opts: { notifyFollowers?: boolean } = {},
  ): Promise<VendorOffer> {
    await this.assertPublishable(tx, vendorId, offer);
    const isFirstPublish = offer.firstPublishedAt === null;
    const updated = await tx.vendorOffer.update({
      where: { id: offer.id },
      data: {
        status: 'ACTIVE',
        ...(isFirstPublish ? { firstPublishedAt: new Date() } : {}),
      },
    });
    await this.auditLog.record(
      {
        actorId,
        correlationId,
        action: 'vendor_offer.status_updated',
        entityType: 'VendorOffer',
        entityId: offer.id,
        beforeState: { status: offer.status },
        afterState: { status: updated.status },
      },
      tx,
    );
    if (isFirstPublish && opts.notifyFollowers !== false) {
      await this.enqueueFollowerNotification(
        tx,
        'offer.published_for_followers',
        vendorId,
        { offer_id: offer.id },
      );
    }
    return updated;
  }

  // Sprint 19 (FR-FAV-005 E.0, review-round): one OutboxEvent + its
  // StoreFollow snapshot, atomically, in the SAME transaction as the
  // real change it announces - never a per-follower enqueue loop.
  // `payload` shape must match OutboxRelayService's/
  // DiscountActivationSweepService's expectations for the eventType
  // (see FOLLOWER_EVENT_TYPE_MAP there).
  async enqueueFollowerNotification(
    tx: Prisma.TransactionClient,
    eventType:
      | 'offer.published_for_followers'
      | 'offer.discount_activated_for_followers'
      | 'offer.bulk_published_for_followers',
    vendorId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const outboxEvent = await this.outbox.enqueue(
      {
        eventType,
        audience: 'CUSTOMER',
        payload: { vendor_id: vendorId, ...payload },
      },
      tx,
    );
    await tx.$executeRaw`
      INSERT INTO outbox_delivery_targets (id, "outboxEventId", "recipientUserId")
      SELECT gen_random_uuid()::text, ${outboxEvent.id}, "userId"
      FROM store_follows WHERE "vendorId" = ${vendorId}
    `;
  }
}
