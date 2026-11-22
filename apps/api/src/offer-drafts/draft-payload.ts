import {
  compositionProblems,
  normaliseComposition,
  normaliseCountry,
  type Composition,
} from '../offers/composition';
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  COLOR_NAME_MAX,
  MAX_PRODUCT_COLORS,
  normalizeColorName,
} from '../offers/color-name';
import { resolveUnifiedPrice } from '../offers/pricing/unified-price.util';
import {
  ClothingCategoryTemplate,
  ProductAudience,
} from '../../generated/prisma/client';
import {
  CLOTHING_CATEGORY_TEMPLATE_FIELDS,
  validateTemplateAttributes,
} from '../offers/catalog/clothing-category-templates';
import {
  OfferMeasurementsInput,
  parseMeasurementsInput,
  SizeGuideRuleError,
} from '../size-guides/size-guide-rules';
import {
  MAX_SHARED_IMAGES,
  MODEL_SIZE_MAX,
  modelProblem,
} from '../offers/offer-presentation';

/**
 * Product-entry wizard: what a draft holds while the seller fills it in.
 * Everything is optional while drafting (a draft may be saved after any
 * keystroke); completeness is checked only when the product is created
 * (`draftProblems`). The shape is checked and normalised on every save so
 * a draft can never hold something the create step could not use.
 *
 * Colours and sizes: the seller picks colours (each with its own ordered
 * images - the first is the main one) and, per colour, the sizes it comes
 * in. Every colour x size picked becomes one sellable product version
 * ("variant") when the product is created; the seller never types them.
 */

export type DraftBrand =
  | { mode: 'none' }
  | { mode: 'existing'; brand_id: string }
  | { mode: 'request'; name: string };

/**
 * Phase A++ (item 7): the product's discount, in the system's two existing
 * modes (resolveUnifiedPrice - nothing parallel): a sale price, immediate
 * and without dates; or a percentage for a window with a start and an end.
 * Applied to every version of the product at once, like its one price.
 */
export type DraftDiscount =
  | { mode: 'sale'; sale_price: number | null }
  | {
      mode: 'window';
      percent: number | null;
      start_at: string | null;
      end_at: string | null;
    };

/** The discount as resolveUnifiedPrice / PUT .../price take it. */
export function discountFields(d: DraftDiscount | null | undefined): {
  sale_price?: number;
  discount_percent?: number;
  discount_start_at?: string;
  discount_end_at?: string;
} {
  if (!d) return {};
  return d.mode === 'sale'
    ? { sale_price: d.sale_price ?? undefined }
    : {
        discount_percent: d.percent ?? undefined,
        discount_start_at: d.start_at || undefined,
        discount_end_at: d.end_at || undefined,
      };
}

/** Phase A++ (item 5): the model in the photos - optional; unfinished values are kept. */
export interface DraftModel {
  height_cm: number | null;
  size: string | null;
}

/**
 * Product colours: one colour of the product being entered. `key` is its
 * stable key inside the draft (sizes, stock and SKUs are keyed by it - a
 * draft saved before product colours used the family code as the key, and
 * still reads the same); `family` is the taxonomy colour (filters and
 * discovery, may repeat); `name_ar` the free name the shopper sees (unique
 * inside the product after normalizeColorName - a clash is refused with
 * COLOR_NAME_TAKEN, never dropped); `name_en` optional (empty: the English
 * interface shows name_ar); `hex` and `swatch` optional. The order of the
 * list is the seller's order; the first is the default colour.
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

/**
 * Wizard phase A: the size system the seller picks first (the existing
 * platform sizes, grouped) - every size of a product belongs to it.
 */
export const SIZE_SYSTEMS = ['LETTER', 'EU', 'KIDS_AGE', 'ONE_SIZE'] as const;
export type SizeSystem = (typeof SIZE_SYSTEMS)[number];

/** Which system a platform size code belongs to. */
export function sizeSystemOf(code: string): SizeSystem {
  if (code === 'ONE_SIZE') return 'ONE_SIZE';
  if (code.startsWith('EU_')) return 'EU';
  if (code.startsWith('AGE_')) return 'KIDS_AGE';
  return 'LETTER';
}

export interface DraftPayload {
  step?: number;
  /** Phase A+: 5 = the five-step wizard's numbering (a draft without it used an older one). */
  layout?: 5;
  audience?: ProductAudience | null;
  category?: string | null;
  title_ar?: string;
  title_en?: string;
  brand?: DraftBrand | null;
  /** Only the specifications the seller knows (no "N/A"). */
  specs?: Record<string, string>;
  colors?: DraftColor[];
  /** Colour code -> the size codes it comes in. */
  sizes?: Record<string, string[]>;
  /** The size system every size of this product belongs to (phase A). */
  size_system?: SizeSystem | null;
  /**
   * The ONE price of every colour x size: a classified product has one
   * price for the whole product (Sprint 27 rule, also enforced by the
   * database) - prices per colour would need that rule changed (phase B).
   */
  price?: number | null;
  /**
   * Phase A - the opening stock, explicitly: branch id -> "COLOR|SIZE" ->
   * quantity. When present it is the ONLY stock source (an absent entry is 0).
   */
  stock?: Record<string, Record<string, number>>;
  /** Before phase A (still read for drafts saved then): branch id -> the quantity of every version. */
  default_stock?: Record<string, number>;
  /** Before phase A: "COLOR|SIZE" -> branch id -> quantity (only what differs). */
  stock_overrides?: Record<string, Record<string, number>>;
  /** "COLOR|SIZE" -> the seller's own SKU (optional; generated otherwise). */
  sku_overrides?: Record<string, string>;
  description_ar?: string;
  description_en?: string;
  /** Phase A+: the garment's own measurements (cm) per size - optional. */
  measurements?: OfferMeasurementsInput | null;
  /** Phase A++: an optional discount on the one price. */
  discount?: DraftDiscount | null;
  /** Phase A++ (item 5): the model's height and the size she wears (one of the product's sizes). */
  model?: DraftModel | null;
  /** Phase A++ (item 6): images shared by every colour - never a colour's main image. */
  shared_images?: string[];
  /**
   * «مجموعات المتجر» (optional): the store's own collections the new product
   * joins on publish (added last in each). An edit of a published product
   * never carries this - its collections are changed directly.
   */
  sections?: string[];
  /**
   * Fabric composition (2026-11-19): per part (shell, lining, filling,
   * trim), its fibres and percents - for the whole product. Optional; a
   * part with fibres must total 100% to publish (offers/composition.ts).
   */
  composition?: Composition | null;
  /** Country of origin: an ISO 3166-1 alpha-2 code (optional). */
  country_of_origin?: string | null;
  /**
   * «باركود المنتج للمحل» (2026-11-20): a code already on the item (kept
   * exactly as typed - the publish check reads it) or one the system
   * generated for this draft (reserved from the store's counter when the
   * owner asked, so she sees and can print it at once). Never needed to SAVE
   * a draft; needed to PUBLISH a new product from the wizard while the
   * store's barcodes are on (STORE_BARCODE:BARCODE_MISSING). An invalid or
   * already-used code is a named problem, never dropped silently. A NEW
   * product's only - an edit manages codes directly. ("later" and a
   * generate without its code are read from older drafts only.)
   */
  store_barcode?: DraftStoreBarcode | null;
}

export type DraftStoreBarcode =
  | { mode: 'external'; code: string }
  | { mode: 'generate'; code?: string }
  | { mode: 'later' };

export const MAX_COLORS = MAX_PRODUCT_COLORS;
const COLOR_KEY = /^[A-Za-z0-9_-]{1,40}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
export const MAX_SIZES_PER_COLOR = 30;
/** Same per-version image limit as OfferVariantMedia (MEDIA_LIMITS.IMAGE). */
export const MAX_IMAGES_PER_COLOR = 10;
export const MAX_TITLE = 200;
const MAX_DESCRIPTION = 4000;
const MAX_SPEC = 120;
const MAX_SKU = 64;
const MAX_QUANTITY = 100_000;
const MAX_PRICE = 1_000_000;

export const versionKey = (color: string, size: string) => `${color}|${size}`;

/**
 * The specification fields shown for a product category - the existing
 * clothing templates, chosen for the seller from the category (the seller
 * never sees "template"). A category not listed has no specifications.
 */
export const CATEGORY_SPEC_TEMPLATE: Record<string, ClothingCategoryTemplate> =
  {
    DRESSES_WOMEN: 'DRESSES',
    GIRLS_DRESSES: 'DRESSES',
    ABAYAS: 'DRESSES',
    JALABIYAS_KAFTANS: 'DRESSES',
    MODEST_WEAR: 'DRESSES',
    MATERNITY: 'DRESSES',
    JUMPSUITS: 'DRESSES',
    OCCASION_WEAR: 'DRESSES',
    TOPS: 'TOPS_SHIRTS',
    TSHIRTS: 'TOPS_SHIRTS',
    SHIRTS: 'TOPS_SHIRTS',
    BLOUSES_MEN: 'TOPS_SHIRTS',
    KNITWEAR: 'TOPS_SHIRTS',
    CARDIGANS: 'TOPS_SHIRTS',
    HOODIES: 'TOPS_SHIRTS',
    SWEATSHIRTS: 'TOPS_SHIRTS',
    TROUSERS: 'BOTTOMS',
    JEANS: 'BOTTOMS',
    SKIRTS: 'BOTTOMS',
    SHORTS: 'BOTTOMS',
    FORMAL_TROUSERS: 'BOTTOMS',
    LEGGINGS: 'BOTTOMS',
    JACKETS: 'COATS_JACKETS',
    COATS: 'COATS_JACKETS',
    BLAZERS: 'COATS_JACKETS',
    TWO_PIECE_SETS: 'SETS_PYJAMAS',
    MULTI_PIECE_SETS: 'SETS_PYJAMAS',
    SLEEPWEAR: 'SETS_PYJAMAS',
    LOUNGEWEAR: 'SETS_PYJAMAS',
    FORMAL_SUITS: 'SETS_PYJAMAS',
    NEWBORN: 'KIDS_CLOTHING',
    DUNGAREES: 'KIDS_CLOTHING',
    BABY_BODYSUITS: 'KIDS_CLOTHING',
    SHOES: 'SHOES',
    BAGS: 'BAGS',
    WALLETS: 'BAGS',
    JEWELLERY: 'JEWELLERY_WATCHES',
    WATCHES: 'JEWELLERY_WATCHES',
    EYEWEAR: 'OTHER_ACCESSORIES',
    BELTS: 'OTHER_ACCESSORIES',
    HATS_CAPS: 'OTHER_ACCESSORIES',
    ACCESSORIES: 'OTHER_ACCESSORIES',
    SOCKS: 'OTHER_ACCESSORIES',
    HAIR_ACCESSORIES: 'OTHER_ACCESSORIES',
    HIJABS_SHAWLS: 'OTHER_ACCESSORIES',
  };

function invalid(message: string): BadRequestException {
  return new BadRequestException({ code: 'DRAFT_INVALID', message });
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function text(v: unknown, field: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw invalid(`${field} must be text`);
  if (v.length > max)
    throw invalid(`${field} is longer than ${max} characters`);
  return v;
}

function quantity(v: unknown, field: string): number {
  if (
    typeof v !== 'number' ||
    !Number.isInteger(v) ||
    v < 0 ||
    v > MAX_QUANTITY
  ) {
    throw invalid(`${field} must be a whole number from 0 to ${MAX_QUANTITY}`);
  }
  return v;
}

function money(v: unknown, field: string): number {
  if (typeof v !== 'number' || !(v > 0) || v > MAX_PRICE) {
    throw invalid(`${field} must be greater than 0`);
  }
  return Math.round(v * 100) / 100;
}

function branchQuantities(v: unknown, field: string): Record<string, number> {
  if (!isRecord(v)) throw invalid(`${field} must be an object`);
  const out: Record<string, number> = {};
  for (const [branch, q] of Object.entries(v))
    out[branch] = quantity(q, `${field}.${branch}`);
  return out;
}

/**
 * Checks the shape of a saved draft and returns it normalised (unknown
 * keys dropped, blank specifications removed, duplicate colours/sizes
 * collapsed). Codes (audience, category, colour, size, branch, brand) are
 * checked against the platform when the product is created.
 * `ownUpload(url)` returns a problem for an image that is not this store's
 * own upload.
 */
export function normaliseDraftPayload(
  raw: unknown,
  ownUpload: (url: string) => string | null,
  /** A family's names - name the colours of a draft saved before product colours (both, as the migration does). */
  familyName: (code: string) => { ar: string; en: string } | null = () => null,
): DraftPayload {
  if (!isRecord(raw)) throw invalid('payload must be an object');
  const out: DraftPayload = {};

  if (raw.step !== undefined) {
    if (![1, 2, 3, 4, 5].includes(raw.step as number))
      throw invalid('step must be 1-5');
    out.step = raw.step as number;
  }
  if (raw.layout !== undefined && raw.layout !== null) {
    if (raw.layout !== 5) throw invalid('layout must be 5');
    out.layout = 5;
  }
  if (raw.audience !== undefined && raw.audience !== null) {
    if (!['WOMEN', 'MEN', 'KIDS'].includes(raw.audience as string)) {
      throw invalid('audience must be WOMEN, MEN or KIDS');
    }
    out.audience = raw.audience as ProductAudience;
  }
  if (raw.category !== undefined && raw.category !== null) {
    out.category = text(raw.category, 'category', 64);
  }
  out.title_ar = text(raw.title_ar, 'title_ar', MAX_TITLE);
  out.title_en = text(raw.title_en, 'title_en', MAX_TITLE);
  out.description_ar = text(
    raw.description_ar,
    'description_ar',
    MAX_DESCRIPTION,
  );
  out.description_en = text(
    raw.description_en,
    'description_en',
    MAX_DESCRIPTION,
  );

  if (raw.brand !== undefined && raw.brand !== null) {
    const b = raw.brand;
    if (!isRecord(b)) throw invalid('brand must be an object');
    if (b.mode === 'none') out.brand = { mode: 'none' };
    else if (
      b.mode === 'existing' &&
      typeof b.brand_id === 'string' &&
      b.brand_id
    ) {
      out.brand = { mode: 'existing', brand_id: b.brand_id };
    } else if (b.mode === 'request') {
      const name = text(b.name, 'brand.name', 80) ?? '';
      out.brand = { mode: 'request', name };
    } else throw invalid('brand.mode must be none, existing or request');
  }

  if (raw.specs !== undefined) {
    if (!isRecord(raw.specs)) throw invalid('specs must be an object');
    const specs: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.specs)) {
      const value = text(v, `specs.${k}`, MAX_SPEC);
      if (value !== undefined && value.trim()) specs[k] = value.trim();
    }
    out.specs = specs;
  }

  if (raw.colors !== undefined) {
    if (!Array.isArray(raw.colors)) throw invalid('colors must be a list');
    if (raw.colors.length > MAX_COLORS)
      throw invalid(`at most ${MAX_COLORS} colours`);
    const seen = new Set<string>();
    const names = new Map<string, string>();
    out.colors = [];
    for (const c of raw.colors) {
      if (!isRecord(c)) throw invalid('each colour must be an object');
      // A draft saved before product colours: { code, images } - its family
      // code is its key and its family, and the family's name its name.
      const legacy = c.key === undefined && typeof c.code === 'string';
      const key = legacy ? c.code : c.key;
      if (typeof key !== 'string' || !COLOR_KEY.test(key))
        throw invalid('each colour needs a key (letters, digits, - or _)');
      if (seen.has(key)) throw invalid(`colour key ${key} is used twice`);
      seen.add(key);
      const family = legacy ? (c.code as string) : c.family;
      if (
        family !== null &&
        family !== undefined &&
        (typeof family !== 'string' || !family)
      )
        throw invalid('colour family must be a colour code');
      const nameAr = legacy
        ? (familyName(key)?.ar ?? '')
        : (text(c.name_ar, 'colour name_ar', COLOR_NAME_MAX) ?? '').trim();
      const nameEn = legacy
        ? familyName(key)?.en || undefined
        : (text(c.name_en, 'colour name_en', COLOR_NAME_MAX) ?? '').trim() ||
          undefined;
      let hex: string | null = null;
      if (!legacy && c.hex !== undefined && c.hex !== null && c.hex !== '') {
        if (typeof c.hex !== 'string' || !HEX.test(c.hex))
          throw invalid('colour hex must be like #a1b2c3');
        hex = c.hex.toLowerCase();
      }
      let swatch: string | null = null;
      if (
        !legacy &&
        c.swatch !== undefined &&
        c.swatch !== null &&
        c.swatch !== ''
      ) {
        if (typeof c.swatch !== 'string')
          throw invalid('colour swatch must be an image URL');
        const problem = ownUpload(c.swatch);
        if (problem) {
          throw new BadRequestException({
            code: 'UPLOAD_NOT_USABLE',
            message: problem,
          });
        }
        swatch = c.swatch;
      }
      // One name per product, after normalisation - refused, never dropped.
      if (nameAr) {
        const nameKey = normalizeColorName(nameAr);
        const other = names.get(nameKey);
        if (other !== undefined) {
          throw new ConflictException({
            code: 'COLOR_NAME_TAKEN',
            message: `Two colours of this product are both named "${nameAr}"`,
            details: [{ key, name_ar: nameAr, same_as: other }],
          });
        }
        names.set(nameKey, key);
      }
      const images = c.images === undefined ? [] : c.images;
      if (!Array.isArray(images)) throw invalid('colour images must be a list');
      if (images.length > MAX_IMAGES_PER_COLOR) {
        throw invalid(`at most ${MAX_IMAGES_PER_COLOR} images per colour`);
      }
      const urls: string[] = [];
      for (const url of images) {
        if (typeof url !== 'string' || !url)
          throw invalid('an image must be a URL');
        const problem = ownUpload(url);
        if (problem) {
          throw new BadRequestException({
            code: 'UPLOAD_NOT_USABLE',
            message: problem,
          });
        }
        if (!urls.includes(url)) urls.push(url);
      }
      out.colors.push({
        key,
        family: (family as string | null | undefined) ?? null,
        name_ar: nameAr,
        ...(nameEn ? { name_en: nameEn } : {}),
        ...(hex ? { hex } : {}),
        ...(swatch ? { swatch } : {}),
        images: urls,
      });
    }
  }

  if (raw.sizes !== undefined) {
    if (!isRecord(raw.sizes)) throw invalid('sizes must be an object');
    out.sizes = {};
    for (const [color, list] of Object.entries(raw.sizes)) {
      if (
        !Array.isArray(list) ||
        list.some((s) => typeof s !== 'string' || !s)
      ) {
        throw invalid(`sizes.${color} must be a list of size codes`);
      }
      if (list.length > MAX_SIZES_PER_COLOR)
        throw invalid(`at most ${MAX_SIZES_PER_COLOR} sizes per colour`);
      out.sizes[color] = [...new Set(list as string[])];
    }
  }

  if (raw.price !== undefined && raw.price !== null) {
    out.price = money(raw.price, 'price');
  }
  if (raw.size_system !== undefined && raw.size_system !== null) {
    if (!SIZE_SYSTEMS.includes(raw.size_system as SizeSystem)) {
      throw invalid(`size_system must be one of ${SIZE_SYSTEMS.join(', ')}`);
    }
    out.size_system = raw.size_system as SizeSystem;
  }
  if (raw.stock !== undefined) {
    if (!isRecord(raw.stock)) throw invalid('stock must be an object');
    out.stock = {};
    for (const [branch, per] of Object.entries(raw.stock)) {
      out.stock[branch] = branchQuantities(per, `stock.${branch}`);
    }
  }
  if (raw.default_stock !== undefined)
    out.default_stock = branchQuantities(raw.default_stock, 'default_stock');
  if (raw.stock_overrides !== undefined) {
    if (!isRecord(raw.stock_overrides))
      throw invalid('stock_overrides must be an object');
    out.stock_overrides = {};
    for (const [key, v] of Object.entries(raw.stock_overrides)) {
      out.stock_overrides[key] = branchQuantities(v, `stock_overrides.${key}`);
    }
  }
  if (raw.sku_overrides !== undefined) {
    if (!isRecord(raw.sku_overrides))
      throw invalid('sku_overrides must be an object');
    out.sku_overrides = {};
    for (const [key, v] of Object.entries(raw.sku_overrides)) {
      const sku = text(v, `sku_overrides.${key}`, MAX_SKU);
      if (sku && sku.trim()) out.sku_overrides[key] = sku.trim();
    }
  }
  if (raw.discount !== undefined) {
    // A draft may hold an unfinished discount (a value not typed yet); the
    // publish check names what is missing (draftProblems).
    if (raw.discount === null) out.discount = null;
    else {
      const d = raw.discount;
      if (!isRecord(d)) throw invalid('discount must be an object');
      const optMoney = (v: unknown, field: string) =>
        v === null || v === undefined ? null : money(v, field);
      const optDate = (v: unknown, field: string) => {
        if (v === null || v === undefined || v === '') return null;
        if (typeof v !== 'string' || Number.isNaN(new Date(v).getTime()))
          throw invalid(`${field} must be a date`);
        return v;
      };
      if (d.mode === 'sale') {
        out.discount = {
          mode: 'sale',
          sale_price: optMoney(d.sale_price, 'discount.sale_price'),
        };
      } else if (d.mode === 'window') {
        if (
          d.percent !== null &&
          d.percent !== undefined &&
          (typeof d.percent !== 'number' || !Number.isFinite(d.percent))
        )
          throw invalid('discount.percent must be a number');
        out.discount = {
          mode: 'window',
          percent: (d.percent as number | null | undefined) ?? null,
          start_at: optDate(d.start_at, 'discount.start_at'),
          end_at: optDate(d.end_at, 'discount.end_at'),
        };
      } else throw invalid('discount.mode must be sale or window');
    }
  }
  if (raw.model !== undefined) {
    if (raw.model === null) out.model = null;
    else {
      const m = raw.model;
      if (!isRecord(m)) throw invalid('model must be an object');
      const h = m.height_cm;
      if (
        h !== null &&
        h !== undefined &&
        (typeof h !== 'number' || !Number.isInteger(h) || h < 0 || h > 1000)
      )
        throw invalid('model.height_cm must be a whole number of cm');
      const size =
        m.size === null || m.size === undefined
          ? null
          : (text(m.size, 'model.size', MODEL_SIZE_MAX) ?? '').trim() || null;
      out.model = { height_cm: (h as number | null | undefined) ?? null, size };
    }
  }
  if (raw.shared_images !== undefined) {
    const list = raw.shared_images;
    if (!Array.isArray(list)) throw invalid('shared_images must be a list');
    if (list.length > MAX_SHARED_IMAGES)
      throw invalid(`at most ${MAX_SHARED_IMAGES} shared images`);
    const urls: string[] = [];
    for (const url of list) {
      if (typeof url !== 'string' || !url)
        throw invalid('an image must be a URL');
      const problem = ownUpload(url);
      if (problem) {
        throw new BadRequestException({
          code: 'UPLOAD_NOT_USABLE',
          message: problem,
        });
      }
      if (!urls.includes(url)) urls.push(url);
    }
    out.shared_images = urls;
  }
  if (raw.sections !== undefined) {
    const list = raw.sections;
    if (!Array.isArray(list)) throw invalid('sections must be a list');
    if (list.length > 20) throw invalid('at most 20 collections');
    const ids: string[] = [];
    for (const id of list) {
      if (typeof id !== 'string' || !id || id.length > 64)
        throw invalid('a collection must be an id');
      if (!ids.includes(id)) ids.push(id);
    }
    out.sections = ids;
  }
  // fabric composition and country of origin: the shape now, the 100% at publishing
  if (raw.composition !== undefined)
    out.composition = normaliseComposition(raw.composition);
  if (raw.country_of_origin !== undefined)
    out.country_of_origin = normaliseCountry(raw.country_of_origin);
  if (raw.store_barcode !== undefined) {
    const b = raw.store_barcode as unknown;
    if (b === null) out.store_barcode = null;
    else {
      if (!isRecord(b)) throw invalid('store_barcode must be an object');
      if (b.mode === 'later') {
        out.store_barcode = { mode: 'later' };
      } else if (b.mode === 'generate') {
        if (
          b.code !== undefined &&
          b.code !== null &&
          typeof b.code !== 'string'
        )
          throw invalid('store_barcode.code must be text');
        if (typeof b.code === 'string' && b.code.length > 32)
          throw invalid('store_barcode.code is too long');
        out.store_barcode =
          typeof b.code === 'string' && b.code.trim()
            ? { mode: 'generate', code: b.code.trim() }
            : { mode: 'generate' };
      } else if (b.mode === 'external') {
        if (typeof b.code !== 'string')
          throw invalid('store_barcode.code must be text');
        if (b.code.length > 64) throw invalid('store_barcode.code is too long');
        out.store_barcode = { mode: 'external', code: b.code.trim() };
      } else {
        throw invalid('store_barcode.mode must be external, generate or later');
      }
    }
  }
  if (raw.measurements !== undefined) {
    try {
      out.measurements = parseMeasurementsInput(raw.measurements);
    } catch (err) {
      if (err instanceof SizeGuideRuleError) throw invalid(err.message);
      throw err;
    }
  }
  for (const k of Object.keys(out) as (keyof DraftPayload)[]) {
    if (out[k] === undefined) delete out[k];
  }
  return out;
}

/**
 * Product colours: a stored draft as the code reads it. A draft saved
 * before product colours keeps { code, images } until its next save; read,
 * each such colour is { key: code, family: code, name_ar: the family's
 * name } - the same as normaliseDraftPayload makes of it, so its sizes,
 * stock and SKU keys (code|size) stay valid as they are.
 */
export function readDraftPayload(
  raw: unknown,
  familyName: (code: string) => { ar: string; en: string } | null,
): DraftPayload {
  const p = (isRecord(raw) ? raw : {}) as DraftPayload & { colors?: unknown };
  if (!Array.isArray(p.colors)) return p;
  return {
    ...p,
    colors: (p.colors as unknown[]).map((c) =>
      isRecord(c) && c.key === undefined && typeof c.code === 'string'
        ? {
            key: c.code,
            family: c.code,
            name_ar: familyName(c.code)?.ar ?? '',
            ...(familyName(c.code)?.en
              ? { name_en: familyName(c.code)!.en }
              : {}),
            images: Array.isArray(c.images) ? (c.images as string[]) : [],
          }
        : (c as DraftColor),
    ),
  };
}

/** Every own upload URL a payload refers to. */
export function payloadImageUrls(p: DraftPayload): string[] {
  return [
    ...new Set([
      ...(p.colors ?? []).flatMap((c) => c.images),
      ...(p.colors ?? []).flatMap((c) => (c.swatch ? [c.swatch] : [])),
      ...(p.shared_images ?? []),
    ]),
  ];
}

/** The short name shown in «مسوداتي». */
/**
 * The step a draft is on in the five-step numbering (phase A+). A draft
 * saved before it used another numbering: phase A (three steps; its shape
 * has `stock` or `size_system`) 1, 2, 3=review; before that (four steps)
 * 1, 2, 3=sizes and stock, 4=review. Same rule as the web (stepOf).
 */
export function draftStep(p: DraftPayload): number {
  const s = p.step ?? 1;
  if (p.layout === 5) return Math.min(5, Math.max(1, s));
  const phaseA = p.stock !== undefined || Boolean(p.size_system);
  const map: Record<number, number> = phaseA
    ? { 1: 1, 2: 2, 3: 5 }
    : { 1: 1, 2: 2, 3: 3, 4: 5 };
  return map[s] ?? 1;
}

/** Every size the product will have (the union over its colours), in first-seen order. */
export function draftSizes(p: DraftPayload): string[] {
  return [...new Set(draftVersions(p).map((v) => v.size))];
}

export function draftDisplayTitle(p: DraftPayload): string | null {
  const t = (p.title_ar ?? '').trim() || (p.title_en ?? '').trim();
  return t || null;
}

/** The versions (colour x size) a draft will create, in a stable order. */
export function draftVersions(
  p: DraftPayload,
): { color: string; size: string }[] {
  const out: { color: string; size: string }[] = [];
  for (const c of p.colors ?? []) {
    for (const size of p.sizes?.[c.key] ?? []) out.push({ color: c.key, size });
  }
  return out;
}

/**
 * The opening stock of every version, per branch (only quantities > 0):
 * branch id -> "COLOR|SIZE" -> quantity. The explicit `stock` map when the
 * draft has one; otherwise (a draft saved before phase A) the default per
 * branch with its exceptions - exactly what that draft meant.
 */
export function openingStock(
  p: DraftPayload,
): Record<string, Record<string, number>> {
  const versions = draftVersions(p).map((v) => versionKey(v.color, v.size));
  const out: Record<string, Record<string, number>> = {};
  const put = (branch: string, key: string, q: number) => {
    if (q > 0) (out[branch] ??= {})[key] = q;
  };
  if (p.stock !== undefined) {
    for (const [branch, per] of Object.entries(p.stock)) {
      for (const key of versions) put(branch, key, per[key] ?? 0);
    }
    return out;
  }
  const branches = new Set(Object.keys(p.default_stock ?? {}));
  for (const per of Object.values(p.stock_overrides ?? {}))
    Object.keys(per).forEach((b) => branches.add(b));
  for (const branch of branches) {
    for (const key of versions) {
      put(
        branch,
        key,
        p.stock_overrides?.[key]?.[branch] ?? p.default_stock?.[branch] ?? 0,
      );
    }
  }
  return out;
}

/**
 * What still prevents creating the product, as fixed codes the page words
 * itself (never English text): each with the wizard step it belongs to
 * (phase A+: 1 details, 2 colours and images, 3 sizes and measurements,
 * 4 stock and price, 5 review). The English name is optional (SRS
 * FR-CAT-014/015: one required title, locales independent).
 */
export function draftProblems(
  p: DraftPayload,
): { code: string; step: number }[] {
  const problems: { code: string; step: number }[] = [];
  if (!p.audience) problems.push({ code: 'AUDIENCE_REQUIRED', step: 1 });
  if (!p.category) problems.push({ code: 'CATEGORY_REQUIRED', step: 1 });
  if (!(p.title_ar ?? '').trim())
    problems.push({ code: 'TITLE_AR_REQUIRED', step: 1 });
  if (!p.brand) problems.push({ code: 'BRAND_REQUIRED', step: 1 });
  else if (p.brand.mode === 'request' && !p.brand.name.trim()) {
    problems.push({ code: 'BRAND_NAME_REQUIRED', step: 1 });
  }
  // Phase A++ (item 4): the specifications' closed lists, the same rule the
  // API, the import and the publish gate apply.
  const specs = specsForCategory(p.category, p.specs);
  if (specs) {
    for (const problem of validateTemplateAttributes(
      specs.template,
      specs.attributes,
    )) {
      if (problem.type === 'INVALID_VALUE')
        problems.push({ code: `SPEC_INVALID:${problem.key}`, step: 1 });
    }
  }
  const colors = p.colors ?? [];
  if (colors.length === 0) problems.push({ code: 'COLOR_REQUIRED', step: 2 });
  for (const c of colors) {
    if (!c.family)
      problems.push({ code: `COLOR_FAMILY_REQUIRED:${c.key}`, step: 2 });
    if (!c.name_ar.trim())
      problems.push({ code: `COLOR_NAME_REQUIRED:${c.key}`, step: 2 });
    if (c.images.length === 0)
      problems.push({ code: `COLOR_IMAGE_REQUIRED:${c.key}`, step: 2 });
  }
  for (const c of colors) {
    if ((p.sizes?.[c.key] ?? []).length === 0) {
      problems.push({ code: `COLOR_SIZE_REQUIRED:${c.key}`, step: 3 });
    }
  }
  // One size system per product: the chosen one, or (a draft saved before
  // phase A) whichever its sizes are in - never a mix.
  const systems = new Set(
    Object.values(p.sizes ?? {})
      .flat()
      .map(sizeSystemOf),
  );
  if (
    p.size_system
      ? [...systems].some((s) => s !== p.size_system)
      : systems.size > 1
  ) {
    problems.push({ code: 'SIZE_SYSTEM_MIXED', step: 3 });
  }
  // Phase A++ (item 5): the same rule the product page's edit applies.
  const model = modelProblem(p.model?.height_cm, p.model?.size, draftSizes(p));
  if (model) problems.push({ code: model, step: 3 });
  if (!p.price) problems.push({ code: 'PRICE_REQUIRED', step: 4 });
  else if (p.discount?.mode === 'sale' && p.discount.sale_price === null) {
    // Chosen but not typed yet: the rules' own code for a sale price.
    problems.push({ code: 'DISCOUNT:INVALID_SALE_PRICE', step: 4 });
  } else if (p.discount) {
    // The system's own price rules decide (resolveUnifiedPrice) - the same
    // check PUT .../price and the creation itself apply (an unfinished
    // window is its INCOMPLETE_DISCOUNT_WINDOW).
    try {
      resolveUnifiedPrice({
        base_price: p.price,
        ...discountFields(p.discount),
      });
    } catch (err) {
      if (!(err instanceof BadRequestException)) throw err;
      const code = (err.getResponse() as { code?: string }).code ?? 'INVALID';
      problems.push({ code: `DISCOUNT:${code}`, step: 4 });
    }
  }
  // the composition, once entered: each part complete and totalling 100%
  for (const code of compositionProblems(p.composition))
    problems.push({ code, step: 1 });
  return problems;
}

/** The specifications kept for the product: only its template's own fields, only filled ones. */
export function specsForCategory(
  category: string | null | undefined,
  specs: Record<string, string> | undefined,
): {
  template: ClothingCategoryTemplate;
  attributes: Record<string, string>;
} | null {
  const template = category ? CATEGORY_SPEC_TEMPLATE[category] : undefined;
  if (!template) return null;
  const allowed = CLOTHING_CATEGORY_TEMPLATE_FIELDS[template];
  const attributes: Record<string, string> = {};
  for (const [k, v] of Object.entries(specs ?? {})) {
    if (allowed.includes(k) && v.trim()) attributes[k] = v.trim();
  }
  return { template, attributes };
}
