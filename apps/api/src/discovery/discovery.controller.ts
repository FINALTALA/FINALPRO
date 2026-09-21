import { Controller, Get, Query } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ComparisonCard, ComparisonService } from './comparison.service';
import { comparisonCardDto } from './dto/comparison-card.dto';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

// Sprint 8 (RB-STOREF-004, PDR-013/014): the public "All" discovery page
// - the only discovery surface this sprint builds (Women/Men/Kids/
// Accessories segment pages are RB-STOREF-004b, Should, deferred).
// Ordering is deliberately simple newest-first (canonicalProduct.
// createdAt desc, id desc as a final deterministic tiebreak for same-
// instant rows) - RB-COMP-002's 40/30/30 view/newness/rating ranking
// formula is Should, also deferred; this is the documented fallback the
// kickoff explicitly allows.
@Controller('discovery')
export class DiscoveryController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly comparison: ComparisonService,
  ) {}

  @Get('all')
  async listAll(
    @Query('page') pageRaw?: string,
    @Query('page_size') pageSizeRaw?: string,
  ) {
    const page = clampInt(pageRaw, 1, 1, 1_000_000);
    const pageSize = clampInt(pageSizeRaw, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);

    // "Eligible" here (has at least one CONFIRMED match to an ACTIVE
    // offer at a published, ACTIVE store) mirrors ComparisonService's
    // own eligibility predicate exactly - a canonical product with zero
    // eligible offers has nothing to compare and must never appear on
    // discovery. Never shows inactive offers or unavailable stores as
    // purchase options (RB-STOREF-004's own requirement) - this WHERE
    // clause is the enforcement point; buildCard() below never receives
    // a product that wouldn't already pass it.
    const where: Prisma.CanonicalProductWhereInput = {
      variants: {
        some: {
          confirmedOfferVariants: {
            some: {
              vendorOffer: { status: 'ACTIVE' },
              vendor: { storefrontPublished: true, status: 'ACTIVE' },
            },
          },
        },
      },
    };

    const [total, products] = await Promise.all([
      this.prisma.canonicalProduct.count({ where }),
      this.prisma.canonicalProduct.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const cards = await Promise.all(
      products.map(async (product) => {
        const eligible = await this.comparison.findEligibleOffers(product.id);
        return this.comparison.buildCard(product, eligible);
      }),
    );

    return {
      page,
      page_size: pageSize,
      total,
      items: cards
        .filter((c): c is ComparisonCard => c !== null)
        .map(comparisonCardDto),
    };
  }
}
