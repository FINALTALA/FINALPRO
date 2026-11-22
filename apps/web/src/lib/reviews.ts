import { ApiError } from "./api";

// Sprint 23 (EPIC-REV): mirrors the established lib/returns.ts
// convention (plain lookup tables, pure functions, no browser APIs so
// they stay unit-testable without a DOM). PD-3 adds the enriched review
// shapes, labels and the query builder used by the product page.

export const REVIEW_TARGET_LABEL: Record<string, string> = {
  PRODUCT: "المنتج",
  STORE: "المتجر",
};

export type ReviewFit = "SMALL" | "TRUE_TO_SIZE" | "LARGE" | "NOT_APPLICABLE";
export type ReviewTag =
  | "GOOD_QUALITY"
  | "EXCELLENT_MATERIAL"
  | "MATCHES_PHOTOS"
  | "COMFORTABLE"
  | "GOOD_VALUE"
  | "BELOW_EXPECTATIONS"
  | "DIFFERS_FROM_PHOTOS";
export type ReviewAuthorDisplay = "ANONYMOUS" | "FIRST_NAME_INITIAL";
export type ReviewSort = "newest" | "helpful" | "rating_desc" | "rating_asc";

export const FIT_LABEL: Record<ReviewFit, string> = {
  SMALL: "صغير",
  TRUE_TO_SIZE: "مناسب",
  LARGE: "كبير",
  NOT_APPLICABLE: "لا ينطبق",
};

/** The approved impression tags (decision 7) - at most three per review. */
export const TAG_LABEL: Record<ReviewTag, string> = {
  GOOD_QUALITY: "جودة جيدة",
  EXCELLENT_MATERIAL: "خامة ممتازة",
  MATCHES_PHOTOS: "مطابق للصور",
  COMFORTABLE: "مريح",
  GOOD_VALUE: "يستحق السعر",
  BELOW_EXPECTATIONS: "أقل من المتوقع",
  DIFFERS_FROM_PHOTOS: "يختلف عن الصور",
};
export const MAX_REVIEW_TAGS = 3;
export const MAX_REVIEW_IMAGES = 5;
export const REVIEW_BODY_MAX = 1000;

export const SORT_LABEL: Record<ReviewSort, string> = {
  newest: "الأحدث",
  helpful: "الأكثر فائدة",
  rating_desc: "الأعلى تقييماً",
  rating_asc: "الأقل تقييماً",
};

export interface ReviewMediaDto {
  id: string;
  url: string;
  alt_text: string | null;
  width: number;
  height: number;
}

export interface ReviewDto {
  id: string;
  target_type: "PRODUCT" | "STORE";
  rating: number;
  body: string;
  author: string;
  verified_purchase: boolean;
  purchased: {
    title: string | null;
    color_code: string | null;
    color_label: string | null;
    size_code: string | null;
    size_label: string | null;
  } | null;
  store: { slug: string; name: string } | null;
  returned: boolean;
  fit: ReviewFit | null;
  tags: ReviewTag[];
  media: ReviewMediaDto[];
  helpful_count: number;
  edited: boolean;
  created_at: string;
  /** Only on the author's own review. */
  editable_until?: string;
  author_display?: ReviewAuthorDisplay;
  viewer?: {
    is_author: boolean;
    voted_helpful: boolean;
    can_vote: boolean;
    can_report: boolean;
    can_edit: boolean;
  };
}

export interface ReviewsSummaryDto {
  distribution: Record<"1" | "2" | "3" | "4" | "5", number> | null;
  fit: { answered: number; SMALL: number; TRUE_TO_SIZE: number; LARGE: number } | null;
  with_media: number;
  tags: { tag: ReviewTag; count: number }[];
  filter_options: {
    colors: { code: string; label: string; count: number }[];
    sizes: { code: string; label: string; count: number }[];
    stores: { slug: string; name: string; count: number }[];
  };
}

export interface ReviewsPageDto {
  aggregate: { average: number | null; count: number };
  summary: ReviewsSummaryDto;
  total: number;
  reviews: ReviewDto[];
  next_cursor: string | null;
}

export interface ReviewFilters {
  sort: ReviewSort;
  hasMedia: boolean;
  color: string | null;
  size: string | null;
  rating: number | null;
  fit: Exclude<ReviewFit, "NOT_APPLICABLE"> | null;
  store: string | null;
}

export const NO_REVIEW_FILTERS: ReviewFilters = {
  sort: "newest",
  hasMedia: false,
  color: null,
  size: null,
  rating: null,
  fit: null,
  store: null,
};

/** The list endpoint's query string for these filters and page. */
export function reviewsQuery(f: ReviewFilters, cursor: string | null, limit = 6): string {
  const p = new URLSearchParams();
  p.set("limit", String(limit));
  if (f.sort !== "newest") p.set("sort", f.sort);
  if (f.hasMedia) p.set("has_media", "true");
  if (f.color) p.set("color", f.color);
  if (f.size) p.set("size", f.size);
  if (f.rating) p.set("rating", String(f.rating));
  if (f.fit) p.set("fit", f.fit);
  if (f.store) p.set("store", f.store);
  if (cursor) p.set("cursor", cursor);
  return p.toString();
}

/** How many of the filters (not the sort) are on. */
export function activeReviewFilterCount(f: ReviewFilters): number {
  return [f.hasMedia, f.color, f.size, f.rating, f.fit, f.store].filter(Boolean).length;
}

/** Percent of `part` in `whole`, rounded; 0 when there is nothing. */
export function share(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

/** "اللون: أسود · المقاس: M" - only what the purchase snapshot has. */
export function purchasedLine(p: ReviewDto["purchased"]): string | null {
  if (!p) return null;
  const parts = [
    p.color_label ? `اللون: ${p.color_label}` : null,
    p.size_label ? `المقاس: ${p.size_label}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

const ERROR_MESSAGES: Record<string, string> = {
  BRANCH_ORDER_ITEM_NOT_FOUND: "لم يُعثر على هذا المنتج ضمن طلباتك.",
  ITEM_CANCELLED_NOT_REVIEWABLE: "هذا المنتج أُلغي قبل التوصيل، ولا يمكن مراجعته.",
  NOT_ELIGIBLE_FOR_REVIEW: "لا يمكن مراجعة هذا الطلب قبل اكتماله فعلياً (توصيل أو استلام).",
  PRODUCT_NOT_ELIGIBLE_FOR_REVIEW:
    "هذا المنتج غير مرتبط بمنتج أساسي على المنصة، فلا يمكن مراجعته - يمكنكِ مراجعة المتجر بدلاً من ذلك.",
  REVIEW_ALREADY_SUBMITTED: "سبق أن قدّمتِ مراجعة من هذا النوع لهذا الطلب.",
  REVIEW_NOT_FOUND: "لم يُعثر على هذه المراجعة.",
  REVIEW_ALREADY_HIDDEN: "هذه المراجعة مخفية بالفعل.",
  REVIEW_ALREADY_REPORTED: "سبق أن بلّغتِ عن هذه المراجعة.",
  NO_PENDING_REPORTS: "لا يوجد بلاغ معلَّق على هذه المراجعة ليُحسَم.",
  CANONICAL_PRODUCT_NOT_FOUND: "لم يُعثر على هذا المنتج.",
  VENDOR_NOT_FOUND: "لم يُعثر على هذا المتجر.",
  STOREFRONT_NOT_FOUND: "لم يُعثر على متجر بهذا الرابط.",
  // PD-3
  REVIEW_EDIT_WINDOW_CLOSED: "انتهت مهلة تعديل التقييم (30 يوماً من كتابته).",
  REVIEW_UNDER_MODERATION: "على هذا التقييم بلاغ قيد المراجعة، ويمكن تعديله بعد البتّ فيه.",
  REVIEW_HIDDEN: "أُخفي هذا التقييم بقرار من الإدارة ولا يمكن تعديله.",
  FIELD_NOT_APPLICABLE_TO_STORE_REVIEW: "الملاءمة والوسوم خاصة بتقييم المنتج.",
  CANNOT_VOTE_OWN_REVIEW: "لا يمكنكِ التصويت على تقييمك.",
  SELLER_CANNOT_VOTE: "لا يمكن لفريق المتجر البائع التصويت على تقييماته.",
  CANNOT_REPORT_OWN_REVIEW: "لا يمكنكِ الإبلاغ عن تقييمك.",
  MEDIA_CONSENT_REQUIRED: "يجب الموافقة على نشر الصورة أولاً.",
  UNSUPPORTED_MEDIA_TYPE: "الصيغ المسموحة: JPG أو PNG أو WebP.",
  UNPROCESSABLE_IMAGE: "تعذّرت قراءة هذه الصورة، جرّبي ملفاً آخر.",
  FILE_TOO_LARGE: "حجم الصورة أكبر من 5 ميغابايت.",
  REVIEW_MEDIA_LIMIT_REACHED: "يمكن إرفاق 5 صور كحد أقصى.",
  MEDIA_NOT_ALLOWED_ON_STORE_REVIEW: "الصور تُرفق بتقييم المنتج فقط.",
  REVIEW_MEDIA_NOT_FOUND: "لم يُعثر على هذه الصورة.",
  REVIEW_MEDIA_ALREADY_HIDDEN: "هذه الصورة مخفية بالفعل.",
  INVALID_CURSOR: "تغيّرت القائمة، أعيدي تحميل التقييمات.",
  UNAUTHENTICATED: "سجّلي الدخول أولاً.",
};

/** Turns an API failure into the Arabic message shown to the user. */
export function reviewErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    return ERROR_MESSAGES[err.code] ?? err.message;
  }
  return "تعذّر الاتصال بالخادم";
}

// TB-25: the same words in English for the shopper's pages (product page
// reviews, the review composer). The Arabic tables above are unchanged and
// still used as they are by the admin and store-owner pages.
type Lang = "ar" | "en";

const REVIEW_TARGET_LABEL_EN: Record<string, string> = { PRODUCT: "Product", STORE: "Store" };
const FIT_LABEL_EN: Record<ReviewFit, string> = {
  SMALL: "Small",
  TRUE_TO_SIZE: "True to size",
  LARGE: "Large",
  NOT_APPLICABLE: "Not applicable",
};
const TAG_LABEL_EN: Record<ReviewTag, string> = {
  GOOD_QUALITY: "Good quality",
  EXCELLENT_MATERIAL: "Excellent material",
  MATCHES_PHOTOS: "Matches the photos",
  COMFORTABLE: "Comfortable",
  GOOD_VALUE: "Worth the price",
  BELOW_EXPECTATIONS: "Below expectations",
  DIFFERS_FROM_PHOTOS: "Differs from the photos",
};
const SORT_LABEL_EN: Record<ReviewSort, string> = {
  newest: "Newest",
  helpful: "Most helpful",
  rating_desc: "Highest rated",
  rating_asc: "Lowest rated",
};

export const reviewTargetLabel = (lang: Lang, target: string): string =>
  (lang === "en" ? REVIEW_TARGET_LABEL_EN : REVIEW_TARGET_LABEL)[target] ?? target;
export const fitLabel = (lang: Lang, fit: ReviewFit): string => (lang === "en" ? FIT_LABEL_EN : FIT_LABEL)[fit];
export const tagLabel = (lang: Lang, tag: ReviewTag): string => (lang === "en" ? TAG_LABEL_EN : TAG_LABEL)[tag];
export const sortLabel = (lang: Lang, sort: ReviewSort): string => (lang === "en" ? SORT_LABEL_EN : SORT_LABEL)[sort];

/**
 * The purchase line in the interface language. `colorName` names a
 * taxonomy colour code in that language (the snapshot label otherwise);
 * `sizeName` words a size code (the snapshot label otherwise).
 */
export function purchasedLineIn(
  p: ReviewDto["purchased"],
  lang: Lang,
  colorName: (code: string | null) => string | null = () => null,
  sizeName: (code: string | null, label: string | null) => string | null = (_c, label) => label,
): string | null {
  if (lang === "ar") return purchasedLine(p);
  if (!p) return null;
  const color = colorName(p.color_code) ?? p.color_label;
  const size = sizeName(p.size_code, p.size_label) ?? p.size_label;
  const parts = [color ? `Colour: ${color}` : null, size ? `Size: ${size}` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

const ERROR_MESSAGES_EN: Record<string, string> = {
  BRANCH_ORDER_ITEM_NOT_FOUND: "This product wasn't found in your orders.",
  ITEM_CANCELLED_NOT_REVIEWABLE: "This product was cancelled before delivery and can't be reviewed.",
  NOT_ELIGIBLE_FOR_REVIEW: "This order can't be reviewed until it's actually completed (delivered or picked up).",
  PRODUCT_NOT_ELIGIBLE_FOR_REVIEW:
    "This product isn't linked to a platform product, so it can't be reviewed - you can review the store instead.",
  REVIEW_ALREADY_SUBMITTED: "You've already submitted a review of this kind for this order.",
  REVIEW_NOT_FOUND: "This review wasn't found.",
  REVIEW_ALREADY_HIDDEN: "This review is already hidden.",
  REVIEW_ALREADY_REPORTED: "You've already reported this review.",
  NO_PENDING_REPORTS: "There's no pending report on this review to decide.",
  CANONICAL_PRODUCT_NOT_FOUND: "This product wasn't found.",
  VENDOR_NOT_FOUND: "This store wasn't found.",
  STOREFRONT_NOT_FOUND: "There's no store at this link.",
  REVIEW_EDIT_WINDOW_CLOSED: "The time to edit this review has ended (30 days from writing it).",
  REVIEW_UNDER_MODERATION: "This review has a report under review; it can be edited once it's decided.",
  REVIEW_HIDDEN: "This review was hidden by the platform and can't be edited.",
  FIELD_NOT_APPLICABLE_TO_STORE_REVIEW: "Fit and tags belong to a product review.",
  CANNOT_VOTE_OWN_REVIEW: "You can't vote on your own review.",
  SELLER_CANNOT_VOTE: "The selling store's team can't vote on its reviews.",
  CANNOT_REPORT_OWN_REVIEW: "You can't report your own review.",
  MEDIA_CONSENT_REQUIRED: "You need to agree to publishing the image first.",
  UNSUPPORTED_MEDIA_TYPE: "Allowed formats: JPG, PNG or WebP.",
  UNPROCESSABLE_IMAGE: "This image couldn't be read - try another file.",
  FILE_TOO_LARGE: "The image is larger than 5 MB.",
  REVIEW_MEDIA_LIMIT_REACHED: "You can attach at most 5 images.",
  MEDIA_NOT_ALLOWED_ON_STORE_REVIEW: "Images can only be attached to a product review.",
  REVIEW_MEDIA_NOT_FOUND: "This image wasn't found.",
  REVIEW_MEDIA_ALREADY_HIDDEN: "This image is already hidden.",
  INVALID_CURSOR: "The list has changed - reload the reviews.",
  UNAUTHENTICATED: "Please sign in first.",
};

/**
 * A review failure in the interface language. Arabic is exactly
 * reviewErrorMessage(); English never shows the server's own text (an
 * unknown code gets the shared wording by HTTP status).
 */
export function reviewErrorMessageIn(err: unknown, lang: Lang, fallback: (err: unknown) => string): string {
  if (lang === "ar") return reviewErrorMessage(err);
  if (err instanceof ApiError) return ERROR_MESSAGES_EN[err.code] ?? fallback(err);
  return fallback(err);
}
