import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';

interface NewProductInput {
  brandId: string;
  categoryId: string;
  modelName: string;
}

/**
 * Sprint 17b (FR-MATCH-006/L-24): merge and split, both admin-picked-
 * survivor, zero manual mapping, all-or-nothing.
 *
 * Lock order (review-round-verified against the only two existing
 * write paths to canonicalVariantId/canonicalProductId -
 * MatchReviewController.decide() and
 * VendorOffersController.confirmMatch() - see each of those methods'
 * own comment, both citing CanonicalNamingService): CanonicalProduct ->
 * VendorOffer -> OfferVariant -> CanonicalProductVariant. Neither
 * existing path ever explicitly locks CanonicalProductVariant (only a
 * plain read), but both perform an OfferVariant UPDATE (an implicit
 * write-lock) only AFTER already holding the VendorOffer lock - so the
 * real, effective order already in production is CanonicalProduct ->
 * VendorOffer -> OfferVariant. This service's own additional
 * CanonicalProductVariant lock goes last, since nothing else ever locks
 * it at all. Every lock is acquired via a non-authoritative discovery
 * read first (which ids to lock), then re-validated fresh once every
 * lock is actually held - the same "non-authoritative pre-transaction
 * lookup... re-validated fresh under lock" pattern decide()/
 * confirmMatch() already use for their own single-product case.
 */
@Injectable()
export class CanonicalProductMergeService {
  constructor(private readonly auditLog: AuditLogService) {}

  async merge(
    tx: Prisma.TransactionClient,
    loserId: string,
    survivorId: string,
    actorId: string,
    correlationId: string,
  ): Promise<{
    survivorId: string;
    loserId: string;
    mergedVariantPairs: {
      loser_variant_id: string;
      survivor_variant_id: string;
    }[];
    repointedVendorOfferIds: string[];
  }> {
    if (loserId === survivorId) {
      throw new BadRequestException({
        code: 'MERGE_SAME_PRODUCT',
        message: 'A product cannot be merged into itself',
      });
    }

    // --- Discovery (non-authoritative) ---
    const [survivorPre, loserPre] = await Promise.all([
      tx.canonicalProduct.findUnique({ where: { id: survivorId } }),
      tx.canonicalProduct.findUnique({ where: { id: loserId } }),
    ]);
    if (!survivorPre || !loserPre) {
      throw new NotFoundException({
        code: 'CANONICAL_PRODUCT_NOT_FOUND',
        message: 'survivor or loser canonical product not found',
      });
    }
    const variantsPre = await tx.canonicalProductVariant.findMany({
      where: { canonicalProductId: { in: [survivorId, loserId] } },
    });
    const variantIdsPre = variantsPre.map((v) => v.id);
    const offerVariantsPre = await tx.offerVariant.findMany({
      where: { canonicalVariantId: { in: variantIdsPre } },
    });
    const vendorOfferIdsPre = [
      ...new Set(offerVariantsPre.map((ov) => ov.vendorOfferId)),
    ];

    // --- Lock, fixed order, discovery-derived id sets ---
    for (const id of [survivorId, loserId].sort()) {
      await tx.$queryRaw`SELECT id FROM canonical_products WHERE id = ${id} FOR UPDATE`;
    }
    for (const id of vendorOfferIdsPre.sort()) {
      await tx.$queryRaw`SELECT id FROM vendor_offers WHERE id = ${id} FOR UPDATE`;
    }
    for (const id of offerVariantsPre.map((ov) => ov.id).sort()) {
      await tx.$queryRaw`SELECT id FROM offer_variants WHERE id = ${id} FOR UPDATE`;
    }
    for (const id of variantIdsPre.sort()) {
      await tx.$queryRaw`SELECT id FROM canonical_product_variants WHERE id = ${id} FOR UPDATE`;
    }

    // --- Re-validate fresh, under lock ---
    const survivor = await tx.canonicalProduct.findUniqueOrThrow({
      where: { id: survivorId },
    });
    const loser = await tx.canonicalProduct.findUniqueOrThrow({
      where: { id: loserId },
    });
    if (survivor.status === 'MERGED') {
      throw new ConflictException({
        code: 'SURVIVOR_ALREADY_MERGED',
        message: 'The survivor product is itself already merged away',
      });
    }
    if (loser.status === 'MERGED') {
      throw new ConflictException({
        code: 'LOSER_ALREADY_MERGED',
        message: 'This product is already merged away',
      });
    }

    const loserVariants = await tx.canonicalProductVariant.findMany({
      where: { canonicalProductId: loserId },
    });

    // --- Deterministic 1:1 pairing - canonical JSONB equality done IN
    // POSTGRES, never JS deep-equal (key order/whitespace/number-
    // formatting fragility). ---
    const pairingRows = await tx.$queryRaw<
      { loser_variant_id: string; survivor_variant_id: string }[]
    >`
      SELECT lv.id AS loser_variant_id, sv.id AS survivor_variant_id
      FROM canonical_product_variants lv
      JOIN canonical_product_variants sv
        ON sv."canonicalProductId" = ${survivorId}
       AND sv."structuralAttributes" = lv."structuralAttributes"
      WHERE lv."canonicalProductId" = ${loserId}
    `;
    const matchesByLoserVariant = new Map<string, string[]>();
    for (const row of pairingRows) {
      const arr = matchesByLoserVariant.get(row.loser_variant_id) ?? [];
      arr.push(row.survivor_variant_id);
      matchesByLoserVariant.set(row.loser_variant_id, arr);
    }
    const unmatched: { loser_variant_id: string; match_count: number }[] = [];
    for (const lv of loserVariants) {
      const matches = matchesByLoserVariant.get(lv.id) ?? [];
      if (matches.length !== 1) {
        unmatched.push({
          loser_variant_id: lv.id,
          match_count: matches.length,
        });
      }
    }
    if (unmatched.length > 0) {
      // No writes at all above this point - safe to reject outright.
      throw new UnprocessableEntityException({
        code: 'MERGE_VARIANT_UNMATCHED',
        message:
          'Every loser variant must match exactly one survivor variant by structural attributes - this merge has unmatched or ambiguous variants',
        details: unmatched,
      });
    }

    // --- All-or-nothing writes ---
    const mergedVariantPairs: {
      loser_variant_id: string;
      survivor_variant_id: string;
    }[] = [];
    for (const [loserVariantId, matches] of matchesByLoserVariant) {
      const survivorVariantId = matches[0];
      await tx.canonicalProductVariant.update({
        where: { id: loserVariantId },
        data: { mergedIntoVariantId: survivorVariantId },
      });
      await tx.offerVariant.updateMany({
        where: { canonicalVariantId: loserVariantId },
        data: { canonicalVariantId: survivorVariantId },
      });
      mergedVariantPairs.push({
        loser_variant_id: loserVariantId,
        survivor_variant_id: survivorVariantId,
      });
    }
    await tx.canonicalProduct.update({
      where: { id: loserId },
      data: { status: 'MERGED', mergedIntoId: survivorId },
    });
    // Every vendor offer that touched either side now points entirely
    // at the survivor - safe unconditionally because of the
    // pre-existing "a VendorOffer's variants never span two different
    // canonical products" invariant (MATCH_CONFLICTS_WITH_OFFER,
    // enforced by decide()/confirmMatch()) - a vendor offer discovered
    // here was, before this merge, entirely on the loser, entirely on
    // the survivor (a no-op update), or had no canonical link at all
    // (not discovered here to begin with).
    for (const vendorOfferId of vendorOfferIdsPre) {
      await tx.vendorOffer.update({
        where: { id: vendorOfferId },
        data: { canonicalProductId: survivorId },
      });
    }

    await this.auditLog.record(
      {
        actorId,
        correlationId,
        action: 'canonical_product.merged',
        entityType: 'CanonicalProduct',
        entityId: loserId,
        beforeState: {
          loser_status: loser.status,
          loser_variant_count: loserVariants.length,
        },
        afterState: {
          survivor_id: survivorId,
          merged_variant_pairs: mergedVariantPairs,
          repointed_vendor_offer_ids: vendorOfferIdsPre,
        },
      },
      tx,
    );

    return {
      survivorId,
      loserId,
      mergedVariantPairs,
      repointedVendorOfferIds: vendorOfferIdsPre,
    };
  }

  async split(
    tx: Prisma.TransactionClient,
    sourceProductId: string,
    variantIds: string[],
    newProduct: NewProductInput,
    actorId: string,
    correlationId: string,
  ): Promise<{
    newProductId: string;
    movedVariantIds: string[];
    movedVendorOfferIds: string[];
  }> {
    if (variantIds.length === 0) {
      throw new BadRequestException({
        code: 'SPLIT_REQUIRES_AT_LEAST_ONE_VARIANT',
        message: 'Select at least one variant to split out',
      });
    }

    // --- Discovery ---
    const sourcePre = await tx.canonicalProduct.findUnique({
      where: { id: sourceProductId },
    });
    if (!sourcePre) {
      throw new NotFoundException({
        code: 'CANONICAL_PRODUCT_NOT_FOUND',
        message: 'Source canonical product not found',
      });
    }
    const allVariantsPre = await tx.canonicalProductVariant.findMany({
      where: { canonicalProductId: sourceProductId },
    });
    const allVariantIdsPre = new Set(allVariantsPre.map((v) => v.id));
    if (!variantIds.every((id) => allVariantIdsPre.has(id))) {
      throw new BadRequestException({
        code: 'SPLIT_VARIANT_NOT_IN_SOURCE',
        message: 'Every selected variant must belong to the source product',
      });
    }
    if (variantIds.length === allVariantIdsPre.size) {
      throw new BadRequestException({
        code: 'SPLIT_CANNOT_MOVE_ALL_VARIANTS',
        message:
          'A split must leave at least one variant behind - moving all of them is a rename, not a split',
      });
    }
    const affectedOfferVariantsPre = await tx.offerVariant.findMany({
      where: { canonicalVariantId: { in: [...allVariantIdsPre] } },
    });
    const affectedVendorOfferIdsPre = [
      ...new Set(affectedOfferVariantsPre.map((ov) => ov.vendorOfferId)),
    ];

    // --- Lock, fixed order ---
    await tx.$queryRaw`SELECT id FROM canonical_products WHERE id = ${sourceProductId} FOR UPDATE`;
    for (const id of affectedVendorOfferIdsPre.sort()) {
      await tx.$queryRaw`SELECT id FROM vendor_offers WHERE id = ${id} FOR UPDATE`;
    }
    for (const id of affectedOfferVariantsPre.map((ov) => ov.id).sort()) {
      await tx.$queryRaw`SELECT id FROM offer_variants WHERE id = ${id} FOR UPDATE`;
    }
    for (const id of [...allVariantIdsPre].sort()) {
      await tx.$queryRaw`SELECT id FROM canonical_product_variants WHERE id = ${id} FOR UPDATE`;
    }

    // --- Re-validate fresh, under lock ---
    const source = await tx.canonicalProduct.findUniqueOrThrow({
      where: { id: sourceProductId },
    });
    if (source.status === 'MERGED') {
      throw new ConflictException({
        code: 'SOURCE_ALREADY_MERGED',
        message: 'This product is already merged away and cannot be split',
      });
    }
    const allVariantsFresh = await tx.canonicalProductVariant.findMany({
      where: { canonicalProductId: sourceProductId },
    });
    const allVariantIdsFresh = new Set(allVariantsFresh.map((v) => v.id));
    if (!variantIds.every((id) => allVariantIdsFresh.has(id))) {
      throw new ConflictException({
        code: 'SPLIT_VARIANT_STATE_CHANGED',
        message:
          'One or more selected variants changed state (e.g. moved by a concurrent merge) - re-fetch and retry',
      });
    }

    // --- Review-round fix: re-run the span check under lock, against
    // freshly-read data, not the pre-lock discovery read. ---
    const selectedSet = new Set(variantIds);
    const affectedOfferVariantsFresh = await tx.offerVariant.findMany({
      where: { canonicalVariantId: { in: [...allVariantIdsFresh] } },
    });
    const bucketsByVendorOffer = new Map<string, Set<'moving' | 'staying'>>();
    for (const ov of affectedOfferVariantsFresh) {
      if (!ov.canonicalVariantId) continue;
      const bucket = selectedSet.has(ov.canonicalVariantId)
        ? 'moving'
        : 'staying';
      const set = bucketsByVendorOffer.get(ov.vendorOfferId) ?? new Set();
      set.add(bucket);
      bucketsByVendorOffer.set(ov.vendorOfferId, set);
    }
    const spanningVendorOfferIds = [...bucketsByVendorOffer.entries()]
      .filter(([, set]) => set.size > 1)
      .map(([id]) => id);
    if (spanningVendorOfferIds.length > 0) {
      // No writes at all above this point - safe to reject outright.
      throw new UnprocessableEntityException({
        code: 'SPLIT_WOULD_SPAN_VENDOR_OFFER',
        message:
          'This split would leave a VendorOffer with variants split across two canonical products - not supported this sprint',
        details: spanningVendorOfferIds.map((id) => ({
          vendor_offer_id: id,
        })),
      });
    }

    // --- All-or-nothing writes ---
    const created = await tx.canonicalProduct.create({
      data: {
        brandId: newProduct.brandId,
        categoryId: newProduct.categoryId,
        modelName: newProduct.modelName,
        status: 'DRAFT',
      },
    });
    await tx.canonicalProductVariant.updateMany({
      where: { id: { in: variantIds } },
      data: { canonicalProductId: created.id },
    });
    const movingVendorOfferIds = [...bucketsByVendorOffer.entries()]
      .filter(([, set]) => set.has('moving'))
      .map(([id]) => id);
    for (const vendorOfferId of movingVendorOfferIds) {
      await tx.vendorOffer.update({
        where: { id: vendorOfferId },
        data: { canonicalProductId: created.id },
      });
    }

    await this.auditLog.record(
      {
        actorId,
        correlationId,
        action: 'canonical_product.split',
        entityType: 'CanonicalProduct',
        entityId: sourceProductId,
        beforeState: { source_variant_count: allVariantsFresh.length },
        afterState: {
          new_product_id: created.id,
          moved_variant_ids: variantIds,
          moved_vendor_offer_ids: movingVendorOfferIds,
        },
      },
      tx,
    );

    return {
      newProductId: created.id,
      movedVariantIds: variantIds,
      movedVendorOfferIds: movingVendorOfferIds,
    };
  }
}
