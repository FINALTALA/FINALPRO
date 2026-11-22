import type { CountedWomenCategory } from "@/components/women/WomenCategorySection";
import type { ListingFilterOptions } from "@/components/women/WomenDiscoverySection";
import { categoryCodeForSlug, sizeGroupFor, type ListingAudience } from "./discoveryFilters";
import { KIDS_CATEGORIES } from "./kidsCategories";
import { MEN_CATEGORIES } from "./menCategories";
import type { TaxonomyDto } from "./taxonomy";
import type { Lang } from "./i18n";
import { pickText, sizeName } from "./localized";
import { WOMEN_CATEGORIES, type WomenCategory } from "./womenCategories";

// The category circles and sidebar of each listing: WHICH categories and
// their names/order come from GET /taxonomy (the audience's own
// categories); the per-page lists only contribute the images, matched by
// taxonomy code.

const ART: Record<ListingAudience, WomenCategory[]> = {
  WOMEN: WOMEN_CATEGORIES,
  MEN: MEN_CATEGORIES,
  KIDS: KIDS_CATEGORIES,
};

const imagesByCode = (Object.keys(ART) as ListingAudience[]).reduce(
  (all, audience) => ({
    ...all,
    [audience]: new Map(ART[audience].map((item) => [categoryCodeForSlug(item.slug), item.image])),
  }),
  {} as Record<ListingAudience, Map<string, string | undefined>>,
);

export function listingCategories(
  audience: ListingAudience,
  taxonomy: TaxonomyDto | null,
  counts: Record<string, number> | null,
  lang: Lang = "ar",
): CountedWomenCategory[] {
  if (!taxonomy) return [];
  return taxonomy.categories
    .filter((category) => category.audiences.includes(audience))
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((category) => ({
      slug: category.code,
      label: pickText(lang, category.name_en, category.name_ar),
      image: imagesByCode[audience].get(category.code),
      count: counts?.[category.code] ?? 0,
    }));
}

/** The filter drawer's colours, sizes (adult sizes on /women and /men,
 * age sizes on /kids) and seasons, in taxonomy order. */
export function listingFilterOptions(
  audience: ListingAudience,
  taxonomy: TaxonomyDto | null,
  lang: Lang = "ar",
): ListingFilterOptions {
  if (!taxonomy) return { colors: [], sizes: [], seasons: [] };
  const byOrder = <T extends { sort_order: number }>(list: T[]) =>
    [...list].sort((a, b) => a.sort_order - b.sort_order);
  const group = sizeGroupFor(audience);
  return {
    colors: byOrder(taxonomy.colors).map((c) => ({ code: c.code, label: pickText(lang, c.name_en, c.name_ar), hex: c.hex })),
    sizes: byOrder(taxonomy.sizes.filter((s) => s.group === group)).map((s) => ({ code: s.code, label: sizeName(s.code, s.label, lang) ?? s.label })),
    seasons: byOrder(taxonomy.seasons).map((s) => ({ code: s.code, label: pickText(lang, s.name_en, s.name_ar) })),
  };
}
