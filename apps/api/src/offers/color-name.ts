/**
 * Product colours: the ONE rule that makes two Arabic colour names "the
 * same" inside a product - the database applies the identical rule
 * (normalize_color_name, migration 20261118120000) to its unique index, and
 * a test proves the two agree. Trim and collapse spaces; أ/إ/آ -> ا,
 * ة -> ه, ى -> ي; remove tashkeel (U+064B-U+065F, U+0670), tatweel
 * (U+0640) and invisible direction marks; Latin letters case-insensitive.
 */
const MARKS =
  /[\u064B-\u065F\u0670\u0640\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const SPACES = /[ \t\n\v\f\r\u00A0]+/g;

export function normalizeColorName(name: string): string {
  return (
    name
      .replace(MARKS, '')
      .replace(/[\u0623\u0625\u0622]/g, '\u0627')
      .replace(/\u0649/g, '\u064A')
      .replace(/\u0629/g, '\u0647')
      .replace(SPACES, ' ')
      // spaces only, exactly like the database's btrim()
      .replace(/^ +| +$/g, '')
      .toLowerCase()
  );
}

/** At most this many colours in one product (the table's CHECK says the same). */
export const MAX_PRODUCT_COLORS = 30;
export const COLOR_NAME_MAX = 40;
