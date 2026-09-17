import { Injectable } from '@nestjs/common';
import { OfferIdentifierType, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AutoLinkResult {
  canonicalVariantId: string | null;
  canonicalProductId: string | null;
}

/**
 * BR-001 / FR-MATCH-002: an exact product identifier match between a
 * vendor offer and an existing `CanonicalProductVariant` auto-links the
 * offer with no human review; any other match requires human approval
 * (that review-queue path - BL-MATCH-003 - is Sprint 4 scope, not built
 * here; a non-exact-match offer variant simply stays unmatched).
 *
 * GTIN/EAN/UPC/ISBN are treated as the same "global barcode" lookup,
 * checked against `CanonicalProductVariant.gtin` (which carries a
 * global unique constraint - see its schema comment). MPN is checked
 * against `.mpn`, which is only unique *within* a canonical product
 * (Part 3) - a bare MPN could in principle collide across unrelated
 * products, so an MPN lookup that returns more than one row is treated
 * as ambiguous and deliberately left unmatched, not auto-linked to an
 * arbitrary candidate: BR-001's auto-link path is only for identifiers
 * that unambiguously identify one variant.
 */
@Injectable()
export class MatchingService {
  constructor(private readonly prisma: PrismaService) {}

  async findExactMatch(
    identifierType: OfferIdentifierType,
    identifierValue: string,
    tx?: Prisma.TransactionClient,
  ): Promise<AutoLinkResult> {
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
