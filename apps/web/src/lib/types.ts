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
export interface ComparisonCardDto {
  canonical_product_id: string;
  canonical_name_ar: string;
  canonical_name_en: string;
  lowest_price: string;
  lowest_price_availability: Availability;
  image_url: string | null;
  brand_name: string | null;
  category_name: string | null;
  store_count: number;
  has_discount?: boolean;
  discounted_store_count?: number;
  rating?: number | null;
  rating_count?: number;
  colors: string[];
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
