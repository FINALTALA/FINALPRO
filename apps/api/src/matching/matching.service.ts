import { Injectable } from '@nestjs/common';
import { OfferIdentifierType, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface MatchCandidateResult {
  canonicalVariantId: string | null;
  canonicalProductId: string | null;
}

/**
 * BR-001 / FR-MATCH-002: finds the unambiguous `CanonicalProductVariant`
 * an exact product identifier match on a vendor offer would link to.
 *
 * Sprint 3 remediation (FR-MATCH-012, S3-B03): even an exact identifier
 * match is only ever a *proposal* now, never an immediate link with no
 * human review - "the vendor must explicitly confirm a proposed match...
 * Exact identifier matches can be proposed automatically" (approved-
 * product-decisions-2026-09.md, Sec 3.2 - not PDR-012, which is
 * unrelated/covers store sections). This method still only *finds* the
 * candidate; VendorOffersController.createVariant() stores it as a
 * pending proposal, and confirmMatch() is the only place that ever
 * turns it into a real `canonicalVariantId` link, on the store owner's
 * explicit decision. A non-exact-match offer variant simply stays
 * unmatched until/unless the owner acts on a candidate from
 * searchNonExactCandidates() below (RB-MATCH-002, Sprint 6) - a
 * genuinely separate mechanism, not a replacement for this one.
 *
 * GTIN/EAN/UPC/ISBN are treated as the same "global barcode" lookup,
 * checked against `CanonicalProductVariant.gtin` (which carries a
 * global unique constraint - see its schema comment). MPN is checked
 * against `.mpn`, which is only unique *within* a canonical product
 * (Part 3) - a bare MPN could in principle collide across unrelated
 * products, so an MPN lookup that returns more than one row is treated
 * as ambiguous and deliberately left unproposed, not surfaced as a
 * candidate: only an identifier that unambiguously identifies one
 * variant is ever proposed at all.
 */
@Injectable()
export class MatchingService {
  constructor(private readonly prisma: PrismaService) {}

  async findExactMatch(
    identifierType: OfferIdentifierType,
    identifierValue: string,
    tx?: Prisma.TransactionClient,
  ): Promise<MatchCandidateResult> {
    const client = tx ?? this.prisma;

    if (identifierType === OfferIdentifierType.MPN) {
      const candidates = await client.canonicalProductVariant.findMany({
        where: { mpn: identifierValue },
        select: { id: true, canonicalProductId: true },
        take: 2,
      });
      if (candidates.length !== 1) {
        return { canonicalVariantId: null, canonicalProductId: null };
      }
      return {
        canonicalVariantId: candidates[0].id,
        canonicalProductId: candidates[0].canonicalProductId,
      };
    }

    // GTIN/EAN/UPC/ISBN share the globally-unique gtin lookup.
    const variant = await client.canonicalProductVariant.findUnique({
      where: { gtin: identifierValue },
      select: { id: true, canonicalProductId: true },
    });
    if (!variant) {
      return { canonicalVariantId: null, canonicalProductId: null };
    }
    return {
      canonicalVariantId: variant.id,
      canonicalProductId: variant.canonicalProductId,
    };
  }

  // ---------------------------------------------------------------
  // Sprint 6 (RB-MATCH-002): non-exact match review queue - ranks
  // CanonicalProductVariant candidates for an OfferVariant that has no
  // exact-identifier match, using structured-attribute + text-
  // similarity signals only (no image-similarity - RB-MATCH-002b,
  // Should, not this sprint).
  // ---------------------------------------------------------------

  private static readonly CANDIDATE_SCORE_THRESHOLD = 0.15;
  private static readonly MAX_CANDIDATES = 10;

  private normalizeTokens(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 0),
    );
  }

  /** Token-set Jaccard similarity - |A∩B| / |A∪B|, deterministic, no
   * external library. 0 when either side has no tokens at all. */
  private textSimilarity(a: string, b: string): number {
    const tokensA = this.normalizeTokens(a);
    const tokensB = this.normalizeTokens(b);
    if (tokensA.size === 0 || tokensB.size === 0) {
      return 0;
    }
    let intersection = 0;
    for (const t of tokensA) {
      if (tokensB.has(t)) {
        intersection += 1;
      }
    }
    const union = tokensA.size + tokensB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  /** Fraction of the canonical variant's own structuralAttributes
   * values (flattened to strings) that appear as a substring somewhere
   * in the offer's free text - a deliberately simple, deterministic
   * stand-in for the per-offer structured-attribute schema this
   * codebase does not have yet (BL-CAT-004, deferred - see
   * OfferVariant's own specsText comment). 0 when there are no
   * attributes to check at all, not 1 - an empty attribute set is not
   * evidence of a match. */
  private structuredAttributeOverlap(
    structuralAttributes: unknown,
    offerText: string,
  ): number {
    if (
      typeof structuralAttributes !== 'object' ||
      structuralAttributes === null
    ) {
      return 0;
    }
    const values = Object.values(
      structuralAttributes as Record<string, unknown>,
    )
      .filter((v) => v !== null && v !== undefined)
      .map((v) => String(v).toLowerCase().trim())
      .filter((v) => v.length > 0);
    if (values.length === 0) {
      return 0;
    }
    const haystack = offerText.toLowerCase();
    const found = values.filter((v) => haystack.includes(v)).length;
    return found / values.length;
  }

  /**
   * Computes and persists ranked MatchReviewCandidate rows for one
   * OfferVariant. Deterministic score = 0.5 * text-similarity (offer
   * title/specs vs. brand name + canonical model name) + 0.5 *
   * structured-attribute overlap (see the two private helpers above for
   * the exact formulas) - documented here, not a black box, the same
   * "deterministic and documented" bar PDR-014 sets for the (unrelated)
   * storefront ranking. Only candidates scoring above
   * CANDIDATE_SCORE_THRESHOLD are kept, capped at MAX_CANDIDATES,
   * ranked highest first.
   *
   * "Request re-search" (RB-MATCH-002) is just calling this again - a
   * re-run recomputes and upserts, refreshing any existing PENDING
   * row's score rather than creating a duplicate (the model's own
   * @@unique([offerVariantId, canonicalVariantId]) backs this). A
   * candidate the owner already APPROVED or REJECTED is left alone,
   * never silently reset back to PENDING by a later re-search.
   */
  async searchNonExactCandidates(
    vendorId: string,
    offerVariantId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = tx ?? this.prisma;

    const variant = await client.offerVariant.findUniqueOrThrow({
      where: { id: offerVariantId },
      include: { vendorOffer: true },
    });
    const offerText = [
      variant.vendorOffer.titleAr,
      variant.vendorOffer.titleEn,
      variant.specsTextAr ?? '',
      variant.specsTextEn ?? '',
    ].join(' ');

    const canonicalVariants = await client.canonicalProductVariant.findMany({
      include: { canonicalProduct: { include: { brand: true } } },
    });

    const scored = canonicalVariants
      .map((cv) => {
        const canonicalText = `${cv.canonicalProduct.brand.name} ${cv.canonicalProduct.modelName}`;
        const score =
          0.5 * this.textSimilarity(offerText, canonicalText) +
          0.5 *
            this.structuredAttributeOverlap(cv.structuralAttributes, offerText);
        return { canonicalVariantId: cv.id, score };
      })
      .filter((c) => c.score > MatchingService.CANDIDATE_SCORE_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, MatchingService.MAX_CANDIDATES);

    const results = [];
    for (const candidate of scored) {
      const key = {
        offerVariantId_canonicalVariantId: {
          offerVariantId,
          canonicalVariantId: candidate.canonicalVariantId,
        },
      };
      // Prisma's upsert() would run its `update` clause unconditionally
      // on any existing row, APPROVED/REJECTED included - checked
      // explicitly first so a re-search can never resurrect or
      // re-score a candidate the owner already decided on.
      const existing = await client.matchReviewCandidate.findUnique({
        where: key,
      });
      if (existing && existing.status !== 'PENDING') {
        continue;
      }
      const row = await client.matchReviewCandidate.upsert({
        where: key,
        update: { score: candidate.score },
        create: {
          vendorId,
          offerVariantId,
          canonicalVariantId: candidate.canonicalVariantId,
          score: candidate.score,
        },
      });
      results.push(row);
    }
    return results.sort((a, b) => b.score - a.score);
  }
}
