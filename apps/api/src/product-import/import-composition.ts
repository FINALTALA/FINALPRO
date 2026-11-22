import {
  isCountryCode,
  MAX_FIBERS_PER_PART,
  type CompositionFiber,
  type CompositionFiberRow,
} from '../offers/composition';
import { FIBER_WORDS, OTHER_FIBER, plain } from './import-labels';

/**
 * The product import's fabric composition and country of origin
 * (2026-11-19). One cell per part, written the way a label reads:
 * «95% قطن، 5% إيلاستين» (also «قطن 95%», «95 قطن», English names,
 * Arabic-Indic digits, separated by «،», «,», «؛», «;» or «+»). A fibre
 * not in the list is «أخرى: <الاسم>». A country by its Arabic or English
 * name, or its two-letter code.
 */

const toLatinDigits = (v: string) =>
  v.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));

/** A fibre by any of its words, or null. */
function fiberOf(name: string): CompositionFiber | null {
  const n = plain(name);
  for (const [code, w] of Object.entries(FIBER_WORDS))
    if ([code, w.ar, w.en, ...(w.also ?? [])].some((x) => plain(x) === n))
      return code as CompositionFiber;
  return null;
}

export type CellResult =
  | { ok: true; fibers: CompositionFiberRow[] }
  | { ok: false; code: string; value?: string };

/** One part's cell -> its fibres (whole percents totalling 100), or why not. */
export function parseCompositionCell(text: string): CellResult {
  const items = toLatinDigits(text)
    .split(/[،,؛;+\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (items.length === 0) return { ok: false, code: 'COMPOSITION_EMPTY' };
  if (items.length > MAX_FIBERS_PER_PART)
    return {
      ok: false,
      code: 'COMPOSITION_TOO_MANY',
      value: String(MAX_FIBERS_PER_PART),
    };
  const fibers: CompositionFiberRow[] = [];
  for (const item of items) {
    const m =
      /^(\d+(?:[.]\d+)?)\s*%?\s*(.+)$/.exec(item) ??
      /^(.+?)\s*(\d+(?:[.]\d+)?)\s*%?$/.exec(item);
    if (!m) return { ok: false, code: 'COMPOSITION_NO_PERCENT', value: item };
    const [num, name] = /^\d/.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]];
    const percent = Number(num);
    if (!Number.isInteger(percent) || percent < 1 || percent > 100)
      return { ok: false, code: 'COMPOSITION_BAD_PERCENT', value: num };
    const label = name.replace(/%/g, '').trim();
    // «أخرى: ميتاليك» / «Other: metallic»
    const other = new RegExp(
      `^(${OTHER_FIBER.ar}|${OTHER_FIBER.en})\\s*[:：-]\\s*(.+)$`,
      'i',
    ).exec(label);
    let row: CompositionFiberRow;
    if (other) {
      const own = other[2].trim();
      if (own.length > 40)
        return { ok: false, code: 'COMPOSITION_FIBER_UNKNOWN', value: own };
      row = /[؀-ۿ]/.test(own)
        ? { fiber: 'OTHER', other_ar: own, percent }
        : { fiber: 'OTHER', other_ar: own, other_en: own, percent };
    } else {
      const fiber = fiberOf(label);
      if (!fiber)
        return { ok: false, code: 'COMPOSITION_FIBER_UNKNOWN', value: label };
      row = { fiber, percent };
    }
    const same = fibers.some((f) =>
      row.fiber === 'OTHER'
        ? f.fiber === 'OTHER' &&
          plain(f.other_ar ?? '') === plain(row.other_ar ?? '')
        : f.fiber === row.fiber,
    );
    if (same)
      return { ok: false, code: 'COMPOSITION_FIBER_TWICE', value: label };
    fibers.push(row);
  }
  const total = fibers.reduce((n, f) => n + (f.percent ?? 0), 0);
  if (total !== 100)
    return { ok: false, code: 'COMPOSITION_SUM', value: String(total) };
  return { ok: true, fibers };
}

let countries: { code: string; ar: string; en: string }[] | null = null;
/** Every region the runtime names (ISO 3166-1 alpha-2), with its Arabic and English names. */
export function allCountries() {
  if (countries) return countries;
  const ar = new Intl.DisplayNames(['ar'], { type: 'region' });
  const en = new Intl.DisplayNames(['en'], { type: 'region' });
  const out: { code: string; ar: string; en: string }[] = [];
  for (let a = 65; a <= 90; a += 1)
    for (let b = 65; b <= 90; b += 1) {
      const code = String.fromCharCode(a, b);
      if (isCountryCode(code))
        out.push({ code, ar: ar.of(code) ?? code, en: en.of(code) ?? code });
    }
  countries = out;
  return out;
}

/** The countries most clothing here comes from - first in the template's list. */
export const COMMON_COUNTRIES = [
  'TR',
  'CN',
  'PS',
  'JO',
  'EG',
  'BD',
  'IN',
  'VN',
  'IT',
  'PK',
];

/** The template's list of countries, in its language - the common ones first. */
export function countryNames(lang: 'ar' | 'en'): string[] {
  const all = allCountries();
  const name = (c: { ar: string; en: string }) => (lang === 'en' ? c.en : c.ar);
  const common = COMMON_COUNTRIES.map((code) =>
    all.find((c) => c.code === code)!,
  )
    .filter(Boolean)
    .map(name);
  const rest = all
    .filter((c) => !COMMON_COUNTRIES.includes(c.code))
    .map(name)
    .sort((a, b) => a.localeCompare(b, lang));
  return [...common, ...rest];
}

/** A country by its Arabic or English name, or its two-letter code; null when unknown. */
export function countryFromCell(text: string): string | null {
  const t = text.trim();
  if (/^[A-Za-z]{2}$/.test(t) && isCountryCode(t.toUpperCase()))
    return t.toUpperCase();
  const n = plain(t);
  return (
    allCountries().find((c) => plain(c.ar) === n || plain(c.en) === n)?.code ??
    null
  );
}
