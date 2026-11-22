// Product-entry wizard (new products only): the draft the wizard edits,
// mirroring the API's offer-drafts/draft-payload.ts. Phase A: the draft
// exists on the server only from the seller's first real information
// (isMeaningful); from then on every change is saved there. Phase A+: five
// flat steps (1 details, 2 colours and images, 3 sizes and measurements,
// 4 stock and price, 5 review and publish); the English name is optional.

import { discountProblem, type DraftDiscount } from "./discountWindow";

/** Phase A: the size system a product's sizes all belong to (the existing platform sizes, grouped). */
export type SizeSystem = "LETTER" | "EU" | "KIDS_AGE" | "ONE_SIZE";
export const SIZE_SYSTEMS: SizeSystem[] = ["LETTER", "EU", "KIDS_AGE", "ONE_SIZE"];

/** Same rule as the API (sizeSystemOf). */
export function sizeSystemOf(code: string): SizeSystem {
  if (code === "ONE_SIZE") return "ONE_SIZE";
  if (code.startsWith("EU_")) return "EU";
  if (code.startsWith("AGE_")) return "KIDS_AGE";
  return "LETTER";
}

/** The systems offered for an audience (age sizes only for children). */
export function sizeSystemsFor(audience: string | null | undefined): SizeSystem[] {
  return audience === "KIDS" ? ["KIDS_AGE", "ONE_SIZE"] : ["LETTER", "EU", "ONE_SIZE"];
}

/** The system suggested for a category (changeable): dresses in EU sizes, accessories one size. */
export function suggestedSizeSystem(audience: string | null | undefined, category: string | null | undefined): SizeSystem {
  if (audience === "KIDS") return "KIDS_AGE";
  const template = category ? CATEGORY_SPEC_TEMPLATE[category] : undefined;
  if (template === "DRESSES") return "EU";
  if (template === "BAGS" || template === "JEWELLERY_WATCHES" || template === "OTHER_ACCESSORIES") return "ONE_SIZE";
  return "LETTER";
}

export type Audience = "WOMEN" | "MEN" | "KIDS";
export const AUDIENCES: Audience[] = ["WOMEN", "MEN", "KIDS"];

export type DraftBrand = { mode: "none" } | { mode: "existing"; brand_id: string } | { mode: "request"; name: string };

/**
 * Product colours: one colour of the product - `key` (stable inside the
 * draft; sizes, stock and SKUs use it), `family` (taxonomy colour, for
 * filters - may repeat), `name_ar` (the shopper's name, unique in the
 * product), optional `name_en`, `hex` and fabric `swatch`. The list order
 * is the seller's; the first colour is the default.
 */
export interface DraftColor {
  key: string;
  family: string | null;
  name_ar: string;
  name_en?: string;
  hex?: string | null;
  swatch?: string | null;
  /** Own upload URLs, in order; [0] is the colour's main image. */
  images: string[];
}

/** The garment measurements (cm) a product's own size table can hold - same keys as the API. */
export type MeasureKey = "CHEST" | "WAIST" | "HIP" | "LENGTH" | "SHOULDER" | "SLEEVE" | "INSEAM" | "FOOT_LENGTH" | "HEIGHT";
/** The seller's table: the chosen measurements and a value (cm) per size and measurement. */
export interface DraftMeasurements {
  keys: MeasureKey[];
  values: Record<string, Partial<Record<MeasureKey, number>>>;
}

import { partTotal, type Composition } from "./composition";
export interface DraftPayload {
  step?: number;
  /** Phase A+: 5 = the five-step numbering (a draft without it used an older one - see stepOf). */
  layout?: 5;
  audience?: Audience | null;
  category?: string | null;
  title_ar?: string;
  title_en?: string;
  brand?: DraftBrand | null;
  specs?: Record<string, string>;
  colors?: DraftColor[];
  sizes?: Record<string, string[]>;
  size_system?: SizeSystem | null;
  /** The product's one price (a classified product has one price for all its colours and sizes). */
  price?: number | null;
  /** Phase A: branch id -> "COLOR|SIZE" -> quantity, explicitly (absent = 0). */
  stock?: Record<string, Record<string, number>>;
  /** Drafts saved before phase A: the quantity of every version per branch, and exceptions. */
  default_stock?: Record<string, number>;
  stock_overrides?: Record<string, Record<string, number>>;
  sku_overrides?: Record<string, string>;
  description_ar?: string;
  description_en?: string;
  /** Phase A+: the garment's own measurements (optional). */
  measurements?: DraftMeasurements | null;
  /** Phase A++: an optional discount on the one price (lib/discountWindow.ts). */
  discount?: DraftDiscount | null;
  /** Phase A++ (item 5): the model's height and the size she wears (one of the product's sizes). */
  model?: { height_cm: number | null; size: string | null } | null;
  /** Phase A++ (item 6): images shared by every colour, after each colour's own (never a main image). */
  shared_images?: string[];
  /** «مجموعات المتجر» (optional): the store's own collections a NEW product joins on publish. */
  sections?: string[];
  /** fabric composition (2026-11-19) - for the whole product; optional */
  composition?: Composition | null;
  /** country of origin: ISO 3166-1 alpha-2; optional */
  country_of_origin?: string | null;
  /** «باركود المنتج للمحل» (needed to publish): a code already on the item, or one generated for this draft («later»: older drafts only) */
  store_barcode?: { mode: "external"; code: string } | { mode: "generate"; code?: string } | { mode: "later" } | null;
}

/** The request behind a typed new brand, as the server reports it. */
export interface DraftBrandRequest {
  id: string;
  name: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "WITHDRAWN";
  brand_id: string | null;
  rejection_reason: string | null;
}

/** Edit drafts: what the draft of a published product knows about it. */
export interface DraftEdit {
  offer_id: string;
  base_revision: number;
  title_ar: string | null;
  /** another team member saved it in the last 5 minutes (never a name) */
  edited_by_other_recently: boolean;
  /** colour keys of the product's existing colours (no removal, family locked) */
  existing_colors: string[];
  /** "COLOR|SIZE" of the existing versions (no removal, stock on the stock screen) */
  existing_versions: string[];
}

/** «مراجعة التعديلات» (GET .../offer-drafts/:id/review). */
export interface EditReview {
  draft_id: string;
  offer_id: string;
  offer_status: "DRAFT" | "ACTIVE" | "INACTIVE" | "ARCHIVED";
  base_revision: number;
  current_revision: number;
  groups: { group: string; before: unknown; after: unknown }[];
  new_colors: string[];
  new_versions: number;
  mixed_images: string[];
  conflict: EditConflict[];
}
export interface EditConflict {
  group: string;
  kind: "elsewhere" | "both";
  current: unknown;
  mine: unknown;
}

export interface DraftDto {
  id: string;
  status: "OPEN" | "SUBMITTED" | "DISCARDED" | "ABANDONED" | "APPLIED";
  edit?: DraftEdit | null;
  revision: number;
  title: string;
  payload: DraftPayload;
  offer_id: string | null;
  brand_request: DraftBrandRequest | null;
  updated_at: string;
}

export const MAX_IMAGES_PER_COLOR = 10;
export const versionKey = (color: string, size: string) => `${color}|${size}`;

/** Same map as the API (CATEGORY_SPEC_TEMPLATE): the specs a category shows. */
export const CATEGORY_SPEC_TEMPLATE: Record<string, SpecTemplate> = {
  DRESSES_WOMEN: "DRESSES", GIRLS_DRESSES: "DRESSES", ABAYAS: "DRESSES", JALABIYAS_KAFTANS: "DRESSES",
  MODEST_WEAR: "DRESSES", MATERNITY: "DRESSES", JUMPSUITS: "DRESSES", OCCASION_WEAR: "DRESSES",
  TOPS: "TOPS_SHIRTS", TSHIRTS: "TOPS_SHIRTS", SHIRTS: "TOPS_SHIRTS", BLOUSES_MEN: "TOPS_SHIRTS",
  KNITWEAR: "TOPS_SHIRTS", CARDIGANS: "TOPS_SHIRTS", HOODIES: "TOPS_SHIRTS", SWEATSHIRTS: "TOPS_SHIRTS",
  TROUSERS: "BOTTOMS", JEANS: "BOTTOMS", SKIRTS: "BOTTOMS", SHORTS: "BOTTOMS", FORMAL_TROUSERS: "BOTTOMS", LEGGINGS: "BOTTOMS",
  JACKETS: "COATS_JACKETS", COATS: "COATS_JACKETS", BLAZERS: "COATS_JACKETS",
  TWO_PIECE_SETS: "SETS_PYJAMAS", MULTI_PIECE_SETS: "SETS_PYJAMAS", SLEEPWEAR: "SETS_PYJAMAS",
  LOUNGEWEAR: "SETS_PYJAMAS", FORMAL_SUITS: "SETS_PYJAMAS",
  NEWBORN: "KIDS_CLOTHING", DUNGAREES: "KIDS_CLOTHING", BABY_BODYSUITS: "KIDS_CLOTHING",
  SHOES: "SHOES", BAGS: "BAGS", WALLETS: "BAGS", JEWELLERY: "JEWELLERY_WATCHES", WATCHES: "JEWELLERY_WATCHES",
  EYEWEAR: "OTHER_ACCESSORIES", BELTS: "OTHER_ACCESSORIES", HATS_CAPS: "OTHER_ACCESSORIES",
  ACCESSORIES: "OTHER_ACCESSORIES", SOCKS: "OTHER_ACCESSORIES", HAIR_ACCESSORIES: "OTHER_ACCESSORIES",
  HIJABS_SHAWLS: "OTHER_ACCESSORIES",
};

export type SpecTemplate =
  | "DRESSES" | "TOPS_SHIRTS" | "BOTTOMS" | "COATS_JACKETS" | "SETS_PYJAMAS"
  | "KIDS_CLOTHING" | "SHOES" | "BAGS" | "JEWELLERY_WATCHES" | "OTHER_ACCESSORIES";

/** Phase A++ (item 4): the clothing templates also take fit, stretch, occasion and care (codes - lib/specCodes.ts). */
const CLOTHING_EXTRA = ["fit", "stretch", "occasion", "care"] as const;
export const SPEC_FIELDS: Record<SpecTemplate, readonly string[]> = {
  DRESSES: ["material", "pattern", "length", "sleeve_type", ...CLOTHING_EXTRA],
  TOPS_SHIRTS: ["material", "pattern", "sleeve_type", ...CLOTHING_EXTRA],
  BOTTOMS: ["material", "pattern", "cut", "length_or_waist", ...CLOTHING_EXTRA],
  COATS_JACKETS: ["material", "pattern", "closure_type", "length", ...CLOTHING_EXTRA],
  SETS_PYJAMAS: ["material", "pattern", "piece_count", "cut", ...CLOTHING_EXTRA],
  KIDS_CLOTHING: ["age_range", "material", "pattern", "detail", ...CLOTHING_EXTRA],
  SHOES: ["upper_material", "closure_type", "sole_type", "size_system"],
  BAGS: ["material", "bag_type", "dimensions", "closure_type"],
  JEWELLERY_WATCHES: ["material", "sub_type", "stone_or_finish", "dimensions"],
  OTHER_ACCESSORIES: ["material", "sub_type", "pattern", "dimensions_or_size"],
};

type Opt = { ar: string; en: string };
const o = (ar: string, en: string): Opt => ({ ar, en });

/** Common choices per specification; «أخرى» lets the seller type anything else. Stored as the Arabic words. */
export const SPEC_OPTIONS: Record<string, Opt[]> = {
  material: [o("قطن", "Cotton"), o("بوليستر", "Polyester"), o("شيفون", "Chiffon"), o("ساتان", "Satin"), o("كريب", "Crepe"), o("حرير", "Silk"), o("كتان", "Linen"), o("صوف", "Wool"), o("جينز", "Denim"), o("فسكوز", "Viscose"), o("جلد", "Leather")],
  upper_material: [o("جلد", "Leather"), o("جلد صناعي", "Faux leather"), o("قماش", "Fabric"), o("شبك", "Mesh"), o("شامواه", "Suede")],
  pattern: [o("سادة", "Plain"), o("مورّد", "Floral"), o("مخطط", "Striped"), o("مربعات", "Checked"), o("منقّط", "Polka dot"), o("مطرّز", "Embroidered"), o("مطبوع", "Printed")],
  length: [o("قصير", "Short"), o("متوسط", "Midi"), o("طويل", "Long")],
  sleeve_type: [o("بلا أكمام", "Sleeveless"), o("أكمام قصيرة", "Short sleeves"), o("أكمام 3/4", "3/4 sleeves"), o("أكمام طويلة", "Long sleeves"), o("أكمام منفوخة", "Puff sleeves")],
  cut: [o("مستقيم", "Straight"), o("ضيّق", "Skinny"), o("واسع", "Wide"), o("كلوش", "Flared")],
  length_or_waist: [o("خصر عالٍ", "High waist"), o("خصر متوسط", "Mid waist"), o("خصر منخفض", "Low waist"), o("طول كامل", "Full length"), o("قصير", "Cropped")],
  closure_type: [o("أزرار", "Buttons"), o("سحّاب", "Zip"), o("رباط", "Laces"), o("لاصق", "Velcro"), o("مغناطيس", "Magnet"), o("بدون إغلاق", "No closure")],
  piece_count: [o("قطعتان", "Two pieces"), o("ثلاث قطع", "Three pieces"), o("أربع قطع", "Four pieces")],
  age_range: [o("حديث الولادة", "Newborn"), o("رضّع", "Baby"), o("أطفال صغار", "Toddler"), o("أطفال", "Kids")],
  detail: [o("تطريز", "Embroidery"), o("دانتيل", "Lace"), o("طبعة", "Print"), o("أزرار زينة", "Decorative buttons")],
  sole_type: [o("مطاط", "Rubber"), o("جلد", "Leather"), o("طبي", "Orthopaedic"), o("كعب عالٍ", "High heel"), o("مسطّح", "Flat")],
  size_system: [o("أوروبي", "EU"), o("بريطاني", "UK"), o("أمريكي", "US")],
  bag_type: [o("حقيبة يد", "Handbag"), o("حقيبة كتف", "Shoulder bag"), o("حقيبة ظهر", "Backpack"), o("محفظة", "Wallet"), o("حقيبة سهرة", "Clutch")],
  sub_type: [o("قلادة", "Necklace"), o("سوار", "Bracelet"), o("خاتم", "Ring"), o("أقراط", "Earrings"), o("ساعة", "Watch"), o("نظارة", "Glasses"), o("حزام", "Belt"), o("قبعة", "Hat")],
  stone_or_finish: [o("ذهبي", "Gold tone"), o("فضي", "Silver tone"), o("زركون", "Zircon"), o("لؤلؤ", "Pearl")],
  dimensions: [],
  dimensions_or_size: [],
};

export function specFieldsFor(category: string | null | undefined): readonly string[] {
  const t = category ? CATEGORY_SPEC_TEMPLATE[category] : undefined;
  return t ? SPEC_FIELDS[t] : [];
}

/** The versions (colour x size) the draft will create. */
export function draftVersions(p: DraftPayload): { color: string; size: string }[] {
  const out: { color: string; size: string }[] = [];
  for (const c of p.colors ?? []) for (const size of p.sizes?.[c.key] ?? []) out.push({ color: c.key, size });
  return out;
}

/** The quantity of one colour x size in one branch (an older draft's default/exceptions read the same way). */
export function stockFor(p: DraftPayload, color: string, size: string, branchId: string): number {
  const key = versionKey(color, size);
  if (p.stock !== undefined) return p.stock[branchId]?.[key] ?? 0;
  const override = p.stock_overrides?.[key]?.[branchId];
  return override ?? p.default_stock?.[branchId] ?? 0;
}

/**
 * Sets one colour x size x branch quantity. An older draft (default per
 * branch + exceptions) is first written out explicitly for every colour x
 * size x branch, so nothing it meant is lost - then only this one changes.
 */
export function withQuantity(p: DraftPayload, branchIds: string[], color: string, size: string, branchId: string, q: number): DraftPayload {
  return withQuantities(p, branchIds, [{ color, size, branchId, q }]);
}

export function withQuantities(
  p: DraftPayload,
  branchIds: string[],
  changes: { color: string; size: string; branchId: string; q: number }[],
): DraftPayload {
  let stock: Record<string, Record<string, number>>;
  if (p.stock !== undefined) {
    stock = Object.fromEntries(Object.entries(p.stock).map(([b, per]) => [b, { ...per }]));
  } else {
    stock = {};
    for (const b of branchIds) {
      for (const v of draftVersions(p)) {
        const q = stockFor(p, v.color, v.size, b);
        if (q > 0) (stock[b] ??= {})[versionKey(v.color, v.size)] = q;
      }
    }
  }
  for (const c of changes) {
    const per = (stock[c.branchId] ??= {});
    const key = versionKey(c.color, c.size);
    if (c.q > 0) per[key] = c.q;
    else delete per[key];
  }
  const next: DraftPayload = { ...p, stock };
  delete next.default_stock;
  delete next.stock_overrides;
  return next;
}

/** Every size the product will have (the union over its colours), in first-seen order. */
export function draftSizes(p: DraftPayload): string[] {
  return [...new Set(draftVersions(p).map((v) => v.size))];
}

/**
 * Removes everything about colour x size pairs that no longer exist (stock,
 * SKUs) and the measurements of sizes the product no longer has, or of
 * measurements its category does not take.
 */
export function pruneVersions(p: DraftPayload): DraftPayload {
  const keep = new Set(draftVersions(p).map((v) => versionKey(v.color, v.size)));
  const next: DraftPayload = { ...p };
  if (p.stock) {
    next.stock = Object.fromEntries(
      Object.entries(p.stock).map(([b, per]) => [b, Object.fromEntries(Object.entries(per).filter(([k]) => keep.has(k)))]),
    );
  }
  if (p.sku_overrides) next.sku_overrides = Object.fromEntries(Object.entries(p.sku_overrides).filter(([k]) => keep.has(k)));
  return pruneMeasurements(next);
}

/** The measurements of sizes the product no longer has, or of keys its category does not take, are removed. */
export function pruneMeasurements(p: DraftPayload): DraftPayload {
  if (!p.measurements) return p;
  const sizes = new Set(draftSizes(p));
  const allowed = measureKeysFor(p.category, p.audience);
  const keys = p.measurements.keys.filter((k) => allowed.includes(k));
  const values: DraftMeasurements["values"] = {};
  for (const [size, row] of Object.entries(p.measurements.values)) {
    if (!sizes.has(size)) continue;
    const kept = Object.fromEntries(Object.entries(row).filter(([k, v]) => keys.includes(k as MeasureKey) && typeof v === "number"));
    if (Object.keys(kept).length) values[size] = kept;
  }
  return { ...p, measurements: keys.length ? { keys, values } : null };
}

// ------------------------------------------------------------- measurements

const DRESS_KEYS: MeasureKey[] = ["CHEST", "WAIST", "HIP", "LENGTH"];
const TOP_KEYS: MeasureKey[] = ["CHEST", "SHOULDER", "SLEEVE", "LENGTH"];
const BOTTOM_KEYS: MeasureKey[] = ["WAIST", "HIP", "INSEAM", "LENGTH"];
const KIDS_KEYS: MeasureKey[] = ["HEIGHT", "CHEST", "WAIST", "LENGTH"];
const KEYS_BY_CATEGORY: Record<string, MeasureKey[]> = {
  TOPS: TOP_KEYS, TSHIRTS: TOP_KEYS, SHIRTS: TOP_KEYS, BLOUSES_MEN: TOP_KEYS, JACKETS: TOP_KEYS, COATS: TOP_KEYS,
  BLAZERS: TOP_KEYS, CARDIGANS: TOP_KEYS, HOODIES: TOP_KEYS, SWEATSHIRTS: TOP_KEYS, KNITWEAR: TOP_KEYS,
  TROUSERS: BOTTOM_KEYS, FORMAL_TROUSERS: BOTTOM_KEYS, JEANS: BOTTOM_KEYS, SHORTS: BOTTOM_KEYS, LEGGINGS: BOTTOM_KEYS,
  SKIRTS: ["WAIST", "HIP", "LENGTH"],
  SHOES: ["FOOT_LENGTH"],
};
/** Same list as the API (NON_SIZED_CATEGORIES): accessories take no size table. */
const NON_SIZED = new Set(["BAGS", "JEWELLERY", "WATCHES", "EYEWEAR", "BELTS", "HIJABS_SHAWLS", "HATS_CAPS", "ACCESSORIES", "SOCKS", "WALLETS", "HAIR_ACCESSORIES"]);

/** Same rule as the API (measureKeysFor): the measurements a product of this category can list. */
export function measureKeysFor(category: string | null | undefined, audience: string | null | undefined): MeasureKey[] {
  if (!category || NON_SIZED.has(category)) return [];
  if (category === "SHOES") return ["FOOT_LENGTH"];
  if (audience === "KIDS") return KIDS_KEYS;
  return KEYS_BY_CATEGORY[category] ?? DRESS_KEYS;
}

/** Plausible range per measurement, in cm - same as the API (MEASURE_LIMITS_CM). */
export const MEASURE_LIMITS_CM: Record<MeasureKey, [number, number]> = {
  CHEST: [40, 200], WAIST: [30, 200], HIP: [40, 220], LENGTH: [20, 200], SHOULDER: [25, 70],
  SLEEVE: [20, 100], INSEAM: [20, 110], FOOT_LENGTH: [8, 35], HEIGHT: [40, 180],
};

/** Same rule as the API: no measurement chosen = no table; choosing one starts it. */
export function measurementsEmpty(m: DraftMeasurements | null | undefined): boolean {
  return !m || (m.keys ?? []).length === 0;
}

/** The cells still empty: every size of the product x every CHOSEN measurement (an unchosen one is never required). */
export function missingMeasurements(p: DraftPayload): { size: string; key: MeasureKey }[] {
  const m = p.measurements;
  if (measurementsEmpty(m)) return [];
  const out: { size: string; key: MeasureKey }[] = [];
  for (const size of draftSizes(p)) for (const key of m!.keys) if (typeof m!.values[size]?.[key] !== "number") out.push({ size, key });
  return out;
}

// ------------------------------------------------------------- steps

/**
 * The step a draft is on, in the five-step numbering. A draft saved before
 * phase A+ used another one: phase A (three steps, its shape has `stock` or
 * `size_system`): 1, 2, 3=review; before that (four steps): 1, 2, 3=sizes
 * and stock, 4=review.
 */
export function stepOf(p: DraftPayload): number {
  const s = p.step ?? 1;
  if (p.layout === 5) return Math.min(5, Math.max(1, s));
  const phaseA = p.stock !== undefined || Boolean(p.size_system);
  const map: Record<number, number> = phaseA ? { 1: 1, 2: 2, 3: 5 } : { 1: 1, 2: 2, 3: 3, 4: 5 };
  return map[s] ?? 1;
}

/**
 * Whether the seller has entered real information yet (a name, an image,
 * a colour, a size, a specification, a description, a brand, a price or a
 * quantity). The audience / category coming from the list the wizard was
 * opened from (or chosen alone), the step and the size system are not.
 */
export function isMeaningful(p: DraftPayload): boolean {
  const text = (v: string | undefined) => Boolean((v ?? "").trim());
  return (
    text(p.title_ar) ||
    text(p.title_en) ||
    text(p.description_ar) ||
    text(p.description_en) ||
    (p.colors?.length ?? 0) > 0 ||
    Object.values(p.sizes ?? {}).some((l) => l.length > 0) ||
    Object.keys(p.specs ?? {}).length > 0 ||
    Boolean(p.brand) ||
    Boolean(p.price) ||
    Object.values(p.stock ?? {}).some((per) => Object.values(per).some((q) => q > 0)) ||
    Object.values(p.default_stock ?? {}).some((q) => q > 0) ||
    Object.keys(p.sku_overrides ?? {}).length > 0 ||
    !measurementsEmpty(p.measurements)
  );
}

export type DraftProblem = { code: string; step: number };

/** What still prevents creating the product, as the API words it (code + step: 1 details, 2 colours and images, 3 sizes and measurements, 4 stock and price). */
export function draftProblems(p: DraftPayload): DraftProblem[] {
  const problems: DraftProblem[] = [];
  if (!p.audience) problems.push({ code: "AUDIENCE_REQUIRED", step: 1 });
  if (!p.category) problems.push({ code: "CATEGORY_REQUIRED", step: 1 });
  if (!(p.title_ar ?? "").trim()) problems.push({ code: "TITLE_AR_REQUIRED", step: 1 });
  if (!p.brand) problems.push({ code: "BRAND_REQUIRED", step: 1 });
  else if (p.brand.mode === "request" && !p.brand.name.trim()) problems.push({ code: "BRAND_NAME_REQUIRED", step: 1 });
  const colors = p.colors ?? [];
  if (colors.length === 0) problems.push({ code: "COLOR_REQUIRED", step: 2 });
  for (const c of colors) if (!c.family) problems.push({ code: `COLOR_FAMILY_REQUIRED:${c.key}`, step: 2 });
  for (const c of colors) if (!c.name_ar.trim()) problems.push({ code: `COLOR_NAME_REQUIRED:${c.key}`, step: 2 });
  for (const c of colors) if (c.images.length === 0) problems.push({ code: `COLOR_IMAGE_REQUIRED:${c.key}`, step: 2 });
  for (const c of colors) if ((p.sizes?.[c.key] ?? []).length === 0) problems.push({ code: `COLOR_SIZE_REQUIRED:${c.key}`, step: 3 });
  const systems = new Set(Object.values(p.sizes ?? {}).flat().map(sizeSystemOf));
  if (p.size_system ? [...systems].some((s) => s !== p.size_system) : systems.size > 1) problems.push({ code: "SIZE_SYSTEM_MIXED", step: 3 });
  if (!p.price) problems.push({ code: "PRICE_REQUIRED", step: 4 });
  const discount = discountProblem(p.price, p.discount);
  if (discount) problems.push({ code: `DISCOUNT:${discount}`, step: 4 });
  // the composition, once entered: each part complete and totalling 100% (the API's rule)
  for (const part of p.composition?.parts ?? []) {
    if (part.fibers.some((f) => f.percent === null)) problems.push({ code: `COMPOSITION_PERCENT:${part.part}`, step: 1 });
    if (part.fibers.some((f) => f.fiber === "OTHER" && !f.other_ar?.trim())) problems.push({ code: `COMPOSITION_OTHER:${part.part}`, step: 1 });
    if (partTotal(part) !== 100) problems.push({ code: `COMPOSITION_SUM:${part.part}`, step: 1 });
  }
  return problems;
}

/**
 * What the page can tell by itself before the server's publish check
 * answers (that check decides once it has): the create problems, a table
 * started but incomplete, and no stock at all.
 */
export function localPublishProblems(p: DraftPayload): DraftProblem[] {
  const problems = draftProblems(p);
  if (missingMeasurements(p).length > 0) problems.push({ code: "MEASUREMENTS:SIZE_GUIDE_INCOMPLETE", step: 3 });
  const versions = draftVersions(p);
  const total = Object.values(p.stock ?? {}).reduce((n, per) => n + Object.values(per).reduce((a, q) => a + q, 0), 0) +
    (p.stock === undefined ? Object.values(p.default_stock ?? {}).reduce((a, q) => a + q, 0) : 0);
  if (versions.length > 0 && total <= 0) problems.push({ code: "STOCK_REQUIRED", step: 4 });
  return problems;
}

/** The server's read-only publish check (GET .../offer-drafts/:id/publish-check). */
export interface PublishCheck {
  draft_id: string;
  revision: number;
  status: DraftDto["status"];
  offer_id: string | null;
  ready: boolean;
  problems: DraftProblem[];
  hints: DraftProblem[];
}
