import { BadRequestException } from '@nestjs/common';

/**
 * «الصفحة الرئيسية المرنة للمتجر» (2026-11-20): the home page document and
 * its validation. A closed list of ready blocks - never free HTML, never a
 * typed link: every destination is an internal choice (the products, new
 * arrivals, sale, one of the store's collections, products or categories),
 * every image one of the store's own uploads (checked by the controller),
 * every text plain text (shown as text, never as markup).
 *
 * Anything the document does not define - a block type, a field, a target
 * kind - is refused, never ignored, so nothing unchecked is ever stored.
 * An UNFINISHED block (no products chosen yet, a button label without its
 * destination, an empty text) is accepted - the owner's screen autosaves
 * while she works - and simply not shown to shoppers until it is complete
 * (store-home.resolve.ts decides that, and tells the owner why).
 */

export const HOME_LIMITS = {
  blocks: 12,
  images: 20,
  heroSlides: 3,
  products: 12,
  collections: 8,
  categories: 12,
  autoMin: 4,
  autoMax: 12,
  /** «بطاقات التصنيفات»: 2-8 cards */
  categoryCards: 8,
  /** «لوحة ترويجية»: 2-4 tiles */
  promoTiles: 4,
} as const;

/** A list block is shown only with at least this many items shoppers can open. */
export const MIN_SHOWN_ITEMS = 2;

export const TEXT_LIMITS = {
  title: 60,
  heroText: 140,
  bannerText: 140,
  body: 280,
  button: 24,
  alt: 120,
  /** the short description beside a «شريط منتجات» (the side variant) */
  sideText: 140,
  /** «بطاقات التصنيفات»: a card's title and its optional line */
  cardTitle: 24,
  cardText: 40,
  /** «لوحة ترويجية»: a tile's title and its description */
  tileTitle: 40,
  tileText: 80,
} as const;

export const BLOCK_TYPES = [
  'hero',
  'banner',
  'collections',
  'products',
  'auto_products',
  'categories',
  'text',
  'category_cards',
  'promo_grid',
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

/**
 * «لوحة ترويجية» promo_grid (P3, 2026-11-22): 2-4 promotional tiles in a
 * ready layout - never free sizes. The layouts each tile count may use (the
 * first = its default); `share` is the wide tile's part (big_* only, %);
 * `divider` how the tiles meet. Stored with 0-4 tiles (the owner's
 * autosave); shown only with at least two complete tiles.
 */
export const PROMO_LAYOUTS = {
  2: ['even', 'start_wide', 'end_wide'],
  3: ['even', 'big_start', 'big_end'],
  4: ['grid', 'big_start', 'big_end'],
} as const;
export const PROMO_LAYOUT_NAMES = [
  'even',
  'start_wide',
  'end_wide',
  'big_start',
  'big_end',
  'grid',
] as const;
export type PromoLayout = (typeof PROMO_LAYOUT_NAMES)[number];
export const PROMO_DIVIDERS = ['gap', 'straight', 'slant', 'wave'] as const;
export const PROMO_SHARES = [50, 60] as const;

/** The layout a count of tiles uses: the stored one when it suits it, else that count's default. */
export function promoLayoutFor(
  layout: PromoLayout,
  count: number,
): PromoLayout {
  const allowed = PROMO_LAYOUTS[count as 2 | 3 | 4] as
    readonly PromoLayout[] | undefined;
  if (!allowed) return layout;
  return allowed.includes(layout) ? layout : allowed[0];
}

/** One tile of «لوحة ترويجية». */
export interface PromoTile {
  image: HomeImage | null;
  title: LocalText;
  text: LocalText;
  button: LocalText;
  target: HomeTarget | null;
  alt: LocalText;
  focus: FocusPoint;
}

/** The departments a card may lead to (the platform's fixed audiences). */
export const CARD_AUDIENCES = ['WOMEN', 'MEN', 'KIDS'] as const;
/** «بطاقات التصنيفات»: one shape for the whole block. */
export const CARD_SHAPES = ['circle', 'square', 'portrait'] as const;

/**
 * One card of «بطاقات التصنيفات» (P1, 2026-11-22): a picture that leads to a
 * real department of the store (audience) or to one of its real categories
 * (audience + category). Unfinished cards are kept (autosave) and not shown.
 */
export interface CategoryCard {
  audience: (typeof CARD_AUDIENCES)[number];
  category: string | null;
  image: HomeImage | null;
  title: LocalText;
  text: LocalText;
  alt: LocalText;
  focus: FocusPoint;
}

export interface LocalText {
  ar: string;
  en: string;
}

export interface HomeImage {
  url: string;
  /** Advisory only (the owner's size warnings) - never trusted for anything else. */
  width: number | null;
  height: number | null;
  bytes: number | null;
}

export type HomeTarget =
  | { kind: 'products' }
  | { kind: 'new' }
  | { kind: 'sale' }
  | { kind: 'collection'; id: string }
  | { kind: 'product'; id: string }
  | { kind: 'category'; audience: string; category: string };

/**
 * «قوالب وستايلات وأشكال الصفحة الرئيسية» (2026-11-21): closed choices only.
 * STYLE = how the page looks (a ready set of the system's colours, corners,
 * frames, shadows, image treatment and one of the app's own heading fonts -
 * never a free colour, font, CSS or effect); TEMPLATE = which ready template
 * built the draft's structure (informative; the blocks are what count). They
 * are independent. A missing style is 'default': the look before styles.
 */
export const HOME_STYLES = [
  'default',
  'elegant',
  'warm',
  'calm',
  'modern',
] as const;
export type HomeStyle = (typeof HOME_STYLES)[number];
export const HOME_TEMPLATES = ['luxe', 'sale', 'kids', 'minimal'] as const;
export type HomeTemplate = (typeof HOME_TEMPLATES)[number];

/** A block's shape (the first value is the default = the look before variants). */
export const BLOCK_VARIANTS = {
  hero: ['overlay', 'split'],
  banner: ['single', 'double'],
  products: ['standard', 'side'],
  auto_products: ['standard', 'side'],
} as const;

/**
 * Where an image's subject is (a 3x3 grid, never coordinates): decides how
 * the image is cropped, especially on a phone. Physical sides - an image is
 * never mirrored between Arabic and English. 'center' = the crop before.
 */
export const FOCUS_POINTS = [
  'top-left',
  'top',
  'top-right',
  'left',
  'center',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
] as const;
export type FocusPoint = (typeof FOCUS_POINTS)[number];

export interface HeroSlide {
  /** null: a place for an image not chosen yet («أضيفي صورة») - never shown */
  image: HomeImage | null;
  image_mobile: HomeImage | null;
  title: LocalText;
  text: LocalText;
  button: LocalText;
  target: HomeTarget | null;
  /** where the slide's text sits (logical: start / center / end - P2 added end) */
  align: 'start' | 'center' | 'end';
  alt: LocalText;
  focus: FocusPoint;
}

/** One card of a banner (the double banner has two). */
export interface BannerCard {
  image: HomeImage | null;
  image_mobile: HomeImage | null;
  title: LocalText;
  text: LocalText;
  target: HomeTarget | null;
  alt: LocalText;
  focus: FocusPoint;
}

/**
 * How a block is laid out (2026-11-21): a closed set of choices, never free
 * CSS or numbers. Each type takes only the keys that suit it (DISPLAY_KEYS);
 * a missing key is its default - the look every block had before this
 * existed, so older layouts look exactly the same.
 */
export const DISPLAY_VALUES = {
  width: ['content', 'full'],
  height: ['compact', 'medium', 'wide'],
  spacing: ['tight', 'normal', 'wide'],
} as const;
export type DisplayKey = keyof typeof DISPLAY_VALUES;
export interface BlockDisplay {
  width?: (typeof DISPLAY_VALUES.width)[number];
  height?: (typeof DISPLAY_VALUES.height)[number];
  spacing: (typeof DISPLAY_VALUES.spacing)[number];
  /** P2: fine sizes in whole steps (see DISPLAY_STEPS) - absent = the preset's look */
  height_step?: number;
  space_before?: number;
  space_after?: number;
  content_width?: number;
  content_align?: 'center' | 'end';
  text_width?: number;
  per_view?: number;
}

/**
 * P2 «نظام القياس والمحاذاة» (2026-11-22): whole steps ON TOP of the presets
 * above - never px or % typed by the owner. One step = 10px (height,
 * spaces) or 10% (widths) on a computer; a phone derives its own safe value
 * (shoppers' CSS clamps every result). A key at its default is not stored,
 * so older layouts read exactly as before:
 *  - height_step  -6..16  (hero, banner)  -60..+160px over the preset; final
 *                 heights clamped: hero 220-720 / phone 240-560, banner
 *                 100-420 / phone 90-320 (phone offset = half)
 *  - space_before / space_after  0..10  (every type) - replaces the preset's
 *                 space on that side; phone = 0.6x, at most 60px
 *  - content_width 6..9 (10 = default, not stored)  text, collections,
 *                 products, auto_products, category_cards; phone = 100%
 *  - content_align center | end (start = default)  the same types
 *  - text_width   4..7  hero (overlay text panel 40-70%; phone = full)
 *  - per_view     products / auto_products 3|4|5; category_cards by shape
 *                 (circle 5|6|8, square 4|5|6, portrait 3|4|5)
 */
export const DISPLAY_STEPS = {
  height_step: { min: -6, max: 16, default: 0 },
  space_before: { min: 0, max: 10, default: null },
  space_after: { min: 0, max: 10, default: null },
  content_width: { min: 6, max: 10, default: 10 },
  text_width: { min: 4, max: 7, default: null },
} as const;
export type StepKey = keyof typeof DISPLAY_STEPS;
export const CONTENT_ALIGN = ['start', 'center', 'end'] as const;
export const PER_VIEW = {
  products: [3, 4, 5],
  auto_products: [3, 4, 5],
  circle: [5, 6, 8],
  square: [4, 5, 6],
  portrait: [3, 4, 5],
} as const;
export type FineKey = StepKey | 'content_align' | 'per_view';
export const DISPLAY_DEFAULTS = {
  width: 'content',
  height: 'medium',
  spacing: 'normal',
} as const;

interface BlockBase {
  id: string;
  visible: boolean;
  display: BlockDisplay;
}
export type HomeBlock =
  | (BlockBase & {
      type: 'hero';
      variant: 'overlay' | 'split';
      slides: HeroSlide[];
    })
  | (BlockBase &
      BannerCard & {
        type: 'banner';
        variant: 'single' | 'double';
        /** the double banner's second card (kept while the owner switches back and forth) */
        second: BannerCard | null;
      })
  | (BlockBase & {
      type: 'collections';
      title: LocalText;
      collection_ids: string[];
    })
  | (BlockBase & {
      type: 'products';
      variant: 'standard' | 'side';
      title: LocalText;
      /** the side variant's short description */
      text: LocalText;
      offer_ids: string[];
    })
  | (BlockBase & {
      type: 'auto_products';
      variant: 'standard' | 'side';
      title: LocalText;
      text: LocalText;
      source: 'new' | 'sale';
      count: number;
    })
  | (BlockBase & {
      type: 'categories';
      title: LocalText;
      items: { audience: string; category: string }[];
    })
  | (BlockBase & {
      type: 'text';
      style: 'text' | 'divider';
      title: LocalText;
      text: LocalText;
    })
  | (BlockBase & {
      type: 'category_cards';
      shape: (typeof CARD_SHAPES)[number];
      /** the block's own heading (optional) */
      title: LocalText;
      items: CategoryCard[];
    })
  | (BlockBase & {
      type: 'promo_grid';
      layout: PromoLayout;
      share: (typeof PROMO_SHARES)[number];
      divider: (typeof PROMO_DIVIDERS)[number];
      tiles: PromoTile[];
    });

export interface HomeLayout {
  style: HomeStyle;
  template: HomeTemplate | null;
  blocks: HomeBlock[];
}

export const EMPTY_LAYOUT: HomeLayout = {
  style: 'default',
  template: null,
  blocks: [],
};

const BLOCK_ID = /^[A-Za-z0-9_-]{6,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Z0-9_]{1,64}$/;
// C0/C1 controls (a newline is allowed only where a body is), and the
// bidirectional embedding / override / isolate characters, which could make
// a store's text read differently from what it is.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

class LayoutError extends BadRequestException {
  constructor(field: string, problem: string) {
    super({
      code: 'STORE_HOME_INVALID',
      message: `${field}: ${problem}`,
      details: [{ field, problem }],
    });
  }
}

type Obj = Record<string, unknown>;

function obj(v: unknown, field: string, keys: readonly string[]): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new LayoutError(field, 'must be an object');
  }
  const extra = Object.keys(v).filter((k) => !keys.includes(k));
  if (extra.length) {
    throw new LayoutError(`${field}.${extra[0]}`, 'is not a known field');
  }
  return v as Obj;
}

function arr(v: unknown, field: string, min: number, max: number): unknown[] {
  if (!Array.isArray(v)) throw new LayoutError(field, 'must be a list');
  if (v.length < min) throw new LayoutError(field, `needs at least ${min}`);
  if (v.length > max) throw new LayoutError(field, `allows at most ${max}`);
  return v;
}

function oneOf<T extends string>(
  v: unknown,
  field: string,
  values: readonly T[],
): T {
  if (typeof v !== 'string' || !values.includes(v as T)) {
    throw new LayoutError(field, `must be one of ${values.join(', ')}`);
  }
  return v as T;
}

function text(
  v: unknown,
  field: string,
  max: number,
  multiline = false,
): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new LayoutError(field, 'must be text');
  const s = v.replace(/\r\n?/g, '\n').trim();
  if (CONTROL.test(s) || (!multiline && s.includes('\n'))) {
    throw new LayoutError(field, 'contains characters that are not allowed');
  }
  if ([...s].length > max) {
    throw new LayoutError(field, `allows at most ${max} characters`);
  }
  return s;
}

function localText(
  v: unknown,
  field: string,
  max: number,
  multiline = false,
): LocalText {
  if (v === undefined || v === null) return { ar: '', en: '' };
  const o = obj(v, field, ['ar', 'en']);
  const out = {
    ar: text(o.ar, `${field}.ar`, max, multiline),
    en: text(o.en, `${field}.en`, max, multiline),
  };
  return out;
}

function positiveIntOrNull(v: unknown, field: string, max: number) {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > max) {
    throw new LayoutError(field, 'must be a positive whole number');
  }
  return v as number;
}

function image(v: unknown, field: string): HomeImage {
  const o = obj(v, field, ['url', 'width', 'height', 'bytes']);
  if (typeof o.url !== 'string' || !o.url || o.url.length > 500) {
    throw new LayoutError(`${field}.url`, 'must be an uploaded image');
  }
  return {
    url: o.url,
    width: positiveIntOrNull(o.width, `${field}.width`, 100_000),
    height: positiveIntOrNull(o.height, `${field}.height`, 100_000),
    bytes: positiveIntOrNull(o.bytes, `${field}.bytes`, 100_000_000),
  };
}

/** A place for an image: null (not chosen yet) or one uploaded image. */
function imageOrNull(v: unknown, field: string): HomeImage | null {
  return v == null ? null : image(v, field);
}

function focus(v: unknown, field: string): FocusPoint {
  return v === undefined ? 'center' : oneOf(v, field, FOCUS_POINTS);
}

function variant<T extends string>(
  v: unknown,
  field: string,
  values: readonly T[],
): T {
  return v === undefined ? values[0] : oneOf(v, field, values);
}

const CARD_KEYS = [
  'image',
  'image_mobile',
  'title',
  'text',
  'target',
  'alt',
  'focus',
] as const;

function bannerCard(o: Obj, field: string): BannerCard {
  return {
    image: imageOrNull(o.image, `${field}.image`),
    image_mobile: imageOrNull(o.image_mobile, `${field}.image_mobile`),
    title: localText(o.title, `${field}.title`, TEXT_LIMITS.title),
    text: localText(o.text, `${field}.text`, TEXT_LIMITS.bannerText),
    target: target(o.target, `${field}.target`),
    alt: localText(o.alt, `${field}.alt`, TEXT_LIMITS.alt),
    focus: focus(o.focus, `${field}.focus`),
  };
}

function uuid(v: unknown, field: string): string {
  if (typeof v !== 'string' || !UUID.test(v)) {
    throw new LayoutError(field, 'must be an id');
  }
  return v.toLowerCase();
}

function code(v: unknown, field: string): string {
  if (typeof v !== 'string' || !CODE.test(v)) {
    throw new LayoutError(field, 'must be a code');
  }
  return v;
}

function target(v: unknown, field: string): HomeTarget | null {
  if (v === undefined || v === null) return null;
  const kind = oneOf((v as Obj)?.kind, `${field}.kind`, [
    'products',
    'new',
    'sale',
    'collection',
    'product',
    'category',
  ] as const);
  switch (kind) {
    case 'products':
    case 'new':
    case 'sale':
      obj(v, field, ['kind']);
      return { kind };
    case 'collection':
    case 'product': {
      const o = obj(v, field, ['kind', 'id']);
      return { kind, id: uuid(o.id, `${field}.id`) };
    }
    case 'category': {
      const o = obj(v, field, ['kind', 'audience', 'category']);
      return {
        kind,
        audience: code(o.audience, `${field}.audience`),
        category: code(o.category, `${field}.category`),
      };
    }
  }
}

function uniqueIds(ids: string[], field: string) {
  if (new Set(ids).size !== ids.length) {
    throw new LayoutError(field, 'lists the same item twice');
  }
  return ids;
}

const BASE = ['id', 'type', 'visible', 'display'] as const;

/** Which display choices each type takes (a text or a rail has no height or width). */
export const DISPLAY_KEYS: Record<BlockType, readonly DisplayKey[]> = {
  hero: ['width', 'height', 'spacing'],
  banner: ['width', 'height', 'spacing'],
  collections: ['spacing'],
  products: ['spacing'],
  auto_products: ['spacing'],
  categories: ['spacing'],
  text: ['spacing'],
  category_cards: ['spacing'],
  promo_grid: ['spacing'],
};

/** P2: the fine keys each type takes (closed; anything else is refused). */
const SPACES = ['space_before', 'space_after'] as const;
const CONTENT = ['content_width', 'content_align'] as const;
export const FINE_KEYS: Record<BlockType, readonly FineKey[]> = {
  hero: ['height_step', ...SPACES, 'text_width'],
  banner: ['height_step', ...SPACES],
  collections: [...SPACES, ...CONTENT],
  products: [...SPACES, ...CONTENT, 'per_view'],
  auto_products: [...SPACES, ...CONTENT, 'per_view'],
  categories: [...SPACES],
  text: [...SPACES, ...CONTENT],
  category_cards: [...SPACES, ...CONTENT, 'per_view'],
  promo_grid: [...SPACES, ...CONTENT],
};

function step(v: unknown, field: string, key: StepKey): number {
  const { min, max } = DISPLAY_STEPS[key];
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) {
    throw new LayoutError(field, `must be a whole step from ${min} to ${max}`);
  }
  return v as number;
}

/**
 * The block's display, normalised: every preset key of its type with its
 * default; the P2 fine keys only when set to something other than their
 * default (so an older block reads exactly as before). Anything else - an
 * unknown key, a value out of range or between steps, a key its type does
 * not take - is refused. `per_view` is checked against the block's shape by
 * block() (category cards).
 */
function display(v: unknown, field: string, type: BlockType): BlockDisplay {
  const keys = DISPLAY_KEYS[type];
  const fine = FINE_KEYS[type];
  const o =
    v === undefined || v === null ? {} : obj(v, field, [...keys, ...fine]);
  const out: Record<string, string | number> = {};
  for (const key of keys) {
    out[key] =
      o[key] === undefined
        ? DISPLAY_DEFAULTS[key]
        : oneOf(o[key], `${field}.${key}`, DISPLAY_VALUES[key]);
  }
  for (const key of fine) {
    const raw = o[key];
    if (raw === undefined || raw === null) continue;
    const f = `${field}.${key}`;
    if (key === 'content_align') {
      const a = oneOf(raw, f, CONTENT_ALIGN);
      if (a !== 'start') out[key] = a;
    } else if (key === 'per_view') {
      if (
        !Number.isInteger(raw) ||
        (raw as number) < 3 ||
        (raw as number) > 8
      ) {
        throw new LayoutError(f, 'must be one of the offered counts');
      }
      if (type === 'products' || type === 'auto_products') {
        if (!(PER_VIEW[type] as readonly number[]).includes(raw as number)) {
          throw new LayoutError(
            f,
            `must be one of ${PER_VIEW[type].join(', ')}`,
          );
        }
      }
      out[key] = raw as number;
    } else {
      const n = step(raw, f, key);
      if (n !== DISPLAY_STEPS[key].default) out[key] = n;
    }
  }
  return out as unknown as BlockDisplay;
}

function block(v: unknown, field: string): HomeBlock {
  const type = oneOf((v as Obj)?.type, `${field}.type`, BLOCK_TYPES);
  const keys: Record<BlockType, readonly string[]> = {
    hero: [...BASE, 'variant', 'slides'],
    banner: [...BASE, 'variant', ...CARD_KEYS, 'second'],
    collections: [...BASE, 'title', 'collection_ids'],
    products: [...BASE, 'variant', 'title', 'text', 'offer_ids'],
    auto_products: [...BASE, 'variant', 'title', 'text', 'source', 'count'],
    categories: [...BASE, 'title', 'items'],
    text: [...BASE, 'style', 'title', 'text'],
    category_cards: [...BASE, 'shape', 'title', 'items'],
    promo_grid: [...BASE, 'layout', 'share', 'divider', 'tiles'],
  };
  const o = obj(v, field, keys[type]);
  if (typeof o.id !== 'string' || !BLOCK_ID.test(o.id)) {
    throw new LayoutError(`${field}.id`, 'must be a block id');
  }
  if (o.visible !== undefined && typeof o.visible !== 'boolean') {
    throw new LayoutError(`${field}.visible`, 'must be true or false');
  }
  const base = {
    id: o.id,
    visible: o.visible !== false,
    display: display(o.display, `${field}.display`, type),
  };
  const title = () => localText(o.title, `${field}.title`, TEXT_LIMITS.title);
  switch (type) {
    case 'hero': {
      const slides = arr(
        o.slides,
        `${field}.slides`,
        1,
        HOME_LIMITS.heroSlides,
      ).map((s, i) => {
        const f = `${field}.slides[${i}]`;
        const so = obj(s, f, [
          'image',
          'image_mobile',
          'title',
          'text',
          'button',
          'target',
          'align',
          'alt',
          'focus',
        ]);
        const slide: HeroSlide = {
          image: imageOrNull(so.image, `${f}.image`),
          image_mobile:
            so.image_mobile == null
              ? null
              : image(so.image_mobile, `${f}.image_mobile`),
          title: localText(so.title, `${f}.title`, TEXT_LIMITS.title),
          text: localText(so.text, `${f}.text`, TEXT_LIMITS.heroText),
          button: localText(so.button, `${f}.button`, TEXT_LIMITS.button),
          target: target(so.target, `${f}.target`),
          align:
            so.align === undefined
              ? 'start'
              : oneOf(so.align, `${f}.align`, [
                  'start',
                  'center',
                  'end',
                ] as const),
          alt: localText(so.alt, `${f}.alt`, TEXT_LIMITS.alt),
          focus: focus(so.focus, `${f}.focus`),
        };
        // A button needs a label AND a destination to be shown - an
        // unfinished one is kept (the owner's autosave) but never shown.
        return slide;
      });
      return {
        ...base,
        type,
        variant: variant(o.variant, `${field}.variant`, BLOCK_VARIANTS.hero),
        slides,
      };
    }
    case 'banner':
      return {
        ...base,
        type,
        variant: variant(o.variant, `${field}.variant`, BLOCK_VARIANTS.banner),
        ...bannerCard(o, field),
        second:
          o.second == null
            ? null
            : bannerCard(
                obj(o.second, `${field}.second`, CARD_KEYS),
                `${field}.second`,
              ),
      };
    case 'collections':
      return {
        ...base,
        type,
        title: title(),
        collection_ids: uniqueIds(
          arr(
            o.collection_ids,
            `${field}.collection_ids`,
            0,
            HOME_LIMITS.collections,
          ).map((x, i) => uuid(x, `${field}.collection_ids[${i}]`)),
          `${field}.collection_ids`,
        ),
      };
    case 'products':
      return {
        ...base,
        type,
        variant: variant(
          o.variant,
          `${field}.variant`,
          BLOCK_VARIANTS.products,
        ),
        title: title(),
        text: localText(o.text, `${field}.text`, TEXT_LIMITS.sideText),
        offer_ids: uniqueIds(
          arr(o.offer_ids, `${field}.offer_ids`, 0, HOME_LIMITS.products).map(
            (x, i) => uuid(x, `${field}.offer_ids[${i}]`),
          ),
          `${field}.offer_ids`,
        ),
      };
    case 'auto_products': {
      const count = o.count === undefined ? 8 : o.count;
      if (
        !Number.isInteger(count) ||
        (count as number) < HOME_LIMITS.autoMin ||
        (count as number) > HOME_LIMITS.autoMax
      ) {
        throw new LayoutError(
          `${field}.count`,
          `must be ${HOME_LIMITS.autoMin}-${HOME_LIMITS.autoMax}`,
        );
      }
      return {
        ...base,
        type,
        variant: variant(
          o.variant,
          `${field}.variant`,
          BLOCK_VARIANTS.auto_products,
        ),
        title: title(),
        text: localText(o.text, `${field}.text`, TEXT_LIMITS.sideText),
        source: oneOf(o.source, `${field}.source`, ['new', 'sale'] as const),
        count: count as number,
      };
    }
    case 'categories': {
      const items = arr(
        o.items,
        `${field}.items`,
        0,
        HOME_LIMITS.categories,
      ).map((x, i) => {
        const io = obj(x, `${field}.items[${i}]`, ['audience', 'category']);
        return {
          audience: code(io.audience, `${field}.items[${i}].audience`),
          category: code(io.category, `${field}.items[${i}].category`),
        };
      });
      uniqueIds(
        items.map((x) => `${x.audience}/${x.category}`),
        `${field}.items`,
      );
      return { ...base, type, title: title(), items };
    }
    case 'promo_grid': {
      const tiles = arr(
        o.tiles,
        `${field}.tiles`,
        0,
        HOME_LIMITS.promoTiles,
      ).map((x, i): PromoTile => {
        const f = `${field}.tiles[${i}]`;
        const to = obj(x, f, [
          'image',
          'title',
          'text',
          'button',
          'target',
          'alt',
          'focus',
        ]);
        return {
          image: imageOrNull(to.image, `${f}.image`),
          title: localText(to.title, `${f}.title`, TEXT_LIMITS.tileTitle),
          text: localText(to.text, `${f}.text`, TEXT_LIMITS.tileText),
          button: localText(to.button, `${f}.button`, TEXT_LIMITS.button),
          target: target(to.target, `${f}.target`),
          alt: localText(to.alt, `${f}.alt`, TEXT_LIMITS.alt),
          focus: focus(to.focus, `${f}.focus`),
        };
      });
      const count = tiles.length as 2 | 3 | 4;
      const allowed = (PROMO_LAYOUTS[count] ??
        PROMO_LAYOUT_NAMES) as readonly PromoLayout[];
      const layout =
        o.layout === undefined
          ? allowed[0]
          : oneOf(o.layout, `${field}.layout`, allowed);
      const share =
        o.share === undefined
          ? 60
          : (PROMO_SHARES.find((s) => s === o.share) ??
            (() => {
              throw new LayoutError(
                `${field}.share`,
                `must be one of ${PROMO_SHARES.join(', ')}`,
              );
            })());
      return {
        ...base,
        type,
        layout,
        share,
        divider: variant(o.divider, `${field}.divider`, PROMO_DIVIDERS),
        tiles,
      };
    }
    case 'category_cards': {
      const items = arr(
        o.items,
        `${field}.items`,
        0,
        HOME_LIMITS.categoryCards,
      ).map((x, i): CategoryCard => {
        const f = `${field}.items[${i}]`;
        const io = obj(x, f, [
          'audience',
          'category',
          'image',
          'title',
          'text',
          'alt',
          'focus',
        ]);
        return {
          audience: oneOf(io.audience, `${f}.audience`, CARD_AUDIENCES),
          category:
            io.category == null ? null : code(io.category, `${f}.category`),
          image: imageOrNull(io.image, `${f}.image`),
          title: localText(io.title, `${f}.title`, TEXT_LIMITS.cardTitle),
          text: localText(io.text, `${f}.text`, TEXT_LIMITS.cardText),
          alt: localText(io.alt, `${f}.alt`, TEXT_LIMITS.alt),
          focus: focus(io.focus, `${f}.focus`),
        };
      });
      uniqueIds(
        items.map((c) => `${c.audience}/${c.category ?? ''}`),
        `${field}.items`,
      );
      const shape = variant(o.shape, `${field}.shape`, CARD_SHAPES);
      // how many cards show at once depends on the shape (readable sizes only)
      const pv = base.display.per_view;
      if (
        pv !== undefined &&
        !(PER_VIEW[shape] as readonly number[]).includes(pv)
      ) {
        throw new LayoutError(
          `${field}.display.per_view`,
          `must be one of ${PER_VIEW[shape].join(', ')} for this shape`,
        );
      }
      return {
        ...base,
        type,
        shape,
        title: title(),
        items,
      };
    }
    case 'text': {
      const style =
        o.style === undefined
          ? 'text'
          : oneOf(o.style, `${field}.style`, ['text', 'divider'] as const);
      return {
        ...base,
        type,
        style,
        title: title(),
        text: localText(o.text, `${field}.text`, TEXT_LIMITS.body, true),
      };
    }
  }
}

/** A banner's cards as stored: the first, and the second one when there is one. */
export function bannerCards(
  b: Extract<HomeBlock, { type: 'banner' }>,
): BannerCard[] {
  return b.second ? [b, b.second] : [b];
}

/** Every image of a layout (desktop and phone), in order - empty places do not count. */
export function layoutImages(layout: Pick<HomeLayout, 'blocks'>): string[] {
  const out: string[] = [];
  const add = (i: HomeImage | null) => {
    if (i) out.push(i.url);
  };
  for (const b of layout.blocks) {
    if (b.type === 'hero') {
      for (const s of b.slides) {
        add(s.image);
        add(s.image_mobile);
      }
    } else if (b.type === 'banner') {
      for (const c of bannerCards(b)) {
        add(c.image);
        add(c.image_mobile);
      }
    } else if (b.type === 'category_cards') {
      for (const c of b.items) add(c.image);
    } else if (b.type === 'promo_grid') {
      for (const tile of b.tiles) add(tile.image);
    }
  }
  return out;
}

/** Every destination of a layout (hero buttons, banner cards). */
export function layoutTargets(
  layout: Pick<HomeLayout, 'blocks'>,
): HomeTarget[] {
  const out: HomeTarget[] = [];
  for (const b of layout.blocks) {
    if (b.type === 'hero') {
      for (const s of b.slides) if (s.target) out.push(s.target);
    } else if (b.type === 'banner') {
      for (const c of bannerCards(b)) if (c.target) out.push(c.target);
    } else if (b.type === 'promo_grid') {
      for (const tile of b.tiles) if (tile.target) out.push(tile.target);
    }
  }
  return out;
}

/** What a layout points at: products, collections, categories and images. */
export function layoutRefs(layout: Pick<HomeLayout, 'blocks'>) {
  const offers = new Set<string>();
  const collections = new Set<string>();
  const categories = new Set<string>();
  for (const b of layout.blocks) {
    if (b.type === 'products') b.offer_ids.forEach((id) => offers.add(id));
    if (b.type === 'collections')
      b.collection_ids.forEach((id) => collections.add(id));
    if (b.type === 'categories')
      b.items.forEach((x) => categories.add(`${x.audience}/${x.category}`));
    // a card's category must be one of the fixed taxonomy's, in its department
    if (b.type === 'category_cards')
      b.items.forEach((x) => {
        if (x.category) categories.add(`${x.audience}/${x.category}`);
      });
  }
  for (const t of layoutTargets(layout)) {
    if (t.kind === 'product') offers.add(t.id);
    if (t.kind === 'collection') collections.add(t.id);
    if (t.kind === 'category') categories.add(`${t.audience}/${t.category}`);
  }
  return {
    offers,
    collections,
    categories,
    images: new Set(layoutImages(layout)),
  };
}

/**
 * The document as sent by the owner's screen, checked field by field (a
 * closed shape). Throws 400 STORE_HOME_INVALID naming the first wrong field.
 */
export function parseLayout(input: unknown): HomeLayout {
  const o = obj(input, 'layout', ['blocks', 'style', 'template']);
  const style =
    o.style === undefined || o.style === null
      ? 'default'
      : oneOf(o.style, 'layout.style', HOME_STYLES);
  const template =
    o.template === undefined || o.template === null
      ? null
      : oneOf(o.template, 'layout.template', HOME_TEMPLATES);
  const blocks = arr(o.blocks, 'layout.blocks', 0, HOME_LIMITS.blocks).map(
    (b, i) => block(b, `layout.blocks[${i}]`),
  );
  uniqueIds(
    blocks.map((b) => b.id),
    'layout.blocks',
  );
  const layout: HomeLayout = { style, template, blocks };
  if (layoutImages(layout).length > HOME_LIMITS.images) {
    throw new LayoutError(
      'layout.blocks',
      `allows at most ${HOME_LIMITS.images} images in the whole page`,
    );
  }
  return layout;
}

/**
 * A stored document read back (draft or published). It was valid when it was
 * written; anything unreadable is treated as an empty page rather than
 * breaking the store page.
 */
export function storedLayout(raw: unknown): HomeLayout {
  try {
    return parseLayout(raw);
  } catch {
    return EMPTY_LAYOUT;
  }
}
