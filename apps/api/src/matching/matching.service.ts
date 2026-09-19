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
 * Sprint 3 remediation (PDR-012, S3-B03): even an exact identifier
 * match is only ever a *proposal* now, never an immediate link with no
 * human review - "the vendor must explicitly confirm a proposed match...
 * Exact identifier matches can be proposed automatically" (approved-
 * product-decisions-2026-09.md). This method still only *finds* the
 * candidate; VendorOffersController.createVariant() stores it as a
 * pending proposal, and confirmMatch() is the only place that ever
 * turns it into a real `canonicalVariantId` link, on the store owner's
 * explicit decision. A non-exact-match offer variant simply stays
 * unmatched (that review-queue path for ambiguous/non-exact matches -
 * BL-MATCH-003 - remains Sprint 4 scope, not built here).
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
}
