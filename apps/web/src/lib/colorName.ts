/**
 * Product colours (web side). The same name rule as the server and the
 * database (apps/api/src/offers/color-name.ts, normalize_color_name): trim
 * and collapse spaces; \u0623/\u0625/\u0622 -> \u0627, \u0629 -> \u0647, \u0649 -> \u064A; no tashkeel,
 * tatweel or direction marks; Latin case-insensitive. The server decides
 * (COLOR_NAME_TAKEN); this only warns while typing.
 */
const MARKS = /[\u064B-\u065F\u0670\u0640\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const SPACES = /[ \t\n\v\f\r\u00A0]+/g;

export function normalizeColorName(name: string): string {
  return name
    .replace(MARKS, "")
    .replace(/[\u0623\u0625\u0622]/g, "\u0627")
    .replace(/\u0649/g, "\u064A")
    .replace(/\u0629/g, "\u0647")
    .replace(SPACES, " ")
    .replace(/^ +| +$/g, "")
    .toLowerCase();
}

export const MAX_PRODUCT_COLORS = 30;
export const COLOR_NAME_MAX = 40;

/** What a colour circle shows: the fabric swatch, else its own HEX, else the family's colour. */
export interface SwatchSource {
  swatch_url?: string | null;
  hex?: string | null;
  family_hex?: string | null;
}
export function swatchBackground(s: SwatchSource): string {
  if (s.swatch_url) return `center / cover no-repeat url("${s.swatch_url.replace(/"/g, "%22")}")`;
  return s.hex || s.family_hex || "transparent";
}

/** A colour's name in the interface language: English empty -> the Arabic name itself. */
export function colorDisplayName(c: { name_ar: string; name_en?: string | null }, lang: string): string {
  return lang === "en" ? (c.name_en ?? "").trim() || c.name_ar : c.name_ar;
}

/** A new colour's key: the family code, then FAMILY-2, FAMILY-3... (stable, readable). */
export function nextColorKey(used: string[], family: string): string {
  if (!used.includes(family)) return family;
  for (let n = 2; ; n++) if (!used.includes(`${family}-${n}`)) return `${family}-${n}`;
}

/** The quick path: the family's name, or "name 2", "name 3"... when the product already has it. */
export function autoColorName(usedNames: string[], familyName: string): string {
  const taken = new Set(usedNames.map(normalizeColorName));
  if (!taken.has(normalizeColorName(familyName))) return familyName;
  for (let n = 2; ; n++) if (!taken.has(normalizeColorName(`${familyName} ${n}`))) return `${familyName} ${n}`;
}
