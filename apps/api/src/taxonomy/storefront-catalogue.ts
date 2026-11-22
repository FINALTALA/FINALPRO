import { Prisma, ProductAudience } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AUDIENCES, TaxonomySnapshot } from './taxonomy.service';

// The public storefront's catalogue structure: which main departments a
// store offers (its WOMEN/MEN/KIDS rows in vendor_applicable_categories -
// the same store types discovery's `segment` already uses) and which
// detailed taxonomy categories it offers under each (storefront_categories,
// FK-bound to the taxonomy's category/audience links).

export const DEPARTMENTS: ProductAudience[] = ['WOMEN', 'MEN', 'KIDS'];

export async function storeDepartments(
  db: PrismaService | Prisma.TransactionClient,
  vendorId: string,
  t: TaxonomySnapshot,
) {
  const [types, categories] = await Promise.all([
    db.vendorApplicableCategory.findMany({
      where: { vendorId, category: { in: DEPARTMENTS } },
      select: { category: true },
    }),
    db.storefrontCategory.findMany({
      where: { vendorId },
      orderBy: [{ sortOrder: 'asc' }, { categoryCode: 'asc' }],
      select: { audience: true, categoryCode: true },
    }),
  ]);
  const offered = new Set(types.map((r) => r.category as string));
  const names = new Map(t.categories.map((c) => [c.code, c]));
  return AUDIENCES.filter((a) => offered.has(a.code)).map((a) => ({
    audience: a.code,
    name_ar: a.nameAr,
    name_en: a.nameEn,
    categories: categories
      .filter((c) => c.audience === a.code)
      .map((c) => ({
        code: c.categoryCode,
        name_ar: names.get(c.categoryCode)?.nameAr ?? c.categoryCode,
        name_en: names.get(c.categoryCode)?.nameEn ?? c.categoryCode,
      })),
  }));
}

/**
 * «الترند» - a deterministic, store-scoped signal from data the platform
 * already records, over the last TRENDING_WINDOW_DAYS:
 *   score = 3 x units sold (branch order items not cancelled, in orders
 *               not CANCELLED/REFUNDED)
 *         + 1 x times added to customers' favourites (OFFER favourites)
 * A product is trending when its score is > 0; trending order is score
 * desc, then newest. Only this store's own orders and favourites count.
 */
export const TRENDING_WINDOW_DAYS = 30;
export const TREND_WEIGHT_SOLD = 3;
export const TREND_WEIGHT_FAVORITE = 1;

export async function trendScores(
  db: PrismaService,
  vendorId: string,
  now = new Date(),
): Promise<Map<string, number>> {
  const since = new Date(
    now.getTime() - TRENDING_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const rows = await db.$queryRaw<{ offer_id: string; score: number }[]>`
    WITH sold AS (
      SELECT ov."vendorOfferId" AS offer_id, SUM(boi.quantity)::float8 AS units
      FROM branch_order_items boi
      JOIN branch_orders bo ON bo.id = boi."branchOrderId"
      JOIN offer_variants ov ON ov.id = boi."offerVariantId"
      WHERE boi."vendorId" = ${vendorId}
        AND boi."cancelledAt" IS NULL
        AND boi."createdAt" >= ${since}
        AND bo.status NOT IN ('CANCELLED', 'REFUNDED')
      GROUP BY 1
    ),
    fav AS (
      SELECT ov."vendorOfferId" AS offer_id, COUNT(*)::float8 AS times
      FROM favorites f
      JOIN offer_variants ov ON ov.id = f."offerVariantId"
      WHERE ov."vendorId" = ${vendorId}
        AND f."createdAt" >= ${since}
      GROUP BY 1
    )
    SELECT COALESCE(s.offer_id, f.offer_id) AS offer_id,
           (${TREND_WEIGHT_SOLD} * COALESCE(s.units, 0) + ${TREND_WEIGHT_FAVORITE} * COALESCE(f.times, 0))::float8 AS score
    FROM sold s FULL OUTER JOIN fav f ON f.offer_id = s.offer_id
  `;
  return new Map(rows.map((r) => [r.offer_id, Number(r.score)]));
}
