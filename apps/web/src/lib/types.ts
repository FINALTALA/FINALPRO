export type Availability = "available" | "low_stock" | "sold_out";

export const AVAILABILITY_LABEL: Record<Availability, string> = {
  available: "متوفر",
  low_stock: "كمية محدودة",
  sold_out: "غير متوفر",
};

export interface StoreLogoDto {
  vendor_id: string;
  vendor_slug: string;
  display_name: string;
  logo_url: string | null;
  offer_id: string;
  offer_variant_id: string;
  price: string;
  is_discounted?: boolean;
}

/** The global comparison card (GET /discovery/all, /customers/me/following/feed). */
/** PD-5.3: the scope a product is a qualified bestseller in - nothing numeric. */
export interface BestsellerMark {
  category_code: string;
  audience: string;
}

export interface ComparisonCardDto {
  /** PD-5.3: present on discovery listings only; null = no mark. */
  bestseller?: BestsellerMark | null;
  canonical_product_id: string;
  canonical_name_ar: string;
  canonical_name_en: string;
  lowest_price: string;
  lowest_price_availability: Availability;
  image_url: string | null;
  brand_name: string | null;
  category_name: string | null;
  /** TB-25.2: the catalogue category's English name (absent from an older API). */
  category_name_en?: string | null;
  store_count: number;
  has_discount?: boolean;
  discounted_store_count?: number;
  rating?: number | null;
  rating_count?: number;
  colors: string[];
  /** TB-25.2: taxonomy colour codes of the eligible offers, named by language on the web (absent from an older API). */
  color_codes?: string[];
  sizes: string[];
  cheapest_offer: {
    vendor_id: string;
    vendor_slug: string;
    offer_id: string;
    offer_variant_id: string;
  };
  store_logos: StoreLogoDto[];
}

/** /discovery/all in browse mode (sort/filter/category/cursor): cursor
 * pagination; category_counts only when requested with facets=categories. */
export interface BrowsePageDto {
  page_size: number;
  total: number;
  items: ComparisonCardDto[];
  next_cursor: string | null;
  category_counts?: Record<string, number>;
  all_count?: number;
  /** PD-5.3: the Bestseller mark and sort are on (feature flag). */
  bestseller_enabled?: boolean;
}

export interface CardsPageDto {
  page: number;
  page_size: number;
  total: number;
  items: ComparisonCardDto[];
}

export interface StoreSummaryDto {
  slug: string;
  display_name: string;
  logo_url: string | null;
  bio?: string | null;
}

export const SEGMENTS: { key: string; label: string }[] = [
  { key: "all", label: "الكل" },
  { key: "women", label: "نساء" },
  { key: "men", label: "رجال" },
  { key: "kids", label: "أطفال" },
  { key: "accessories", label: "إكسسوارات" },
  { key: "watches", label: "ساعات" },
  { key: "shoes", label: "أحذية" },
];
