import {
  ProductAudience,
  SizeGroup,
  SizeGuideKind,
  SizeMeasureBasis,
  SizeMeasureKey,
} from '../../generated/prisma/client';

/**
 * PD-4 (PD-FR-003): the pure rules of a size guide - no database here,
 * so every rule is unit-testable. Values travel as centimetres with at
 * most one decimal and are stored as integer tenths of a centimetre.
 */

export const MEASURE_KEYS = Object.values(SizeMeasureKey);

export const MEASURE_LABEL: Record<SizeMeasureKey, { ar: string; en: string }> =
  {
    CHEST: { ar: 'الصدر', en: 'Chest' },
    WAIST: { ar: 'الخصر', en: 'Waist' },
    HIP: { ar: 'الورك', en: 'Hip' },
    LENGTH: { ar: 'الطول', en: 'Length' },
    SHOULDER: { ar: 'الكتف', en: 'Shoulder' },
    SLEEVE: { ar: 'الكم', en: 'Sleeve' },
    INSEAM: { ar: 'طول الساق الداخلي', en: 'Inseam' },
    FOOT_LENGTH: { ar: 'طول القدم', en: 'Foot length' },
    HEIGHT: { ar: 'طول الطفل', en: 'Height' },
  };

/** Plausible range per measurement, in cm (inclusive). */
export const MEASURE_LIMITS_CM: Record<SizeMeasureKey, [number, number]> = {
  CHEST: [40, 200],
  WAIST: [30, 200],
  HIP: [40, 220],
  LENGTH: [20, 200],
  SHOULDER: [25, 70],
  SLEEVE: [20, 100],
  INSEAM: [20, 110],
  FOOT_LENGTH: [8, 35],
  HEIGHT: [40, 180],
};

export const MAX_GUIDE_ROWS = 60;
export const ONE_SIZE = 'ONE_SIZE';

/**
 * PD-4 closing round: taxonomy categories that never take a size guide -
 * accessories sold without body sizes. A guide can't be linked to them,
 * a request can't be sent for them, and any link left over from before is
 * ignored when reading. The taxonomy has no "sized" flag of its own, so
 * this is the one list (exposed to the web via GET /taxonomy).
 */
export const NON_SIZED_CATEGORIES: ReadonlySet<string> = new Set([
  'BAGS',
  'JEWELLERY',
  'WATCHES',
  'EYEWEAR',
  'BELTS',
  'HIJABS_SHAWLS',
  'HATS_CAPS',
  'ACCESSORIES',
  'SOCKS',
  'WALLETS',
  'HAIR_ACCESSORIES',
]);

export function isSizeGuideCategory(categoryCode: string): boolean {
  return !NON_SIZED_CATEGORIES.has(categoryCode);
}

export interface DraftValueInput {
  min: number;
  max?: number | null;
}
export interface DraftInput {
  basis: SizeMeasureBasis;
  notes_ar?: string | null;
  notes_en?: string | null;
  measurements: { key: SizeMeasureKey; is_range: boolean }[];
  rows: {
    size_code: string;
    values: Partial<Record<SizeMeasureKey, DraftValueInput>>;
  }[];
}

export interface SizeInfo {
  group: SizeGroup;
  sortOrder: number;
}

export interface NormalisedDraft {
  basis: SizeMeasureBasis;
  notesAr: string | null;
  notesEn: string | null;
  measurements: { key: SizeMeasureKey; isRange: boolean; sortOrder: number }[];
  rows: {
    sizeCode: string;
    sortOrder: number;
    cells: {
      key: SizeMeasureKey;
      minTenths: number;
      maxTenths: number | null;
    }[];
  }[];
}

export class SizeGuideRuleError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: unknown[] = [],
  ) {
    super(message);
  }
}

/** cm with at most one decimal -> integer tenths, or null if not such a number. */
export function toTenths(cm: unknown): number | null {
  if (typeof cm !== 'number' || !Number.isFinite(cm)) return null;
  const tenths = Math.round(cm * 10);
  return Math.abs(cm * 10 - tenths) < 1e-6 ? tenths : null;
}

export function fromTenths(tenths: number): number {
  return tenths / 10;
}

/** Which size group a guide's audiences call for: KIDS -> KIDS_AGE, WOMEN/MEN -> ADULT. */
export function groupForAudiences(
  audiences: ProductAudience[],
): SizeGroup | 'MIXED' | null {
  if (audiences.length === 0) return null;
  const kids = audiences.includes('KIDS');
  const adult = audiences.some((a) => a !== 'KIDS');
  if (kids && adult) return 'MIXED';
  return kids ? 'KIDS_AGE' : 'ADULT';
}

/**
 * Structure and values of a draft (saved even while incomplete):
 * known, unique measurements and sizes; one size group (ONE_SIZE fits
 * anywhere); the guide's audiences' group; every given value a plain
 * cm number in range with max >= min; STANDARD guides measure the BODY.
 */
export function normaliseDraft(
  input: DraftInput,
  kind: SizeGuideKind,
  sizes: Map<string, SizeInfo>,
  applicableAudiences: ProductAudience[],
): NormalisedDraft {
  if (kind === 'STANDARD' && input.basis !== 'BODY') {
    throw new SizeGuideRuleError(
      'BASIS_NOT_ALLOWED',
      'A standard guide describes body measurements (BODY)',
    );
  }
  if (input.measurements.length === 0 || input.rows.length === 0) {
    throw new SizeGuideRuleError(
      'SIZE_GUIDE_EMPTY',
      'A guide needs at least one measurement and one size',
    );
  }
  const keys = input.measurements.map((m) => m.key);
  const dupKeys = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (dupKeys.length) {
    throw new SizeGuideRuleError(
      'DUPLICATE_MEASUREMENT',
      'Each measurement may appear once',
      dupKeys,
    );
  }
  if (input.rows.length > MAX_GUIDE_ROWS) {
    throw new SizeGuideRuleError(
      'TOO_MANY_ROWS',
      `At most ${MAX_GUIDE_ROWS} sizes`,
    );
  }
  const codes = input.rows.map((r) => r.size_code);
  const dupCodes = codes.filter((c, i) => codes.indexOf(c) !== i);
  if (dupCodes.length) {
    throw new SizeGuideRuleError(
      'DUPLICATE_SIZE',
      'Each size may appear once',
      dupCodes,
    );
  }
  const unknown = codes.filter((c) => !sizes.has(c));
  if (unknown.length) {
    throw new SizeGuideRuleError(
      'UNKNOWN_SIZE',
      `Unknown size code(s): ${unknown.join(', ')}`,
      unknown,
    );
  }
  // One size group per guide (ONE_SIZE fits either), matching the
  // audiences the guide applies to.
  const groups = new Set(
    codes.filter((c) => c !== ONE_SIZE).map((c) => sizes.get(c)!.group),
  );
  if (groups.size > 1) {
    throw new SizeGuideRuleError(
      'SIZE_GROUP_NOT_ALLOWED',
      'A guide holds either adult sizes or kids age sizes, not both',
    );
  }
  const wanted = groupForAudiences(applicableAudiences);
  const have = [...groups][0];
  if (have && wanted && wanted !== 'MIXED' && have !== wanted) {
    throw new SizeGuideRuleError(
      'SIZE_GROUP_NOT_ALLOWED',
      wanted === 'KIDS_AGE'
        ? 'This guide applies to kids - use age sizes'
        : 'This guide applies to adults - age sizes are for kids',
      codes.filter((c) => sizes.get(c)!.group !== wanted && c !== ONE_SIZE),
    );
  }
  const notesAr = cleanNote(input.notes_ar);
  const notesEn = cleanNote(input.notes_en);
  const measurements = input.measurements.map((m, i) => ({
    key: m.key,
    isRange: m.is_range,
    sortOrder: i,
  }));
  const isRange = new Map(measurements.map((m) => [m.key, m.isRange]));
  const rows = [...input.rows]
    .sort(
      (a, b) =>
        sizes.get(a.size_code)!.sortOrder - sizes.get(b.size_code)!.sortOrder,
    )
    .map((r, i) => ({
      sizeCode: r.size_code,
      sortOrder: i,
      cells: Object.entries(r.values ?? {}).map(([k, v]) => {
        const key = k as SizeMeasureKey;
        if (!isRange.has(key)) {
          throw new SizeGuideRuleError(
            'VALUE_FOR_UNKNOWN_MEASUREMENT',
            `${r.size_code}: ${k} is not one of this guide's measurements`,
            [r.size_code, k],
          );
        }
        return cell(r.size_code, key, v as DraftValueInput, isRange.get(key)!);
      }),
    }));
  return { basis: input.basis, notesAr, notesEn, measurements, rows };
}

function cleanNote(note: string | null | undefined): string | null {
  if (note === undefined || note === null) return null;
  const t = note.trim();
  if (t.length > 1000) {
    throw new SizeGuideRuleError(
      'NOTE_TOO_LONG',
      'Notes can be at most 1000 characters',
    );
  }
  return t === '' ? null : t;
}

function cell(
  sizeCode: string,
  key: SizeMeasureKey,
  v: DraftValueInput,
  range: boolean,
) {
  const [lo, hi] = MEASURE_LIMITS_CM[key];
  const min = toTenths(v?.min);
  const max = v?.max === undefined || v?.max === null ? null : toTenths(v.max);
  if (
    min === null ||
    (v?.max !== undefined && v?.max !== null && max === null)
  ) {
    throw new SizeGuideRuleError(
      'INVALID_VALUE',
      `${sizeCode} / ${key}: use a number in cm with at most one decimal`,
      [sizeCode, key],
    );
  }
  for (const t of [min, max]) {
    if (t !== null && (t < lo * 10 || t > hi * 10)) {
      throw new SizeGuideRuleError(
        'SIZE_VALUE_OUT_OF_RANGE',
        `${sizeCode} / ${key}: ${t / 10} cm is outside ${lo}-${hi} cm`,
        [sizeCode, key],
      );
    }
  }
  if (!range && max !== null) {
    throw new SizeGuideRuleError(
      'NOT_A_RANGE',
      `${sizeCode} / ${key}: a single value, not a range`,
      [sizeCode, key],
    );
  }
  if (max !== null && max < min) {
    throw new SizeGuideRuleError(
      'INVALID_RANGE',
      `${sizeCode} / ${key}: "to" is smaller than "from"`,
      [sizeCode, key],
    );
  }
  return { key, minTenths: min, maxTenths: max };
}

/**
 * What publishing additionally requires: every size has every
 * measurement (a range has both ends), and values never decrease from
 * one size to the next (ONE_SIZE, a free size, is outside the order).
 */
export function assertPublishable(draft: NormalisedDraft): void {
  const missing: string[] = [];
  for (const r of draft.rows) {
    for (const m of draft.measurements) {
      const c = r.cells.find((x) => x.key === m.key);
      if (!c || (m.isRange && c.maxTenths === null))
        missing.push(`${r.sizeCode}/${m.key}`);
    }
  }
  if (missing.length) {
    throw new SizeGuideRuleError(
      'SIZE_GUIDE_INCOMPLETE',
      'Every size needs every measurement before publishing',
      missing,
    );
  }
  const ordered = draft.rows.filter((r) => r.sizeCode !== ONE_SIZE);
  const drops: string[] = [];
  for (const m of draft.measurements) {
    for (let i = 1; i < ordered.length; i += 1) {
      const a = ordered[i - 1].cells.find((x) => x.key === m.key)!;
      const b = ordered[i].cells.find((x) => x.key === m.key)!;
      if (
        b.minTenths < a.minTenths ||
        (b.maxTenths ?? b.minTenths) < (a.maxTenths ?? a.minTenths)
      ) {
        drops.push(
          `${ordered[i - 1].sizeCode}>${ordered[i].sizeCode}/${m.key}`,
        );
      }
    }
  }
  if (drops.length) {
    throw new SizeGuideRuleError(
      'SIZE_VALUES_NOT_MONOTONIC',
      'A larger size cannot measure less than the size before it',
      drops,
    );
  }
}

/** The guide audiences a size of this group is described by. */
export function guideFitsSize(
  guideAudiences: ProductAudience[] | 'ALL',
  group: SizeGroup,
): boolean {
  if (guideAudiences === 'ALL') return true;
  return group === 'KIDS_AGE'
    ? guideAudiences.includes('KIDS')
    : guideAudiences.some((a) => a !== 'KIDS');
}

// ---------------------------------------------------------------------
// Phase A+: a product's own measurements (size guide kind OFFER)
// ---------------------------------------------------------------------

const DRESS_KEYS: SizeMeasureKey[] = ['CHEST', 'WAIST', 'HIP', 'LENGTH'];
const TOP_KEYS: SizeMeasureKey[] = ['CHEST', 'SHOULDER', 'SLEEVE', 'LENGTH'];
const BOTTOM_KEYS: SizeMeasureKey[] = ['WAIST', 'HIP', 'INSEAM', 'LENGTH'];
const KIDS_KEYS: SizeMeasureKey[] = ['HEIGHT', 'CHEST', 'WAIST', 'LENGTH'];
const KEYS_BY_CATEGORY: Record<string, SizeMeasureKey[]> = {
  TOPS: TOP_KEYS,
  TSHIRTS: TOP_KEYS,
  SHIRTS: TOP_KEYS,
  BLOUSES_MEN: TOP_KEYS,
  JACKETS: TOP_KEYS,
  COATS: TOP_KEYS,
  BLAZERS: TOP_KEYS,
  CARDIGANS: TOP_KEYS,
  HOODIES: TOP_KEYS,
  SWEATSHIRTS: TOP_KEYS,
  KNITWEAR: TOP_KEYS,
  TROUSERS: BOTTOM_KEYS,
  FORMAL_TROUSERS: BOTTOM_KEYS,
  JEANS: BOTTOM_KEYS,
  SHORTS: BOTTOM_KEYS,
  LEGGINGS: BOTTOM_KEYS,
  SKIRTS: ['WAIST', 'HIP', 'LENGTH'],
  SHOES: ['FOOT_LENGTH'],
};

/**
 * The garment measurements a seller can enter for a product of this
 * category (and audience): dresses and sets chest/waist/hip/length, tops
 * and coats chest/shoulder/sleeve/length, trousers waist/hip/inseam/length
 * (skirts without inseam), kids height/chest/waist/length, shoes foot
 * length, accessories none.
 */
export function measureKeysFor(
  categoryCode: string | null | undefined,
  audience: ProductAudience | null | undefined,
): SizeMeasureKey[] {
  if (!categoryCode || !isSizeGuideCategory(categoryCode)) return [];
  if (categoryCode === 'SHOES') return ['FOOT_LENGTH'];
  if (audience === 'KIDS') return KIDS_KEYS;
  return KEYS_BY_CATEGORY[categoryCode] ?? DRESS_KEYS;
}

/** What the seller entered: the chosen measurements and a value (cm) per size and measurement. */
export interface OfferMeasurementsInput {
  keys: SizeMeasureKey[];
  values: Record<string, Partial<Record<SizeMeasureKey, number>>>;
}

/**
 * True when the seller chose no measurement (no table). Choosing one is
 * what starts the table - from then on its values are required.
 */
export function measurementsEmpty(
  m: OfferMeasurementsInput | null | undefined,
): boolean {
  return !m || (m.keys ?? []).length === 0;
}

/**
 * The seller's table as a guide draft (garment, single values), checked
 * against the product. The seller first CHOOSES the measurements that
 * matter for this piece (a dress: chest, waist, length - never a forced
 * hip, shoulder or sleeve); each chosen one then needs its value for
 * every size of the product (only its own sizes), never decreasing from
 * one size to the next. A measurement not chosen is never required.
 * `null` when none is chosen (the product simply has no table of its own).
 */
export function offerMeasurementsDraft(
  m: OfferMeasurementsInput | null | undefined,
  productSizes: string[],
  allowedKeys: SizeMeasureKey[],
  sizes: Map<string, SizeInfo>,
): NormalisedDraft | null {
  if (measurementsEmpty(m)) return null;
  const keys = [...new Set(m!.keys)];
  const notAllowed = keys.filter((k) => !allowedKeys.includes(k));
  if (notAllowed.length) {
    throw new SizeGuideRuleError(
      'MEASUREMENT_NOT_FOR_CATEGORY',
      `Not a measurement of this category: ${notAllowed.join(', ')}`,
      notAllowed,
    );
  }
  const strange = Object.keys(m!.values).filter(
    (code) => !productSizes.includes(code),
  );
  if (strange.length) {
    throw new SizeGuideRuleError(
      'SIZE_NOT_IN_PRODUCT',
      `Not a size of this product: ${strange.join(', ')}`,
      strange,
    );
  }
  for (const [code, row] of Object.entries(m!.values)) {
    const extra = Object.keys(row ?? {}).filter(
      (k) => !keys.includes(k as SizeMeasureKey),
    );
    if (extra.length) {
      throw new SizeGuideRuleError(
        'VALUE_FOR_UNKNOWN_MEASUREMENT',
        `${code}: ${extra.join(', ')} is not one of the chosen measurements`,
        [code, ...extra],
      );
    }
  }
  const input: DraftInput = {
    basis: 'GARMENT',
    measurements: keys.map((key) => ({ key, is_range: false })),
    rows: productSizes.map((size_code) => ({
      size_code,
      values: Object.fromEntries(
        Object.entries(m!.values[size_code] ?? {})
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => [k, { min: v as number }]),
      ),
    })),
  };
  const draft = normaliseDraft(input, 'OFFER', sizes, []);
  assertPublishable(draft);
  return draft;
}

/**
 * The seller's table from an untrusted body (a request or a saved draft):
 * `{ keys: [...], values: { SIZE: { KEY: cm } } }`, or null for none.
 * Shape only - what is allowed for the product is checked by
 * offerMeasurementsDraft. A blank cell (null / '') is simply not entered.
 */
export function parseMeasurementsInput(
  raw: unknown,
): OfferMeasurementsInput | null {
  if (raw === undefined || raw === null) return null;
  const bad = (msg: string) =>
    new SizeGuideRuleError('INVALID_MEASUREMENTS', msg);
  if (typeof raw !== 'object' || Array.isArray(raw))
    throw bad('measurements must be an object');
  const r = raw as { keys?: unknown; values?: unknown };
  if (!Array.isArray(r.keys) || r.keys.length > MEASURE_KEYS.length)
    throw bad('measurements.keys must be a list of measurements');
  for (const k of r.keys)
    if (!MEASURE_KEYS.includes(k as SizeMeasureKey))
      throw bad(`Unknown measurement: ${String(k)}`);
  const values: OfferMeasurementsInput['values'] = {};
  if (r.values !== undefined && r.values !== null) {
    if (typeof r.values !== 'object' || Array.isArray(r.values))
      throw bad('measurements.values must be an object');
    const rows = Object.entries(r.values as Record<string, unknown>);
    if (rows.length > MAX_GUIDE_ROWS) throw bad('Too many sizes');
    for (const [size, row] of rows) {
      if (!/^[A-Z0-9_]{1,40}$/.test(size)) throw bad('Invalid size code');
      if (typeof row !== 'object' || row === null || Array.isArray(row))
        throw bad(`measurements.values.${size} must be an object`);
      const cells: Partial<Record<SizeMeasureKey, number>> = {};
      for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
        if (!MEASURE_KEYS.includes(k as SizeMeasureKey))
          throw bad(`Unknown measurement: ${k}`);
        if (v === null || v === undefined || v === '') continue;
        if (typeof v !== 'number' || !Number.isFinite(v))
          throw bad(`${size} / ${k}: a number in cm`);
        cells[k as SizeMeasureKey] = v;
      }
      values[size] = cells;
    }
  }
  return { keys: r.keys as SizeMeasureKey[], values };
}
