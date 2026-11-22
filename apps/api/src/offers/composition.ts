import { BadRequestException } from '@nestjs/common';

/**
 * Fabric composition and country of origin (2026-11-19): what a garment is
 * really made of, per part, and where it was made - for the WHOLE product
 * (not per colour or size). Separate from «الخامة» (a free-text spec and a
 * quick filter): never linked or checked against it.
 *
 * One set of rules for every path: the wizard's draft (incomplete allowed
 * while typing), the publish gate (a part with fibres must total exactly
 * 100%), the edit of a published product, the import, and the one view the
 * published page and the draft preview both use.
 */

/** The garment's parts - fixed, in this order. */
export const COMPOSITION_PARTS = [
  'SHELL',
  'LINING',
  'FILLING',
  'TRIM',
] as const;
export type CompositionPart = (typeof COMPOSITION_PARTS)[number];

/** The fibres - names are the pages' words; OTHER carries its own name. */
export const COMPOSITION_FIBERS = [
  'COTTON',
  'POLYESTER',
  'ELASTANE',
  'VISCOSE',
  'LYOCELL',
  'MODAL',
  'LINEN',
  'WOOL',
  'SILK',
  'POLYAMIDE',
  'ACRYLIC',
  'CASHMERE',
  'LEATHER',
  'FAUX_LEATHER',
  'OTHER',
] as const;
export type CompositionFiber = (typeof COMPOSITION_FIBERS)[number];

export const MAX_FIBERS_PER_PART = 6;
const MAX_OTHER_NAME = 40;

export interface CompositionFiberRow {
  fiber: CompositionFiber;
  /** OTHER only: the fibre's own name (Arabic required to publish, English optional). */
  other_ar?: string;
  other_en?: string;
  /** A whole number 1-100; null while the seller has not typed it yet. */
  percent: number | null;
}
export interface CompositionPartRow {
  part: CompositionPart;
  fibers: CompositionFiberRow[];
}
export interface Composition {
  parts: CompositionPartRow[];
}

const invalid = (message: string) =>
  new BadRequestException({ code: 'INVALID_COMPOSITION', message });

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A region code the platform knows (ISO 3166-1 alpha-2), by the runtime's
 * own region names - never a made-up code.
 */
export function isCountryCode(code: unknown): code is string {
  if (typeof code !== 'string' || !/^[A-Z]{2}$/.test(code)) return false;
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(code);
    return !!name && name !== code;
  } catch {
    return false;
  }
}

/**
 * The draft's composition as saved: its SHAPE is checked (known parts and
 * fibres, each part once, a fibre once per part, at most 6 fibres, a
 * percent a whole number 1-100 when given) - an unfinished total is kept
 * (the seller is still typing); the publish gate names it. Empty parts are
 * dropped; nothing left = null.
 */
export function normaliseComposition(raw: unknown): Composition | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw) || !Array.isArray(raw.parts))
    throw invalid('composition must be { parts: [...] }');
  const parts: CompositionPartRow[] = [];
  for (const p of raw.parts) {
    if (!isRecord(p)) throw invalid('a composition part must be an object');
    if (!COMPOSITION_PARTS.includes(p.part as CompositionPart))
      throw invalid(`unknown composition part ${String(p.part)}`);
    if (parts.some((x) => x.part === p.part))
      throw invalid(`the part ${String(p.part)} is given twice`);
    if (!Array.isArray(p.fibers)) throw invalid('fibers must be a list');
    if (p.fibers.length > MAX_FIBERS_PER_PART)
      throw invalid(`at most ${MAX_FIBERS_PER_PART} fibres per part`);
    const fibers: CompositionFiberRow[] = [];
    for (const f of p.fibers) {
      if (!isRecord(f)) throw invalid('a fibre must be an object');
      if (!COMPOSITION_FIBERS.includes(f.fiber as CompositionFiber))
        throw invalid(`unknown fibre ${String(f.fiber)}`);
      const percent = f.percent ?? null;
      if (
        percent !== null &&
        (typeof percent !== 'number' ||
          !Number.isInteger(percent) ||
          percent < 1 ||
          percent > 100)
      )
        throw invalid('a percent is a whole number from 1 to 100');
      const row: CompositionFiberRow = {
        fiber: f.fiber as CompositionFiber,
        percent: percent as number | null,
      };
      if (row.fiber === 'OTHER') {
        for (const k of ['other_ar', 'other_en'] as const) {
          const v = f[k];
          if (v === undefined || v === null) continue;
          if (typeof v !== 'string' || v.trim().length > MAX_OTHER_NAME)
            throw invalid(
              `${k} is text of at most ${MAX_OTHER_NAME} characters`,
            );
          if (v.trim()) row[k] = v.trim();
        }
        // two «other» fibres with the same name are the same fibre
        const name = (row.other_ar ?? '').toLowerCase();
        if (
          name &&
          fibers.some(
            (x) =>
              x.fiber === 'OTHER' && (x.other_ar ?? '').toLowerCase() === name,
          )
        )
          throw invalid(`the fibre ${name} is given twice in a part`);
      } else if (fibers.some((x) => x.fiber === row.fiber))
        throw invalid(`the fibre ${row.fiber} is given twice in a part`);
      fibers.push(row);
    }
    if (fibers.length > 0)
      parts.push({ part: p.part as CompositionPart, fibers });
  }
  parts.sort(
    (a, b) =>
      COMPOSITION_PARTS.indexOf(a.part) - COMPOSITION_PARTS.indexOf(b.part),
  );
  return parts.length > 0 ? { parts } : null;
}

/** The country of origin as saved: a known ISO 3166-1 alpha-2 code, or null. */
export function normaliseCountry(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const code = typeof raw === 'string' ? raw.trim().toUpperCase() : raw;
  if (!isCountryCode(code))
    throw new BadRequestException({
      code: 'INVALID_COUNTRY',
      message: 'The country of origin must be an ISO 3166-1 alpha-2 code',
    });
  return code;
}

/**
 * What stops publishing (never the absence - that is only a hint): per
 * part, a fibre without its percent, an «other» fibre without its Arabic
 * name, a total that is not exactly 100%.
 */
export function compositionProblems(
  c: Composition | null | undefined,
): string[] {
  const problems: string[] = [];
  for (const p of c?.parts ?? []) {
    if (p.fibers.some((f) => f.percent === null))
      problems.push(`COMPOSITION_PERCENT:${p.part}`);
    if (p.fibers.some((f) => f.fiber === 'OTHER' && !f.other_ar))
      problems.push(`COMPOSITION_OTHER:${p.part}`);
    const total = p.fibers.reduce((n, f) => n + (f.percent ?? 0), 0);
    if (total !== 100) problems.push(`COMPOSITION_SUM:${p.part}`);
  }
  return problems;
}

/** A published product's composition and country, as the published page and the draft preview show them. */
export function compositionView(
  composition: unknown,
  country: string | null | undefined,
): {
  composition: Composition | null;
  country_of_origin: string | null;
} {
  let c: Composition | null = null;
  try {
    c = normaliseComposition(composition);
  } catch {
    c = null; // never shown when it is not valid
  }
  return {
    composition: c && compositionProblems(c).length === 0 ? c : null,
    country_of_origin: country && isCountryCode(country) ? country : null,
  };
}

/** The value a published product stores (only a complete composition). */
export function compositionForOffer(c: Composition | null | undefined) {
  if (!c || c.parts.length === 0) return null;
  const problems = compositionProblems(c);
  if (problems.length > 0)
    throw new BadRequestException({
      code: 'COMPOSITION_INCOMPLETE',
      message: 'Each part of the composition must total exactly 100%',
      details: problems.map((code) => ({ code })),
    });
  return c;
}
