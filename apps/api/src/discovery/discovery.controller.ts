import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { Prisma, StoreApplicableCategory } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ComparisonService, eligibleProductWhere } from './comparison.service';
import { comparisonCardDto } from './dto/comparison-card.dto';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const MAX_QUERY_LENGTH = 80;

const SEGMENTS: Record<string, StoreApplicableCategory> = {
  women: 'WOMEN',
  men: 'MEN',
  kids: 'KIDS',
  accessories: 'ACCESSORIES',
};

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

function parseSegment(raw: string | undefined): StoreApplicableCategory | null {
  if (raw === undefined || raw === '' || raw === 'all') return null;
  const segment = SEGMENTS[raw.toLowerCase()];
  if (!segment) {
    throw new BadRequestException({
      code: 'INVALID_SEGMENT',
      message: 'segment must be one of women, men, kids, accessories',
    });
  }
  return segment;
}

function parseQuery(raw: string | undefined): string | null {
  const trimmed = raw?.trim().slice(0, MAX_QUERY_LENGTH);
  return trimmed ? trimmed : null;
}

// Sprint 8 (RB-STOREF-004, PDR-013/014): public discovery. Sprint 13
// adds two read-only narrowing filters on the same eligible-product
// rule (never a second competing definition of "eligible"):
//  - `segment` (women|men|kids|accessories): only products with an
//    eligible offer from a store that declared that applicable category
//    (PDR-013: stores choose their types; the All page mixes them).
//  - `q`: case-insensitive match on the canonical name (AR/EN), model,
//    brand or category name.
// Ordering stays newest-first (RB-COMP-002's ranking is still deferred).
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
    @Query('segment') segmentRaw?: string,
    @Query('q') qRaw?: string,
  ) {
    const page = clampInt(pageRaw, 1, 1, 1_000_000);
    const pageSize = clampInt(pageSizeRaw, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const segment = parseSegment(segmentRaw);
    const q = parseQuery(qRaw);

    const base = eligibleProductWhere(
      segment ? { applicableCategories: { some: { category: segment } } } : {},
    );
    const where: Prisma.CanonicalProductWhereInput = q
      ? {
          AND: [
            base,
            {
              OR: [
                { canonicalNameAr: { contains: q, mode: 'insensitive' } },
                { canonicalNameEn: { contains: q, mode: 'insensitive' } },
                { modelName: { contains: q, mode: 'insensitive' } },
                { brand: { name: { contains: q, mode: 'insensitive' } } },
                { category: { nameAr: { contains: q, mode: 'insensitive' } } },
                { category: { nameEn: { contains: q, mode: 'insensitive' } } },
              ],
            },
          ],
        }
      : base;

    const { total, cards } = await this.comparison.listCards(
      where,
      page,
      pageSize,
    );

    return {
      page,
      page_size: pageSize,
      total,
      items: cards.map(comparisonCardDto),
    };
  }

  // Sprint 13: public store search/listing - identity fields only, and
  // only stores that are published AND ACTIVE (an unavailable store is
  // still reachable by its own URL, but is never surfaced by discovery).
  @Get('stores')
  async listStores(
    @Query('segment') segmentRaw?: string,
    @Query('q') qRaw?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const segment = parseSegment(segmentRaw);
    const q = parseQuery(qRaw);
    const limit = clampInt(limitRaw, 24, 1, 50);

    const stores = await this.prisma.vendor.findMany({
      where: {
        storefrontPublished: true,
        status: 'ACTIVE',
        ...(segment
          ? { applicableCategories: { some: { category: segment } } }
          : {}),
        ...(q
          ? {
              OR: [
                { displayName: { contains: q, mode: 'insensitive' } },
                { legalName: { contains: q, mode: 'insensitive' } },
                { bio: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: {
        slug: true,
        displayName: true,
        legalName: true,
        logoUrl: true,
        bio: true,
      },
    });

    return {
      items: stores.map((s) => ({
        slug: s.slug,
        display_name: s.displayName ?? s.legalName,
        logo_url: s.logoUrl,
        bio: s.bio,
      })),
    };
  }
}
