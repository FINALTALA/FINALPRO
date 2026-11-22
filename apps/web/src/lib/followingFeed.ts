import type { ComparisonCardDto } from "./types";

// «أتابعه» in /profile: the followed stores' product feed. Its whole state
// lives in /profile's query string (next to ?tab=following), so a reload,
// Back/Forward and a shared link all show the same selection; the API
// (GET /customers/me/following/feed) applies every part of it.

export type FeedDepartment = "ALL" | "WOMEN" | "MEN" | "KIDS";
export type FeedCollection = "ALL" | "TRENDING" | "NEW" | "DISCOUNT";
export type FeedSort = "newest" | "price-asc" | "price-desc" | "trending";

export interface FeedState {
  department: FeedDepartment;
  category: string | null;
  collection: FeedCollection;
  q: string;
  colors: string[];
  sizes: string[];
  seasons: string[];
  brands: string[];
  minPrice: number | null;
  maxPrice: number | null;
  availableOnly: boolean;
  sort: FeedSort | null;
}

/** The drawer's part of the state (what «مسح الكل» resets). */
export type FeedDrawer = Pick<FeedState, "colors" | "sizes" | "seasons" | "brands" | "minPrice" | "maxPrice" | "availableOnly" | "sort">;

export const NO_DRAWER: FeedDrawer = {
  colors: [],
  sizes: [],
  seasons: [],
  brands: [],
  minPrice: null,
  maxPrice: null,
  availableOnly: false,
  sort: null,
};

export interface FeedResponse {
  followed_store_count: number;
  department: FeedDepartment;
  category: string | null;
  collection: FeedCollection;
  total: number;
  page_size: number;
  items: ComparisonCardDto[];
  next_cursor: string | null;
  department_counts: Record<FeedDepartment, number>;
  categories: { code: string; name_ar: string; name_en: string; count: number }[];
  collection_counts: Record<FeedCollection, number>;
  filter_options: {
    colors: { code: string; name_ar: string; hex: string | null }[];
    sizes: { code: string; label: string; group: "ADULT" | "KIDS_AGE" }[];
    seasons: { code: string; name_ar: string }[];
    brands: { id: string; name: string }[];
    price: { min: number; max: number } | null;
  };
}

const DEPARTMENTS: FeedDepartment[] = ["ALL", "WOMEN", "MEN", "KIDS"];
const COLLECTIONS: FeedCollection[] = ["ALL", "TRENDING", "NEW", "DISCOUNT"];
const SORTS: FeedSort[] = ["newest", "price-asc", "price-desc", "trending"];
/** The feed's own query keys (everything else - ?tab= - is left alone). */
export const FEED_KEYS = [
  "department",
  "category",
  "collection",
  "q",
  "color",
  "size",
  "season",
  "brand",
  "min_price",
  "max_price",
  "available_only",
  "sort",
] as const;

const list = (raw: string | null) => (raw ? raw.split(",").map((v) => v.trim()).filter(Boolean) : []);
function price(raw: string | null): number | null {
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The feed state in a URL; unknown values fall back to the defaults. */
export function parseFeedState(params: URLSearchParams): FeedState {
  const upper = (key: string) => params.get(key)?.toUpperCase() ?? "";
  const department = DEPARTMENTS.find((d) => d === upper("department")) ?? "ALL";
  const sort = SORTS.find((s) => s === params.get("sort")) ?? null;
  return {
    department,
    // A category only means something inside a department.
    category: department === "ALL" ? null : params.get("category") || null,
    collection: COLLECTIONS.find((c) => c === upper("collection")) ?? "ALL",
    q: params.get("q")?.trim() ?? "",
    colors: list(params.get("color")),
    sizes: list(params.get("size")),
    seasons: list(params.get("season")),
    brands: list(params.get("brand")),
    minPrice: price(params.get("min_price")),
    maxPrice: price(params.get("max_price")),
    availableOnly: params.get("available_only") === "true",
    sort,
  };
}

/** `base` (the page's other params) with `state` written over the feed keys. */
export function writeFeedState(base: URLSearchParams, state: FeedState): URLSearchParams {
  const next = new URLSearchParams(base.toString());
  for (const key of FEED_KEYS) next.delete(key);
  if (state.department !== "ALL") next.set("department", state.department.toLowerCase());
  if (state.department !== "ALL" && state.category) next.set("category", state.category);
  if (state.collection !== "ALL") next.set("collection", state.collection.toLowerCase());
  if (state.q) next.set("q", state.q);
  if (state.colors.length) next.set("color", state.colors.join(","));
  if (state.sizes.length) next.set("size", state.sizes.join(","));
  if (state.seasons.length) next.set("season", state.seasons.join(","));
  if (state.brands.length) next.set("brand", state.brands.join(","));
  if (state.minPrice !== null) next.set("min_price", String(state.minPrice));
  if (state.maxPrice !== null) next.set("max_price", String(state.maxPrice));
  if (state.availableOnly) next.set("available_only", "true");
  if (state.sort) next.set("sort", state.sort);
  return next;
}

/** The API query for `state` (the same names, upper-case enums). */
export function feedApiQuery(state: FeedState, pageSize: number): string {
  const p = writeFeedState(new URLSearchParams(), state);
  if (state.department !== "ALL") p.set("department", state.department);
  if (state.collection !== "ALL") p.set("collection", state.collection);
  p.set("facets", "all");
  p.set("page_size", String(pageSize));
  return p.toString();
}

/** How many drawer filters are applied (the Filter button's badge). */
export function drawerCount(s: FeedState): number {
  return (
    s.colors.length +
    s.sizes.length +
    s.seasons.length +
    s.brands.length +
    Number(s.availableOnly) +
    Number(s.minPrice !== null || s.maxPrice !== null)
  );
}

/**
 * A new department replaces only the department/category scope: the
 * smart button, search and drawer filters stay - except sizes from the
 * other size group (kids' ages vs adult sizes).
 */
export function withDepartment(
  s: FeedState,
  department: FeedDepartment,
  sizeGroup: (code: string) => "ADULT" | "KIDS_AGE" | undefined,
): FeedState {
  const wanted = department === "KIDS" ? "KIDS_AGE" : "ADULT";
  return {
    ...s,
    department,
    category: null,
    sizes: department === "ALL" ? s.sizes : s.sizes.filter((code) => (sizeGroup(code) ?? wanted) === wanted),
  };
}
