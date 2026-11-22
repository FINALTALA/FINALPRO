import { apiFetch, authHeadersFor } from "./api";
import type { Availability } from "./types";

/**
 * «الصفحة الرئيسية المرنة للمتجر» (2026-11-20): the shapes the API returns
 * (apps/api/src/store-home/) and the few rules the screens share. The API is
 * the authority for every rule - these only shape the owner's screens.
 */

export interface LocalText {
  ar: string;
  en: string;
}
export const NO_TEXT: LocalText = { ar: "", en: "" };

export interface HomeImage {
  url: string;
  width: number | null;
  height: number | null;
  bytes: number | null;
}

export type HomeTarget =
  | { kind: "products" }
  | { kind: "new" }
  | { kind: "sale" }
  | { kind: "collection"; id: string }
  | { kind: "product"; id: string }
  | { kind: "category"; audience: string; category: string }
  /** a department (a category card's destination only) */
  | { kind: "audience"; audience: string };

/**
 * «قوالب وستايلات وأشكال الصفحة الرئيسية» (2026-11-21): closed choices that
 * mirror the API (store-home.layout.ts). STYLE = the page's look (ready
 * tokens only), TEMPLATE = which ready structure built the draft; they are
 * independent. Defaults (style "default", the first variant, focus "center")
 * are exactly the look before these choices existed.
 */
export const HOME_STYLES = ["default", "elegant", "warm", "calm", "modern"] as const;
export type HomeStyle = (typeof HOME_STYLES)[number];
export const HOME_TEMPLATES = ["luxe", "sale", "kids", "minimal"] as const;
export type HomeTemplate = (typeof HOME_TEMPLATES)[number];
export const BLOCK_VARIANTS = {
  hero: ["overlay", "split"],
  banner: ["single", "double"],
  products: ["standard", "side"],
  auto_products: ["standard", "side"],
} as const;
/** Where the image's subject is (3x3, physical sides - images are never mirrored). */
export const FOCUS_POINTS = ["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"] as const;
export type FocusPoint = (typeof FOCUS_POINTS)[number];

export interface HeroSlide {
  /** null: a place for an image not chosen yet («أضيفي صورة») - never shown to shoppers */
  image: HomeImage | null;
  image_mobile: HomeImage | null;
  title: LocalText;
  text: LocalText;
  button: LocalText;
  target: HomeTarget | null;
  /** logical: start / center / end (P2 added end) */
  align: "start" | "center" | "end";
  alt: LocalText;
  focus?: FocusPoint;
}

/** One card of a banner (the double banner has two). */
export interface BannerCard {
  image: HomeImage | null;
  image_mobile: HomeImage | null;
  title: LocalText;
  text: LocalText;
  target: HomeTarget | null;
  alt: LocalText;
  focus?: FocusPoint;
}
/** «بطاقات التصنيفات» (P1): one card - a picture that leads to a real department or category of the store. */
export interface CategoryCard {
  audience: "WOMEN" | "MEN" | "KIDS";
  category: string | null;
  image: HomeImage | null;
  title: LocalText;
  text: LocalText;
  alt: LocalText;
  focus?: FocusPoint;
}
export const CARD_SHAPES = ["circle", "square", "portrait"] as const;

/**
 * «لوحة ترويجية» promo_grid (P3): 2-4 tiles in a ready layout (mirrors the
 * API's PROMO_LAYOUTS - the first of each count is its default), the wide
 * tile's part (big_* only) and how the tiles meet. Never free sizes.
 */
export const PROMO_LAYOUTS: Record<number, readonly PromoLayout[]> = {
  2: ["even", "start_wide", "end_wide"],
  3: ["even", "big_start", "big_end"],
  4: ["grid", "big_start", "big_end"],
};
export type PromoLayout = "even" | "start_wide" | "end_wide" | "big_start" | "big_end" | "grid";
export const PROMO_DIVIDERS = ["gap", "straight", "slant", "wave"] as const;
export type PromoDivider = (typeof PROMO_DIVIDERS)[number];
export const PROMO_SHARES = [50, 60] as const;
export interface PromoTile {
  image: HomeImage | null;
  title: LocalText;
  text: LocalText;
  button: LocalText;
  target: HomeTarget | null;
  alt: LocalText;
  focus?: FocusPoint;
}
export const EMPTY_TILE: PromoTile = { image: null, title: { ar: "", en: "" }, text: { ar: "", en: "" }, button: { ar: "", en: "" }, target: null, alt: { ar: "", en: "" }, focus: "center" };
/** The layout a count of tiles uses: the chosen one when it suits it, else that count's default (the API's rule). */
export function promoLayoutFor(layout: PromoLayout, count: number): PromoLayout {
  const allowed = PROMO_LAYOUTS[count];
  if (!allowed) return layout;
  return allowed.includes(layout) ? layout : allowed[0];
}
export type CardShape = (typeof CARD_SHAPES)[number];
export const EMPTY_CARD: BannerCard = { image: null, image_mobile: null, title: { ar: "", en: "" }, text: { ar: "", en: "" }, target: null, alt: { ar: "", en: "" }, focus: "center" };

/**
 * How a block is laid out (2026-11-21): closed choices only - the API refuses
 * anything else. Each type takes only the keys that suit it; a missing key is
 * its default (the look every block had before these choices existed).
 */
export type DisplayKey = "width" | "height" | "spacing";
export interface BlockDisplay {
  width?: "content" | "full";
  height?: "compact" | "medium" | "wide";
  spacing?: "tight" | "normal" | "wide";
  /** P2: whole steps over the presets (absent = the preset's look) - see FINE_STEPS */
  height_step?: number;
  space_before?: number;
  space_after?: number;
  content_width?: number;
  content_align?: "center" | "end";
  text_width?: number;
  per_view?: number;
}

/**
 * P2 «نظام القياس والمحاذاة» (2026-11-22) - mirrors the API (store-home.layout.ts
 * DISPLAY_STEPS / FINE_KEYS / PER_VIEW); the API is the authority. One step =
 * 10px (height, spaces) or 10% (widths) on a computer; a phone derives its own
 * value (half the height offset; 0.6x the spaces, at most 60px; full width) and
 * the shoppers' CSS clamps every final height.
 */
export type FineKey = "height_step" | "space_before" | "space_after" | "content_width" | "content_align" | "text_width" | "per_view";
export const FINE_STEPS = {
  height_step: { min: -6, max: 16 },
  space_before: { min: 0, max: 10 },
  space_after: { min: 0, max: 10 },
  content_width: { min: 6, max: 10 },
  text_width: { min: 4, max: 7 },
} as const;
const SPACES: FineKey[] = ["space_before", "space_after"];
const CONTENT: FineKey[] = ["content_width", "content_align"];
export const FINE_KEYS: Record<string, FineKey[]> = {
  hero: ["height_step", ...SPACES, "text_width"],
  banner: ["height_step", ...SPACES],
  collections: [...SPACES, ...CONTENT],
  products: [...SPACES, ...CONTENT, "per_view"],
  auto_products: [...SPACES, ...CONTENT, "per_view"],
  categories: [...SPACES],
  text: [...SPACES, ...CONTENT],
  category_cards: [...SPACES, ...CONTENT, "per_view"],
  promo_grid: [...SPACES, ...CONTENT],
};
export const PER_VIEW: Record<string, readonly number[]> = {
  products: [3, 4, 5],
  auto_products: [3, 4, 5],
  circle: [5, 6, 8],
  square: [4, 5, 6],
  portrait: [3, 4, 5],
};
/** The preset space on each side of a block (px, computer) - what «افتراضي» means. */
export const PRESET_SPACE = { tight: 8, normal: 20, wide: 36 } as const;

/** The classes and CSS variables a block's fine sizes give its slot (closed integers -> px / %). */
export function fineLayout(d: BlockDisplay | undefined): { className: string; style: Record<string, string> } {
  const cls: string[] = [];
  const style: Record<string, string> = {};
  if (!d) return { className: "", style };
  if (d.height_step) {
    cls.push("sh-dh");
    style["--sh-dh"] = `${d.height_step * 10}px`;
    style["--sh-dh-m"] = `${Math.round(d.height_step * 5)}px`;
  }
  for (const [key, c] of [["space_before", "sb"], ["space_after", "sa"]] as const) {
    const v = d[key];
    if (v === undefined || v === null) continue;
    cls.push(`sh-${c}`);
    style[`--sh-${c}`] = `${v * 10}px`;
    style[`--sh-${c}-m`] = `${Math.min(60, Math.round(v * 6))}px`;
  }
  if (d.content_width && d.content_width < 10) {
    cls.push("sh-cw");
    style["--sh-cw"] = `${d.content_width * 10}%`;
  }
  if (d.content_align === "center" || d.content_align === "end") cls.push(`sh-ca-${d.content_align}`);
  if (d.text_width) {
    cls.push("sh-tw");
    style["--sh-tw"] = `${d.text_width * 10}%`;
  }
  if (d.per_view) {
    cls.push("sh-pv");
    style["--sh-pv"] = String(d.per_view);
  }
  return { className: cls.join(" "), style };
}
export const DISPLAY_VALUES = {
  width: ["content", "full"],
  height: ["compact", "medium", "wide"],
  spacing: ["tight", "normal", "wide"],
} as const;
export const DISPLAY_DEFAULTS = { width: "content", height: "medium", spacing: "normal" } as const;
/** Mirrors the API (store-home.layout.ts DISPLAY_KEYS); the owner screen prefers the API's own copy. */
export const DISPLAY_KEYS: Record<string, DisplayKey[]> = {
  hero: ["width", "height", "spacing"],
  banner: ["width", "height", "spacing"],
  collections: ["spacing"],
  products: ["spacing"],
  auto_products: ["spacing"],
  categories: ["spacing"],
  text: ["spacing"],
  category_cards: ["spacing"],
  promo_grid: ["spacing"],
};
/** The block's display with defaults for every preset key its type takes; its fine sizes (P2) are kept as they are. */
export function displayOf(type: string, d: BlockDisplay | undefined, keys: Record<string, DisplayKey[]> = DISPLAY_KEYS): BlockDisplay {
  const out: BlockDisplay = {};
  if (d) for (const k of FINE_KEYS[type] ?? []) if (d[k] !== undefined && d[k] !== null) (out as Record<string, unknown>)[k] = d[k];
  for (const k of keys[type] ?? ["spacing"]) (out as Record<string, string>)[k] = d?.[k] ?? DISPLAY_DEFAULTS[k];
  return out;
}
/** The classes the shoppers' component lays a block out with. */
export function displayClass(d: BlockDisplay | undefined): string {
  return [`sh-sp-${d?.spacing ?? "normal"}`, `sh-h-${d?.height ?? "medium"}`, `sh-w-${d?.width ?? "content"}`].join(" ");
}

type Base = { id: string; visible: boolean; display?: BlockDisplay };
export type HomeBlock =
  | (Base & { type: "hero"; variant?: "overlay" | "split"; slides: HeroSlide[] })
  | (Base & BannerCard & { type: "banner"; variant?: "single" | "double"; second?: BannerCard | null })
  | (Base & { type: "collections"; title: LocalText; collection_ids: string[] })
  | (Base & { type: "products"; variant?: "standard" | "side"; title: LocalText; text?: LocalText; offer_ids: string[] })
  | (Base & { type: "auto_products"; variant?: "standard" | "side"; title: LocalText; text?: LocalText; source: "new" | "sale"; count: number })
  | (Base & { type: "categories"; title: LocalText; items: { audience: string; category: string }[] })
  | (Base & { type: "text"; style: "text" | "divider"; title: LocalText; text: LocalText })
  | (Base & { type: "category_cards"; shape: CardShape; title: LocalText; items: CategoryCard[] })
  | (Base & { type: "promo_grid"; layout: PromoLayout; share: number; divider: PromoDivider; tiles: PromoTile[] });
export type BlockType = HomeBlock["type"];
/**
 * What the owner can add. «categories» is retired (2026-11-20): «استكشفي التصنيفات» shows them under the store's
 * identity; a saved one is kept, never shown. «category_cards» (P1) is a different, visual block of pictures.
 */
export const BLOCK_TYPES: BlockType[] = ["hero", "banner", "promo_grid", "collections", "products", "auto_products", "category_cards", "text"];

export interface HomeLayout {
  style?: HomeStyle;
  template?: HomeTemplate | null;
  blocks: HomeBlock[];
}

export interface HomeCard {
  id: string;
  title_ar: string;
  title_en: string;
  min_price: string | null;
  original_price: string | null;
  discount_percent: number | null;
  availability: Availability;
  image_url: string | null;
  favorite_variant_id: string | null;
  created_at: string;
}

type ShownImage = { url: string; width: number | null; height: number | null };
export type ShownCard = { image: ShownImage; image_mobile: ShownImage | null; title: LocalText; text: LocalText; target: HomeTarget | null; alt: LocalText; focus?: FocusPoint };
type ResolvedBlockBody =
  | { id: string; type: "hero"; variant?: "overlay" | "split"; slides: { image: ShownImage; image_mobile: ShownImage | null; title: LocalText; text: LocalText; button: LocalText; target: HomeTarget | null; align: "start" | "center" | "end"; alt: LocalText; focus?: FocusPoint }[] }
  | (ShownCard & { id: string; type: "banner"; variant?: "single" | "double"; second?: ShownCard | null })
  | { id: string; type: "collections"; title: LocalText; items: { id: string; name_ar: string; name_en: string | null; image_url: string | null; count: number }[] }
  | { id: string; type: "products"; variant?: "standard" | "side"; title: LocalText; text?: LocalText; items: HomeCard[] }
  | { id: string; type: "auto_products"; variant?: "standard" | "side"; title: LocalText; text?: LocalText; source: "new" | "sale"; items: HomeCard[] }
  | { id: string; type: "categories"; title: LocalText; items: { audience: string; category: string; name_ar: string; name_en: string; audience_ar: string; audience_en: string; image_url: string | null; count: number }[] }
  | { id: string; type: "text"; style: "text" | "divider"; title: LocalText; text: LocalText }
  | { id: string; type: "category_cards"; shape: CardShape; title: LocalText; items: ShownCategoryCard[] }
  | { id: string; type: "promo_grid"; layout: PromoLayout; share: number; divider: PromoDivider; tiles: ShownTile[] };

export type ShownTile = { image: ShownImage; title: LocalText; text: LocalText; button: LocalText; target: HomeTarget | null; alt: LocalText; focus?: FocusPoint };

export type ShownCategoryCard = {
  target: { kind: "audience"; audience: string } | { kind: "category"; audience: string; category: string };
  image: ShownImage;
  title: LocalText;
  text: LocalText;
  alt: LocalText;
  focus?: FocusPoint;
};

export type ResolvedBlock = ResolvedBlockBody & { display?: BlockDisplay };

export interface PublicHome {
  enabled: boolean;
  blocks: ResolvedBlock[];
  /** the published page's look (absent: the default look) */
  style?: HomeStyle;
}

/** «فحص قبل النشر» (the API computes it; errors stop «نشر», warnings never do). */
export interface QualityIssue {
  code: string;
  block_id: string;
  slide?: number;
  card?: number;
  image?: "desktop" | "phone";
}

export type OfferRefStatus = "ok" | "unpublished" | "sold_out" | "missing";
export type CollectionRefStatus = "ok" | "hidden" | "empty" | "missing";
export interface BlockReview {
  shown: boolean;
  reason: null | "hidden" | "too_few" | "no_image" | "retired" | "incomplete";
  shown_items: number;
}
export interface CategoryOption {
  audience: string;
  category: string;
  name_ar: string;
  name_en: string;
  audience_ar: string;
  audience_en: string;
  count: number;
}

export interface OwnerHome {
  enabled: boolean;
  slug: string;
  draft: HomeLayout;
  draft_version: number;
  published_version: number | null;
  published_at: string | null;
  has_published: boolean;
  has_unpublished_changes: boolean;
  preview: { blocks: ResolvedBlock[]; style?: HomeStyle };
  review: Record<string, BlockReview>;
  checks?: { errors: QualityIssue[]; warnings: QualityIssue[] };
  refs: {
    offers: Record<string, { title_ar: string | null; title_en: string | null; image_url: string | null; status: OfferRefStatus }>;
    collections: Record<string, { name_ar: string | null; name_en: string | null; status: CollectionRefStatus }>;
    categories: Record<string, CategoryOption & { status: "ok" | "empty" }>;
    images: Record<string, "ok" | "missing">;
  };
  options: {
    collections: { id: string; name_ar: string; name_en: string | null; visible: boolean; count: number }[];
    categories: CategoryOption[];
    new_count: number;
    sale_count: number;
    /** departments with products shoppers can buy now (a category card's choices) */
    audiences?: { audience: string; name_ar: string; name_en: string; count: number }[];
  };
  limits: { blocks: number; images: number; heroSlides: number; products: number; collections: number; categories: number; autoMin: number; autoMax: number; categoryCards?: number; promoTiles?: number };
  text_limits: { title: number; heroText: number; bannerText: number; body: number; button: number; alt: number; sideText?: number; cardTitle?: number; cardText?: number; tileTitle?: number; tileText?: number };
  min_shown_items: number;
  /** the API's display rules (closed values per type) */
  display?: { keys: Record<string, DisplayKey[]>; values: typeof DISPLAY_VALUES; defaults: typeof DISPLAY_DEFAULTS; fine_keys?: Record<string, FineKey[]> };
}

export interface PickerProduct {
  id: string;
  title_ar: string;
  title_en: string;
  image_url: string | null;
  status: "ok" | "unpublished" | "sold_out";
}

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api/v1";

export const storeHomeApi = {
  public: (slug: string) => apiFetch<PublicHome>(`/storefronts/${slug}/home`, { auth: false }),
  /** «معلومات المتجر» (the store page's own public read) - for the owner's preview. */
  info: (slug: string) => apiFetch<import("@/components/store-home/StoreInfoSection").StoreInfoDto>(`/storefronts/${slug}/info`, { auth: false }),
  get: (vendorId: string) => apiFetch<OwnerHome>(`/vendors/${vendorId}/storefront/home`),
  save: (vendorId: string, version: number, layout: HomeLayout) =>
    apiFetch<OwnerHome>(`/vendors/${vendorId}/storefront/home/draft`, { method: "PUT", body: { version, layout } }),
  publish: (vendorId: string, version: number) =>
    apiFetch<OwnerHome>(`/vendors/${vendorId}/storefront/home/publish`, { method: "POST", body: { version } }),
  discard: (vendorId: string, version: number) =>
    apiFetch<OwnerHome>(`/vendors/${vendorId}/storefront/home/discard`, { method: "POST", body: { version } }),
  products: (vendorId: string, q: string, page: number) =>
    apiFetch<{ total: number; page: number; page_size: number; items: PickerProduct[] }>(
      `/vendors/${vendorId}/storefront/home/products?q=${encodeURIComponent(q)}&page=${page}`,
    ),
  /** The last pending autosave when the screen goes away (the request outlives the page). */
  saveOnLeave(vendorId: string, version: number, layout: HomeLayout) {
    const path = `/vendors/${vendorId}/storefront/home/draft`;
    try {
      void fetch(`${API}${path}`, {
        method: "PUT",
        keepalive: true,
        headers: { "Content-Type": "application/json", ...authHeadersFor(path) },
        body: JSON.stringify({ version, layout }),
      });
    } catch {
      // nothing more can be done while the page goes away
    }
  },
};

export function newBlockId(): string {
  const r = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "").slice(0, 12) : Math.random().toString(36).slice(2, 14);
  return `b-${r}`;
}

export function pick(lang: string, t: LocalText | null | undefined): string {
  if (!t) return "";
  return lang === "en" && t.en ? t.en : t.ar;
}

/** A banner's cards (the second one only for the double banner). */
export function cardsOf(b: Extract<HomeBlock, { type: "banner" }>): BannerCard[] {
  return b.variant === "double" ? [b, b.second ?? EMPTY_CARD] : [b];
}

/** Every image of a layout (the 20-image limit) - empty places do not count. */
export function imageCount(layout: HomeLayout): number {
  let n = 0;
  for (const b of layout.blocks) {
    if (b.type === "hero") for (const s of b.slides) n += (s.image ? 1 : 0) + (s.image_mobile ? 1 : 0);
    if (b.type === "banner") for (const c of b.second ? [b, b.second] : [b]) n += (c.image ? 1 : 0) + (c.image_mobile ? 1 : 0);
    if (b.type === "category_cards") for (const c of b.items) n += c.image ? 1 : 0;
    if (b.type === "promo_grid") for (const tile of b.tiles) n += tile.image ? 1 : 0;
  }
  return n;
}

/** The recommended sizes (a warning, never a refusal) - the API's own (store-home.quality.ts). */
export const IMAGE_SPECS = {
  hero: { desktop: { w: 1920, h: 640, minW: 1200 }, phone: { w: 1080, h: 1350, minW: 720 } },
  hero_split: { desktop: { w: 1200, h: 1000, minW: 800 }, phone: { w: 1080, h: 1350, minW: 720 } },
  banner: { desktop: { w: 1600, h: 400, minW: 1200 }, phone: { w: 1080, h: 540, minW: 720 } },
  banner_double: { desktop: { w: 1200, h: 600, minW: 700 }, phone: { w: 1080, h: 540, minW: 720 } },
  card_square: { desktop: { w: 800, h: 800, minW: 400 }, phone: { w: 800, h: 800, minW: 400 } },
  card_portrait: { desktop: { w: 800, h: 1000, minW: 400 }, phone: { w: 800, h: 1000, minW: 400 } },
} as const;

/** The crop class of an image (its focus point; "center" = the crop before). */
export function focusClass(f: FocusPoint | undefined): string {
  return `sh-fp-${f ?? "center"}`;
}
export const IMAGE_MAX_GOOD_BYTES = 1.5 * 1024 * 1024;

export type ImageWarning = "small" | "ratio" | "heavy" | "gif" | "unknown_size";

export function imageWarnings(img: HomeImage, spec: { w: number; h: number; minW: number }): ImageWarning[] {
  const out: ImageWarning[] = [];
  if (/\.gif$/i.test(img.url)) out.push("gif");
  if (img.width && img.height) {
    if (img.width < spec.minW) out.push("small");
    const want = spec.w / spec.h;
    const got = img.width / img.height;
    if (Math.abs(got - want) / want > 0.15) out.push("ratio");
  } else out.push("unknown_size");
  if (img.bytes && img.bytes > IMAGE_MAX_GOOD_BYTES) out.push("heavy");
  return out;
}

/** A fresh block of a type, with sensible starting values. */
export function emptyBlock(type: BlockType, image?: HomeImage): HomeBlock | null {
  const b = emptyBlockBody(type, image);
  return b ? { ...b, display: displayOf(type, undefined) } : null;
}
function emptyBlockBody(type: BlockType, image?: HomeImage): HomeBlock | null {
  const id = newBlockId();
  switch (type) {
    case "hero":
      return image ? { id, type, visible: true, variant: "overlay", slides: [{ image, image_mobile: null, title: NO_TEXT, text: NO_TEXT, button: NO_TEXT, target: null, align: "start", alt: NO_TEXT, focus: "center" }] } : null;
    case "banner":
      return image ? { id, type, visible: true, variant: "single", image, image_mobile: null, title: NO_TEXT, text: NO_TEXT, target: null, alt: NO_TEXT, focus: "center", second: null } : null;
    case "collections":
      return { id, type, visible: true, title: NO_TEXT, collection_ids: [] };
    case "products":
      return { id, type, visible: true, variant: "standard", title: NO_TEXT, text: NO_TEXT, offer_ids: [] };
    case "auto_products":
      return { id, type, visible: true, variant: "standard", title: NO_TEXT, text: NO_TEXT, source: "new", count: 8 };
    case "categories":
      return { id, type, visible: true, title: NO_TEXT, items: [] };
    case "text":
      return { id, type, visible: true, style: "text", title: NO_TEXT, text: NO_TEXT };
    case "category_cards":
      return { id, type, visible: true, shape: "circle", title: NO_TEXT, items: [] };
    case "promo_grid":
      // two empty tiles to fill («أضيفي صورة»), side by side
      return { id, type, visible: true, layout: "even", share: 60, divider: "gap", tiles: [{ ...EMPTY_TILE }, { ...EMPTY_TILE }] };
  }
}

/** Whether the shopper is browsing (any search, filter, department, smart filter or collection): the blocks step aside. */
export function scrollToBrowse(): void {
  const el = typeof document !== "undefined" ? document.getElementById("store-browse") : null;
  if (!el) return;
  const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
}
