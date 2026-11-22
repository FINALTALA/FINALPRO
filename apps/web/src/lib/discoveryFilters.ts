// The /women, /men and /kids listing filters - one plain object that is
// the page URL's query string (refresh, back/forward and shared links all
// restore it) and is turned into the /discovery/all browse request.
// Pure functions only, so the conversions are unit-tested
// (apps/api/test/web-discovery-filters.e2e-spec.ts).

export type ListingAudience = "WOMEN" | "MEN" | "KIDS";
export type ListingSort = "newest" | "price-asc" | "price-desc" | "discounts" | "bestseller";
export type ListingTab = "all" | "trend" | "discounts";

export interface DiscoveryFilters {
  /** One taxonomy category code ("" = all). */
  category: string;
  /** Taxonomy codes; OR inside each list, AND across them. */
  colors: string[];
  sizes: string[];
  seasons: string[];
  minPrice: number | null;
  maxPrice: number | null;
  availableOnly: boolean;
  sort: ListingSort;
  tab: ListingTab;
}

export const EMPTY_FILTERS: DiscoveryFilters = {
  category: "",
  colors: [],
  sizes: [],
  seasons: [],
  minPrice: null,
  maxPrice: null,
  availableOnly: false,
  sort: "newest",
  tab: "all",
};

const SORTS: readonly ListingSort[] = ["newest", "price-asc", "price-desc", "discounts", "bestseller"];
const TABS: readonly ListingTab[] = ["all", "trend", "discounts"];
// Codes are UPPER_SNAKE (see GET /taxonomy) - anything else in a pasted
// URL is dropped here rather than sent to the API.
const CODE = /^[A-Z0-9_]{1,40}$/;

function codes(raw: string | null): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((value) => value.trim()).filter((value) => CODE.test(value)))];
}

function price(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** The page URL's query string -> filters (unknown values ignored). */
export function parseFilters(search: string | URLSearchParams): DiscoveryFilters {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const sort = params.get("sort");
  const tab = params.get("tab");
  const category = codes(params.get("category"))[0] ?? "";
  let minPrice = price(params.get("min_price"));
  let maxPrice = price(params.get("max_price"));
  if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
    [minPrice, maxPrice] = [maxPrice, minPrice];
  }
  return {
    category,
    colors: codes(params.get("color")),
    sizes: codes(params.get("size")),
    seasons: codes(params.get("season")),
    minPrice,
    maxPrice,
    availableOnly: params.get("available") === "1",
    sort: SORTS.includes(sort as ListingSort) ? (sort as ListingSort) : "newest",
    tab: TABS.includes(tab as ListingTab) ? (tab as ListingTab) : "all",
  };
}

/** Filters -> the page URL's query string ("" when nothing is set).
 * Stable order, so equal filters always give the same URL. */
export function filtersToSearch(filters: DiscoveryFilters): string {
  const params = new URLSearchParams();
  if (filters.category) params.set("category", filters.category);
  if (filters.colors.length) params.set("color", filters.colors.join(","));
  if (filters.sizes.length) params.set("size", filters.sizes.join(","));
  if (filters.seasons.length) params.set("season", filters.seasons.join(","));
  if (filters.minPrice !== null) params.set("min_price", String(filters.minPrice));
  if (filters.maxPrice !== null) params.set("max_price", String(filters.maxPrice));
  if (filters.availableOnly) params.set("available", "1");
  if (filters.sort !== "newest") params.set("sort", filters.sort);
  if (filters.tab !== "all") params.set("tab", filters.tab);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** Filters -> GET /discovery/all browse-mode parameters. */
export function filtersToApiParams(
  audience: ListingAudience,
  filters: DiscoveryFilters,
  options: { pageSize: number; cursor?: string | null; withFacets?: boolean },
): URLSearchParams {
  const params = new URLSearchParams({
    audience,
    sort: filters.sort,
    page_size: String(options.pageSize),
  });
  if (filters.category) params.set("category", filters.category);
  if (filters.colors.length) params.set("color", filters.colors.join(","));
  if (filters.sizes.length) params.set("size", filters.sizes.join(","));
  if (filters.seasons.length) params.set("season", filters.seasons.join(","));
  if (filters.minPrice !== null) params.set("min_price", String(filters.minPrice));
  if (filters.maxPrice !== null) params.set("max_price", String(filters.maxPrice));
  if (filters.availableOnly) params.set("available_only", "true");
  if (filters.tab !== "all") params.set("filter", filters.tab);
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.withFacets) params.set("facets", "categories");
  return params;
}

/** Identifies one result set (audience + every filter). */
export function filtersKey(audience: ListingAudience, filters: DiscoveryFilters): string {
  return `${audience}${filtersToSearch(filters)}`;
}

/** How many drawer filters are set (colour/size/season/price/availability). */
export function activeDrawerFilterCount(filters: DiscoveryFilters): number {
  return (
    filters.colors.length +
    filters.sizes.length +
    filters.seasons.length +
    (filters.minPrice !== null || filters.maxPrice !== null ? 1 : 0) +
    (filters.availableOnly ? 1 : 0)
  );
}

export function hasAnyFilter(filters: DiscoveryFilters): boolean {
  return filtersToSearch({ ...filters, sort: "newest" }) !== "";
}

/**
 * The filter drawer's "مسح الكل": clears colour, size, season, price,
 * availability and sort - but never the category. The category chosen
 * from the circles always stays the scope every other filter narrows
 * (category AND colour AND size AND ...); only the category circle itself
 * (clicked again) or "كل التصنيفات" removes it. The toolbar tab is not a
 * drawer field either, so it stays too.
 */
export function clearDrawerFilters(filters: DiscoveryFilters): DiscoveryFilters {
  return { ...EMPTY_FILTERS, category: filters.category, tab: filters.tab };
}

/** Size groups each listing offers: age sizes on kids only. */
export function sizeGroupFor(audience: ListingAudience): "ADULT" | "KIDS_AGE" {
  return audience === "KIDS" ? "KIDS_AGE" : "ADULT";
}

// The listings' category images are keyed by their own slugs; each
// slug's taxonomy code is the slug upper-snake-cased, except these.
const SLUG_CODE_OVERRIDES: Record<string, string> = {
  dresses: "DRESSES_WOMEN",
  "t-shirts": "TSHIRTS",
  suits: "FORMAL_SUITS",
  activewear: "SPORTSWEAR",
  kaftans: "JALABIYAS_KAFTANS",
  jewelry: "JEWELLERY",
  sunglasses: "EYEWEAR",
  hats: "HATS_CAPS",
};

export function categoryCodeForSlug(slug: string): string {
  return SLUG_CODE_OVERRIDES[slug] ?? slug.toUpperCase().replace(/-/g, "_");
}
