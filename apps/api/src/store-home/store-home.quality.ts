import {
  type BannerCard,
  bannerCards,
  type HomeBlock,
  type HomeImage,
  type HomeLayout,
  type HomeTarget,
  type LocalText,
  MIN_SHOWN_ITEMS,
} from './store-home.layout';
import type { BlockReview, HomeResolver } from './store-home.resolve';

/**
 * «فحص قبل النشر» (2026-11-21): what the owner should fix before publishing,
 * computed on every read of her draft and again when she publishes.
 *
 * ERRORS stop «نشر» - only what cannot be shown safely: a visible block left
 * unfinished (an empty image place, fewer chosen items than a list needs, an
 * empty text, a button label without a destination, an incomplete card of a
 * double banner), a destination that no longer exists (a deleted / archived
 * product, a deleted collection, an unknown category), more than one Hero.
 *
 * WARNINGS never stop it - advice, or a state that changes by itself (the
 * page re-checks stock on every visit): an image too small, of the wrong
 * shape, heavy or a GIF; long text over an image; two similar blocks in a
 * row; an image without a description; a block or button not shown NOW
 * because its products are sold out or its collection is hidden.
 *
 * Hidden blocks are never checked (shoppers never see them).
 */

export type QualityCode =
  // errors
  | 'two_heroes'
  | 'no_image'
  | 'too_few_chosen'
  | 'empty_text'
  | 'button_no_target'
  | 'card_no_target'
  | 'card_no_text'
  | 'card_no_title'
  | 'target_no_button'
  | 'target_invalid'
  // warnings
  | 'image_small'
  | 'image_ratio'
  | 'image_heavy'
  | 'image_gif'
  | 'image_phone_missing'
  | 'long_text_on_image'
  | 'similar_neighbours'
  | 'alt_missing'
  | 'alt_ar_missing'
  | 'not_shown_now'
  | 'target_unavailable'
  | 'repeats_chips'
  | 'retired';

export interface QualityIssue {
  code: QualityCode;
  block_id: string;
  /** the hero slide (0-based) */
  slide?: number;
  /** the banner card (1 or 2) */
  card?: number;
  /** which image: the desktop one or the phone one */
  image?: 'desktop' | 'phone';
}

export interface QualityReport {
  errors: QualityIssue[];
  warnings: QualityIssue[];
}

/** The recommended image shapes (a warning, never a refusal). */
export const IMAGE_SPECS = {
  hero_overlay: {
    desktop: { w: 1920, h: 640, minW: 1200 },
    phone: { w: 1080, h: 1350, minW: 720 },
  },
  hero_split: {
    desktop: { w: 1200, h: 1000, minW: 800 },
    phone: { w: 1080, h: 1350, minW: 720 },
  },
  banner_single: {
    desktop: { w: 1600, h: 400, minW: 1200 },
    phone: { w: 1080, h: 540, minW: 720 },
  },
  banner_double: {
    desktop: { w: 1200, h: 600, minW: 700 },
    phone: { w: 1080, h: 540, minW: 720 },
  },
  card_square: {
    desktop: { w: 800, h: 800, minW: 400 },
    phone: { w: 800, h: 800, minW: 400 },
  },
  card_portrait: {
    desktop: { w: 800, h: 1000, minW: 400 },
    phone: { w: 800, h: 1000, minW: 400 },
  },
} as const;
export const IMAGE_MAX_GOOD_BYTES = Math.round(1.5 * 1024 * 1024);
/** Text over an image longer than this is hard to read (characters). */
export const LONG_ON_IMAGE = { title: 40, text: 100 } as const;

type Spec = { w: number; h: number; minW: number };
type RefStatus = string | undefined;

export interface QualityContext {
  resolver: HomeResolver;
  review: Record<string, BlockReview>;
  offerStatus: (id: string) => RefStatus;
  collectionStatus: (id: string) => RefStatus;
  imageUsable: (url: string) => boolean;
}

const len = (s: string) => [...s].length;
const has = (t: LocalText) => !!(t.ar || t.en);

export function qualityChecks(
  layout: Pick<HomeLayout, 'blocks'>,
  c: QualityContext,
): QualityReport {
  const errors: QualityIssue[] = [];
  const warnings: QualityIssue[] = [];
  const visible = layout.blocks.filter((b) => b.visible);

  const imageWarnings = (
    img: HomeImage,
    spec: Spec,
    at: Omit<QualityIssue, 'code'>,
  ) => {
    if (/\.gif$/i.test(img.url)) warnings.push({ code: 'image_gif', ...at });
    if (img.width && img.height) {
      if (img.width < spec.minW) warnings.push({ code: 'image_small', ...at });
      const want = spec.w / spec.h;
      if (Math.abs(img.width / img.height - want) / want > 0.15) {
        warnings.push({ code: 'image_ratio', ...at });
      }
    }
    if (img.bytes && img.bytes > IMAGE_MAX_GOOD_BYTES) {
      warnings.push({ code: 'image_heavy', ...at });
    }
  };

  /** An image place: an error when empty or gone, else its advice. */
  const imagePlace = (
    desktop: HomeImage | null,
    phone: HomeImage | null,
    spec: { desktop: Spec; phone: Spec },
    at: Omit<QualityIssue, 'code'>,
  ) => {
    if (!desktop || !c.imageUsable(desktop.url)) {
      errors.push({ code: 'no_image', ...at });
      return;
    }
    imageWarnings(desktop, spec.desktop, { ...at, image: 'desktop' });
    if (phone) {
      if (!c.imageUsable(phone.url)) {
        warnings.push({ code: 'image_phone_missing', ...at });
      } else imageWarnings(phone, spec.phone, { ...at, image: 'phone' });
    }
  };

  /** Arabic is the description shoppers get (English falls back to it). */
  const alt = (
    a: LocalText,
    title: LocalText,
    at: Omit<QualityIssue, 'code'>,
  ) => {
    if (a.ar) return;
    if (a.en) warnings.push({ code: 'alt_ar_missing', ...at });
    else if (!title.ar) warnings.push({ code: 'alt_missing', ...at });
  };

  /** A destination: gone for good (error), or not leading anywhere now (warning). */
  const destination = (
    t: HomeTarget | null,
    at: Omit<QualityIssue, 'code'>,
  ) => {
    if (!t) return;
    const state = targetState(t, c);
    if (state === 'invalid') errors.push({ code: 'target_invalid', ...at });
    else if (state === 'unavailable') {
      warnings.push({ code: 'target_unavailable', ...at });
    }
  };

  const heroes = visible.filter((b) => b.type === 'hero');
  for (const extra of heroes.slice(1)) {
    errors.push({ code: 'two_heroes', block_id: extra.id });
  }

  for (const b of visible) {
    const at = { block_id: b.id };
    const review = c.review[b.id];
    switch (b.type) {
      case 'hero': {
        const spec =
          b.variant === 'split'
            ? IMAGE_SPECS.hero_split
            : IMAGE_SPECS.hero_overlay;
        b.slides.forEach((s, slide) => {
          const where = { ...at, slide };
          imagePlace(s.image, s.image_mobile, spec, where);
          if (s.button.ar || s.button.en) {
            if (!s.target) errors.push({ code: 'button_no_target', ...where });
            else destination(s.target, where);
          }
          if (
            b.variant === 'overlay' &&
            (len(s.title.ar) > LONG_ON_IMAGE.title ||
              len(s.text.ar) > LONG_ON_IMAGE.text)
          ) {
            warnings.push({ code: 'long_text_on_image', ...where });
          }
          if (s.image) alt(s.alt, s.title, where);
        });
        break;
      }
      case 'banner': {
        const double = b.variant === 'double';
        const spec = double
          ? IMAGE_SPECS.banner_double
          : IMAGE_SPECS.banner_single;
        const cards: (BannerCard | null)[] = double
          ? [b, b.second]
          : bannerCards(b).slice(0, 1);
        cards.forEach((card, i) => {
          const where = { ...at, card: i + 1 };
          if (!card) {
            errors.push({ code: 'no_image', ...where });
            return;
          }
          imagePlace(card.image, card.image_mobile, spec, where);
          if (double) {
            if (!card.target) errors.push({ code: 'card_no_target', ...where });
            if (!has(card.title) && !has(card.text)) {
              errors.push({ code: 'card_no_text', ...where });
            }
          }
          destination(card.target, where);
          if (
            !double &&
            (len(card.title.ar) > LONG_ON_IMAGE.title ||
              len(card.text.ar) > LONG_ON_IMAGE.text)
          ) {
            warnings.push({ code: 'long_text_on_image', ...where });
          }
          if (card.image) alt(card.alt, card.title, where);
        });
        break;
      }
      case 'collections':
      case 'products': {
        const ids = b.type === 'products' ? b.offer_ids : b.collection_ids;
        const status =
          b.type === 'products' ? c.offerStatus : c.collectionStatus;
        const existing = ids.filter((id) => (status(id) ?? 'ok') !== 'missing');
        if (existing.length < MIN_SHOWN_ITEMS) {
          errors.push({ code: 'too_few_chosen', ...at });
        } else if (review && !review.shown) {
          warnings.push({ code: 'not_shown_now', ...at });
        }
        break;
      }
      case 'auto_products':
        if (review && !review.shown) {
          warnings.push({ code: 'not_shown_now', ...at });
        }
        break;
      case 'categories':
        warnings.push({ code: 'retired', ...at });
        break;
      case 'promo_grid': {
        // «لوحة ترويجية»: each tile complete (image, Arabic title, a button
        // and its destination together or neither); at least two
        let complete = 0;
        b.tiles.forEach((tile, i) => {
          const where = { ...at, card: i + 1 };
          let ok = true;
          if (!tile.image || !c.imageUsable(tile.image.url)) {
            errors.push({ code: 'no_image', ...where });
            ok = false;
          } else {
            // tiles change shape with the layout: size and weight only, never a ratio
            if (/\.gif$/i.test(tile.image.url)) {
              warnings.push({ code: 'image_gif', ...where });
            }
            if (tile.image.width && tile.image.width < 600) {
              warnings.push({ code: 'image_small', ...where });
            }
            if (tile.image.bytes && tile.image.bytes > IMAGE_MAX_GOOD_BYTES) {
              warnings.push({ code: 'image_heavy', ...where });
            }
          }
          if (!tile.title.ar) {
            errors.push({ code: 'card_no_title', ...where });
            ok = false;
          }
          const hasButton = !!(tile.button.ar || tile.button.en);
          if (hasButton && !tile.target) {
            errors.push({ code: 'button_no_target', ...where });
            ok = false;
          } else if (!hasButton && tile.target) {
            errors.push({ code: 'target_no_button', ...where });
            ok = false;
          } else destination(tile.target, where);
          if (tile.image && tile.alt.en && !tile.alt.ar) {
            warnings.push({ code: 'alt_ar_missing', ...where });
          }
          if (ok) complete += 1;
        });
        if (complete < MIN_SHOWN_ITEMS) {
          errors.push({ code: 'too_few_chosen', ...at });
        }
        break;
      }
      case 'category_cards': {
        // «بطاقات التصنيفات»: each card needs its image, an Arabic title and a
        // real destination; at least two complete cards
        const spec =
          b.shape === 'portrait'
            ? IMAGE_SPECS.card_portrait
            : IMAGE_SPECS.card_square;
        let complete = 0;
        b.items.forEach((card, i) => {
          const where = { ...at, card: i + 1 };
          let ok = true;
          if (!card.image || !c.imageUsable(card.image.url)) {
            errors.push({ code: 'no_image', ...where });
            ok = false;
          } else imageWarnings(card.image, spec.desktop, where);
          if (!card.title.ar) {
            errors.push({ code: 'card_no_title', ...where });
            ok = false;
          }
          const known =
            !card.category ||
            c.resolver.categoryKnown(card.audience, card.category);
          if (!known) {
            errors.push({ code: 'target_invalid', ...where });
            ok = false;
          } else {
            const products = card.category
              ? c.resolver.categoryProducts(card.audience, card.category)
              : c.resolver.audienceProducts(card.audience);
            if (products.length === 0) {
              warnings.push({ code: 'target_unavailable', ...where });
            }
          }
          if (card.image && card.alt.en && !card.alt.ar) {
            warnings.push({ code: 'alt_ar_missing', ...where });
          }
          if (ok) complete += 1;
        });
        if (complete < MIN_SHOWN_ITEMS) {
          errors.push({ code: 'too_few_chosen', ...at });
        }
        // the same departments as the fixed chips, in their order, with no line of their own: a repeat
        const departments = c.resolver.departments();
        if (
          b.items.length >= MIN_SHOWN_ITEMS &&
          b.items.every((x) => !x.category && !has(x.text)) &&
          b.items.map((x) => x.audience).join() === departments.join()
        ) {
          warnings.push({ code: 'repeats_chips', ...at });
        }
        break;
      }
      case 'text':
        if (b.style === 'text' && !has(b.title) && !has(b.text)) {
          errors.push({ code: 'empty_text', ...at });
        }
        break;
    }
  }

  // two blocks of the same kind one after the other (dividers excepted)
  for (let i = 1; i < visible.length; i += 1) {
    const [a, b] = [visible[i - 1], visible[i]];
    if (a.type === b.type && !isDivider(a) && !isDivider(b)) {
      warnings.push({ code: 'similar_neighbours', block_id: b.id });
    }
  }
  return { errors, warnings };
}

function isDivider(b: HomeBlock) {
  return b.type === 'text' && b.style === 'divider';
}

function targetState(
  t: HomeTarget,
  c: QualityContext,
): 'ok' | 'unavailable' | 'invalid' {
  switch (t.kind) {
    case 'products':
      return 'ok';
    case 'new':
    case 'sale':
      return c.resolver.autoProducts(t.kind).length > 0 ? 'ok' : 'unavailable';
    case 'collection': {
      const s = c.collectionStatus(t.id);
      return s === 'missing' ? 'invalid' : s === 'ok' ? 'ok' : 'unavailable';
    }
    case 'product': {
      const s = c.offerStatus(t.id);
      return s === 'missing' ? 'invalid' : s === 'ok' ? 'ok' : 'unavailable';
    }
    case 'category':
      if (!c.resolver.categoryKnown(t.audience, t.category)) return 'invalid';
      return c.resolver.categoryProducts(t.audience, t.category).length > 0
        ? 'ok'
        : 'unavailable';
  }
}
