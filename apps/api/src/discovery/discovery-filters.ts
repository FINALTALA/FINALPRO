import { normalizeColorName } from '../offers/color-name';
import { BadRequestException } from '@nestjs/common';
import {
  Prisma,
  ProductAudience,
  ProductSeason,
} from '../../generated/prisma/client';
import { FulfilmentEligibilityService } from '../fulfilment/fulfilment-eligibility.service';
import { PrismaService } from '../prisma/prisma.service';
import { TaxonomyFilterCodes } from '../taxonomy/taxonomy.service';
import { PUBLIC_OFFER } from '../offers/platform-hold.util';

// The query parsing and product filters shared by public discovery
// (/discovery/all) and the signed-in following feed
// (/customers/me/following/feed) - one definition, so the two listings
// can never disagree on what a filter means.

export const MAX_QUERY_LENGTH = 80;

export function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function parseEnum<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  name: string,
): T | null {
  if (raw === undefined || raw === '') return null;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new BadRequestException({
    code: `INVALID_${name.toUpperCase()}`,
    message: `${name} must be one of ${allowed.join(', ')}`,
  });
}

export function parsePrice(
  raw: string | undefined,
  name: string,
): number | null {
  if (raw === undefined || raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new BadRequestException({
      code: 'INVALID_PRICE_FILTER',
      message: `${name} must be a non-negative number`,
    });
  }
  return value;
}

export function parseBoolean(raw: string | undefined, name: string): boolean {
  if (raw === undefined || raw === '' || raw === 'false' || raw === '0') {
    return false;
  }
  if (raw === 'true' || raw === '1') return true;
  throw new BadRequestException({
    code: `INVALID_${name.toUpperCase()}`,
    message: `${name} must be true or false`,
  });
}

export function parseQuery(raw: string | undefined): string | null {
  const trimmed = raw?.trim().slice(0, MAX_QUERY_LENGTH);
  return trimmed ? trimmed : null;
}

/** `q`: case-insensitive match on the canonical name (AR/EN), model,
 * brand or category name. */
export function textMatch(q: string): Prisma.CanonicalProductWhereInput {
  return {
    OR: [
      { canonicalNameAr: { contains: q, mode: 'insensitive' } },
      { canonicalNameEn: { contains: q, mode: 'insensitive' } },
      { modelName: { contains: q, mode: 'insensitive' } },
      { brand: { name: { contains: q, mode: 'insensitive' } } },
      { category: { nameAr: { contains: q, mode: 'insensitive' } } },
      { category: { nameEn: { contains: q, mode: 'insensitive' } } },
      // Product colours: a store's own colour name (e.g. «موكا»), also
      // normalised, on a confirmed, published offer version.
      {
        variants: {
          some: {
            confirmedOfferVariants: {
              some: {
                vendorOffer: PUBLIC_OFFER,
                offerColor: {
                  OR: [
                    { nameAr: { contains: q, mode: 'insensitive' } },
                    { nameEn: { contains: q, mode: 'insensitive' } },
                    { nameKey: { contains: normalizeColorName(q) } },
                  ],
                },
              },
            },
          },
        },
      },
    ],
  };
}

/** The confirmed offer variant a taxonomy filter must hold for. */
export async function taxonomyOfferFilter(
  prisma: PrismaService,
  /** PD-2: "in stock" = the shared sellable-branch availability. */
  fulfilment: FulfilmentEligibilityService,
  f: TaxonomyFilterCodes,
  vendorFilter: Prisma.VendorWhereInput,
): Promise<Prisma.OfferVariantWhereInput> {
  const has = (x: Set<string>) => x.size > 0;
  if (![f.audiences, f.categories, f.seasons, f.colors, f.sizes].some(has)) {
    return {};
  }
  const offer: Prisma.OfferVariantWhereInput = {
    vendorOffer: {
      taxonomyVersion: { not: null },
      ...(has(f.audiences)
        ? {
            audiences: {
              some: {
                audience: { in: [...f.audiences] as ProductAudience[] },
              },
            },
          }
        : {}),
      ...(has(f.categories)
        ? {
            categories: { some: { categoryCode: { in: [...f.categories] } } },
          }
        : {}),
      ...(has(f.seasons)
        ? { season: { in: [...f.seasons] as ProductSeason[] } }
        : {}),
    },
  };
  if (!has(f.colors) && !has(f.sizes)) return offer;

  const candidates = await prisma.offerVariant.findMany({
    where: {
      AND: [
        offer,
        {
          isCombination: true,
          canonicalVariantId: { not: null },
          vendorOffer: PUBLIC_OFFER,
          vendor: {
            AND: [
              { storefrontPublished: true, status: 'ACTIVE' },
              vendorFilter,
            ],
          },
          ...(has(f.colors) ? { colorCode: { in: [...f.colors] } } : {}),
          ...(has(f.sizes) ? { sizeCode: { in: [...f.sizes] } } : {}),
        },
      ],
    },
    select: { id: true, vendorId: true },
  });
  const available = await fulfilment.availableByVariant(candidates);
  const inStock = candidates
    .filter((v) => (available.get(v.id)?.total ?? 0) > 0)
    .map((v) => v.id);
  return { id: { in: inStock } };
}
