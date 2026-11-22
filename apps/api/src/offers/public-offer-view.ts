import { bucketForStock } from '../common/availability.util';
import {
  computeEffectivePrice,
  isEffectivelyDiscounted,
  PriceConfig,
} from './pricing/effective-price.util';

/**
 * Phase A++ (item 3): the pieces of the shopper's product page that the
 * draft preview must show EXACTLY as the published page does - one
 * function each, used by both GET /storefronts/:slug/offers/:id and
 * GET /vendors/:v/offer-drafts/:d/preview, so the two cannot drift.
 */

interface Labels {
  colorByCode: Map<string, { nameAr: string }>;
  sizeByCode: Map<string, { label: string }>;
}

/** The price a shopper sees: the base price and, only while a discount is live, the effective price. */
export function variantPriceView(v: PriceConfig, now: Date = new Date()) {
  return {
    base_price: String(v.basePrice),
    // Sprint 17 (blocker 1): the live effective price (manual override OR
    // an active scheduled discount), computed read-only.
    sale_price: isEffectivelyDiscounted(v, now)
      ? computeEffectivePrice(v, now).toString()
      : null,
  };
}

export function colorLabel(t: Labels, code: string | null) {
  return code ? (t.colorByCode.get(code)?.nameAr ?? code) : null;
}

export function sizeLabel(t: Labels, code: string | null) {
  return code ? (t.sizeByCode.get(code)?.label ?? code) : null;
}

/** «العارضة طولها … وترتدي …» - only when both are set. */
export function modelView(
  t: Labels,
  heightCm: number | null,
  size: string | null,
) {
  return heightCm !== null && size !== null
    ? {
        height_cm: heightCm,
        size_code: size,
        size_label: sizeLabel(t, size)!,
      }
    : null;
}

/**
 * Product colours: one colour of a product as the shopper's page gets it -
 * its id (what a version and the cart refer to), its family (filters; and
 * the default swatch colour), its names (English empty: the page shows the
 * Arabic one), its own HEX and fabric swatch, and the seller's order. The
 * page shows the swatch image, else the HEX, else the family's colour - and
 * the name as text, always.
 */
export function productColorView(
  c: {
    id: string;
    familyCode: string;
    nameAr: string;
    nameEn: string | null;
    hex: string | null;
    swatchUrl: string | null;
    sortOrder: number;
  },
  families: { code: string; hex: string | null }[],
) {
  return {
    id: c.id,
    family_code: c.familyCode,
    family_hex: families.find((f) => f.code === c.familyCode)?.hex ?? null,
    name_ar: c.nameAr,
    name_en: c.nameEn,
    hex: c.hex,
    swatch_url: c.swatchUrl,
    sort_order: c.sortOrder,
  };
}

/** One image of a version, in display order. */
export function mediaView(m: {
  url: string;
  kind: string;
  mediaType: string;
  altTextAr: string | null;
  altTextEn: string | null;
  sortOrder: number;
}) {
  return {
    url: m.url,
    kind: m.kind,
    media_type: m.mediaType,
    alt_text_ar: m.altTextAr,
    alt_text_en: m.altTextEn,
    sort_order: m.sortOrder,
  };
}

/** One combination of a product colour x size, with its sellable stock. */
export interface OptionCombination {
  variantId: string;
  colorId: string | null;
  colorCode: string | null;
  sizeCode: string | null;
  available: number;
}

/**
 * The product page's choices - built the same way for the published
 * product (GET /storefronts/:slug/offers/:id/options) and for a draft's
 * preview: EVERY combination of the product, a sold-out one included (with
 * its «sold_out» bucket: the shopper can still choose it to ask for an
 * availability alert), and the colours (in the seller's order) and sizes
 * (in the platform's order) that have at least one. Exact stock is never
 * exposed - buckets only.
 */
export function productOptionChoices<
  C extends { id: string },
  S extends { code: string; label: string; group: string },
>(colors: C[], sizes: S[], combinations: OptionCombination[]) {
  const colorIds = new Set(
    combinations.map((c) => c.colorId).filter((c): c is string => !!c),
  );
  const sizeCodes = new Set(
    combinations.map((c) => c.sizeCode).filter((c): c is string => !!c),
  );
  return {
    colors: colors.filter((c) => colorIds.has(c.id)),
    sizes: sizes
      .filter((s) => sizeCodes.has(s.code))
      .map((s) => ({ code: s.code, label: s.label, group: s.group })),
    combinations: combinations.map((c) => ({
      variant_id: c.variantId,
      color_id: c.colorId ?? null,
      color_code: c.colorCode,
      size_code: c.sizeCode,
      availability: bucketForStock(c.available),
    })),
  };
}
