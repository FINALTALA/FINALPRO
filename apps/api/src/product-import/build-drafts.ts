import { ProductAudience } from '../../generated/prisma/client';
import { normalizeColorName } from '../offers/color-name';
import { normalizeBarcode } from '../common/barcode.util';
import {
  CLOTHING_CATEGORY_TEMPLATE_FIELDS,
  CLOSED_SPEC_VALUES,
  MULTI_VALUE_SPECS,
} from '../offers/catalog/clothing-category-templates';
import {
  CATEGORY_SPEC_TEMPLATE,
  MAX_COLORS,
  MAX_SIZES_PER_COLOR,
  sizeSystemOf,
  versionKey,
  type DraftColor,
  type DraftDiscount,
  type DraftPayload,
  type SizeSystem,
} from '../offer-drafts/draft-payload';
import { measureKeysFor } from '../size-guides/size-guide-rules';
import type {
  CompositionPart,
  CompositionPartRow,
} from '../offers/composition';
import { countryFromCell, parseCompositionCell } from './import-composition';
import {
  COMPOSITION_COLUMNS,
  headerKey,
  MEASURE_WORDS,
  NO_BRAND,
  plain,
  PRODUCT_COLUMNS,
  QTY_PREFIX,
  SHEETS,
  SIZE_SYSTEM_WORDS,
  SPEC_FIELD_WORDS,
  SPEC_PREFIX,
  SPEC_VALUE_WORDS,
  VERSION_COLUMNS,
  type Words,
} from './import-labels';
import { sheetOf, type SheetRows } from './workbook';

/**
 * The product import: an uploaded workbook's rows -> one wizard draft per
 * product (the wizard's own DraftPayload - nothing parallel), or the reasons
 * it cannot be one, each by sheet, row and column. Creates nothing.
 */

/** 2026-11-18 (images in bulk): 100 for now - raised only after measuring (memory, time). */
export const MAX_IMPORT_PRODUCTS = 100;
export const MAX_IMPORT_VERSION_ROWS = 3000;

export type SheetKey =
  'products' | 'versions' | 'measurements' | 'images' | 'zip' | 'file';
export interface ImportProblem {
  sheet: SheetKey;
  /** The file's own row number (the header is row 1); null for the whole sheet / file. */
  row: number | null;
  /** The column as written in the file; null for a whole row. */
  column: string | null;
  code: string;
  /** What was found (for the message), when it helps. */
  value?: string;
  /** The image file inside the ZIP the problem is about, when there is one. */
  file?: string;
}

export interface BuiltProduct {
  ref: string;
  title: string;
  /** The rows it came from («المنتجات» row, then its colour x size rows). */
  productRow: number;
  versionRows: number[];
  errors: ImportProblem[];
  warnings: ImportProblem[];
  /**
   * Its barcode cell's problems (a wrong code, one already used, one written
   * on two products): fixable on the check's own page, so they never refuse
   * the product - its draft is built without a barcode instead.
   */
  barcodeErrors: ImportProblem[];
  payload: DraftPayload | null;
  /** The same product, compared loosely: name + category + its colours. */
  fingerprint: string | null;
  /** Its colours (even when rejected): the normalised name -> the draft's colour key - the images link to them. */
  colorKeys: { nameKey: string; key: string; name: string }[];
}

export interface BuildContext {
  categories: {
    code: string;
    nameAr: string;
    nameEn: string;
    audiences: ProductAudience[];
  }[];
  colors: { code: string; nameAr: string; nameEn: string }[];
  sizes: { code: string; label: string }[];
  branches: { id: string; name: string }[];
  brands: { id: string; name: string }[];
  collections: { id: string; name: string; nameEn: string | null }[];
  audiences: { code: ProductAudience; nameAr: string; nameEn: string }[];
  /** the store's codes in use (products, and its other open drafts): normalized code -> product name */
  usedBarcodes: Map<string, string>;
}

/** A value matched to a code by its words (Arabic, English or the code itself). */
function byWords<T extends { code: string }>(
  items: T[],
  value: string,
  words: (x: T) => string[],
): T | null {
  const v = plain(value);
  return (
    items.find((x) => [x.code, ...words(x)].some((w) => plain(w) === v)) ?? null
  );
}

const num = (v: string | null): number | null => {
  if (v === null) return null;
  const n = Number(
    v
      .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(',', '.'),
  );
  return Number.isFinite(n) ? n : null;
};

/** A date as ISO (a date cell, or 2026-12-01 / 01/12/2026 typed). */
function isoDate(v: string | null): string | null {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return v;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v) ?? null;
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toISOString();
  const d = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (d) return new Date(Date.UTC(+d[3], +d[2] - 1, +d[1])).toISOString();
  return null;
}

const splitList = (v: string) =>
  v
    .split(/[،,؛;]/)
    .map((x) => x.trim())
    .filter(Boolean);

/** Columns of a sheet: the known ones by key, plus prefixed ones (quantities, specifications, measurements). */
function columnsOf<K extends string>(
  sheet: SheetRows,
  known: Record<K, Words>,
): {
  index: Partial<Record<K, number>>;
  prefixed: {
    index: number;
    header: string;
    rest: string;
    kind: 'qty' | 'spec';
  }[];
  unknown: string[];
} {
  const index: Partial<Record<K, number>> = {};
  const prefixed: {
    index: number;
    header: string;
    rest: string;
    kind: 'qty' | 'spec';
  }[] = [];
  const unknown: string[] = [];
  sheet.headers.forEach((h, i) => {
    if (!h) return;
    const k = headerKey(h, known);
    if (k) {
      index[k] = i;
      return;
    }
    for (const [kind, prefix] of [
      ['qty', QTY_PREFIX],
      ['spec', SPEC_PREFIX],
    ] as const) {
      for (const p of [prefix.ar, prefix.en]) {
        if (plain(h).startsWith(plain(p))) {
          prefixed.push({
            index: i,
            header: h,
            rest: h.slice(h.indexOf(':') + 1).trim(),
            kind,
          });
          return;
        }
      }
    }
    unknown.push(h);
  });
  return { index, prefixed, unknown };
}

export function buildDrafts(
  sheets: Map<string, SheetRows>,
  ctx: BuildContext,
): { products: BuiltProduct[]; fileProblems: ImportProblem[] } {
  const fileProblems: ImportProblem[] = [];
  const productsSheet = sheetOf(sheets, SHEETS.products);
  const versionsSheet = sheetOf(sheets, SHEETS.versions);
  const measuresSheet = sheetOf(sheets, SHEETS.measurements);
  if (!productsSheet)
    fileProblems.push({
      sheet: 'file',
      row: null,
      column: null,
      code: 'SHEET_MISSING',
      value: SHEETS.products.ar,
    });
  if (!versionsSheet)
    fileProblems.push({
      sheet: 'file',
      row: null,
      column: null,
      code: 'SHEET_MISSING',
      value: SHEETS.versions.ar,
    });
  if (!productsSheet || !versionsSheet) return { products: [], fileProblems };
  if (productsSheet.rows.length > MAX_IMPORT_PRODUCTS)
    fileProblems.push({
      sheet: 'products',
      row: null,
      column: null,
      code: 'TOO_MANY_PRODUCTS',
      value: String(MAX_IMPORT_PRODUCTS),
    });
  if (versionsSheet.rows.length > MAX_IMPORT_VERSION_ROWS)
    fileProblems.push({
      sheet: 'versions',
      row: null,
      column: null,
      code: 'TOO_MANY_ROWS',
      value: String(MAX_IMPORT_VERSION_ROWS),
    });
  if (productsSheet.rows.length === 0)
    fileProblems.push({
      sheet: 'products',
      row: null,
      column: null,
      code: 'NO_PRODUCTS',
    });

  const pc = columnsOf(productsSheet, PRODUCT_COLUMNS);
  const vc = columnsOf(versionsSheet, VERSION_COLUMNS);
  for (const [key, sheet, cols, known] of [
    ...(
      [
        'ref',
        'title_ar',
        'audience',
        'category',
        'brand',
        'price',
        'size_system',
      ] as const
    ).map(
      (k) =>
        [
          k,
          'products',
          pc.index as Record<string, number>,
          PRODUCT_COLUMNS as Record<string, Words>,
        ] as const,
    ),
    ...(['ref', 'color_name_ar', 'color_family', 'size'] as const).map(
      (k) =>
        [
          k,
          'versions',
          vc.index as Record<string, number>,
          VERSION_COLUMNS as Record<string, Words>,
        ] as const,
    ),
  ]) {
    if (cols[key] === undefined)
      fileProblems.push({
        sheet,
        row: null,
        column: known[key].ar,
        code: 'COLUMN_MISSING',
      });
  }
  for (const h of pc.unknown)
    fileProblems.push({
      sheet: 'products',
      row: null,
      column: h,
      code: 'UNKNOWN_COLUMN',
    });
  for (const h of vc.unknown)
    fileProblems.push({
      sheet: 'versions',
      row: null,
      column: h,
      code: 'UNKNOWN_COLUMN',
    });
  if (fileProblems.some((p) => p.code !== 'UNKNOWN_COLUMN'))
    return { products: [], fileProblems };

  const cell = (cells: (string | null)[], i: number | undefined) =>
    i === undefined ? null : (cells[i] ?? null);
  const colName = (sheet: SheetRows, i: number | undefined) =>
    i === undefined ? null : (sheet.headers[i] ?? null);

  // the branch quantity columns, matched to this store's active branches
  const qtyCols = vc.prefixed
    .filter((p) => p.kind === 'qty')
    .map((p) => ({
      ...p,
      branch: ctx.branches.find((b) => plain(b.name) === plain(p.rest)) ?? null,
    }));
  // the specification columns
  const specCols = pc.prefixed
    .filter((p) => p.kind === 'spec')
    .map((p) => ({
      ...p,
      field:
        Object.entries(SPEC_FIELD_WORDS).find(
          ([, w]) =>
            plain(w.ar) === plain(p.rest) || plain(w.en) === plain(p.rest),
        )?.[0] ?? null,
    }));
  for (const s of specCols)
    if (!s.field)
      fileProblems.push({
        sheet: 'products',
        row: null,
        column: s.header,
        code: 'UNKNOWN_COLUMN',
      });

  // rows of the other sheets, by product number
  const versionsByRef = new Map<
    string,
    { row: number; cells: (string | null)[] }[]
  >();
  const orphanVersions: number[] = [];
  for (const r of versionsSheet.rows) {
    const ref = cell(r.cells, vc.index.ref);
    if (!ref) {
      orphanVersions.push(r.row);
      continue;
    }
    const list = versionsByRef.get(plain(ref)) ?? [];
    list.push(r);
    versionsByRef.set(plain(ref), list);
  }
  const measures = measuresSheet
    ? readMeasures(measuresSheet)
    : new Map<string, MeasureRow[]>();

  const seenRefs = new Set<string>();
  const products: BuiltProduct[] = [];
  // a barcode written on two products of the file: both are refused (which one is right is unknown)
  const fileBarcodes = new Map<
    string,
    { row: number; errors: ImportProblem[]; raw: string; col: string | null }[]
  >();
  for (const r of productsSheet.rows) {
    const errors: ImportProblem[] = [];
    const warnings: ImportProblem[] = [];
    const P = (k: keyof typeof PRODUCT_COLUMNS) => cell(r.cells, pc.index[k]);
    const PC = (k: keyof typeof PRODUCT_COLUMNS) =>
      colName(productsSheet, pc.index[k]);
    const err = (
      k: keyof typeof PRODUCT_COLUMNS,
      code: string,
      value?: string | null,
    ) =>
      errors.push({
        sheet: 'products',
        row: r.row,
        column: PC(k),
        code,
        ...(value ? { value } : {}),
      });

    const ref = P('ref');
    const title = P('title_ar') ?? '';
    if (!ref) err('ref', 'REQUIRED');
    else if (seenRefs.has(plain(ref))) err('ref', 'REF_DUPLICATE', ref);
    if (ref) seenRefs.add(plain(ref));
    if (!title) err('title_ar', 'REQUIRED');

    // audience and category
    const audienceRaw = P('audience');
    const audience = audienceRaw
      ? byWords(ctx.audiences, audienceRaw, (a) => [a.nameAr, a.nameEn])
      : null;
    if (!audienceRaw) err('audience', 'REQUIRED');
    else if (!audience) err('audience', 'UNKNOWN_VALUE', audienceRaw);
    const categoryRaw = P('category');
    const category = categoryRaw
      ? byWords(ctx.categories, categoryRaw, (c) => [c.nameAr, c.nameEn])
      : null;
    if (!categoryRaw) err('category', 'REQUIRED');
    else if (!category) err('category', 'UNKNOWN_VALUE', categoryRaw);
    else if (audience && !category.audiences.includes(audience.code))
      err('category', 'CATEGORY_NOT_IN_AUDIENCE', categoryRaw);

    // brand: an existing one or «بدون علامة تجارية» - never a request from a file
    const brandRaw = P('brand');
    let brand: DraftPayload['brand'] = null;
    if (!brandRaw) err('brand', 'REQUIRED');
    else if (
      [NO_BRAND.ar, NO_BRAND.en].some((w) => plain(w) === plain(brandRaw))
    )
      brand = { mode: 'none' };
    else {
      const b = ctx.brands.find((x) => plain(x.name) === plain(brandRaw));
      if (b) brand = { mode: 'existing', brand_id: b.id };
      else err('brand', 'UNKNOWN_BRAND', brandRaw);
    }

    // price and discount
    const priceRaw = P('price');
    const price = num(priceRaw);
    if (!priceRaw) err('price', 'REQUIRED');
    else if (price === null || price <= 0)
      err('price', 'NOT_A_PRICE', priceRaw);
    let discount: DraftDiscount | null = null;
    const sale = P('sale_price');
    const pct = P('discount_percent');
    const start = P('discount_start');
    const end = P('discount_end');
    if (sale && (pct || start || end)) err('sale_price', 'DISCOUNT_BOTH');
    else if (sale) {
      const s = num(sale);
      if (s === null || s <= 0) err('sale_price', 'NOT_A_PRICE', sale);
      else if (price !== null && s >= price)
        err('sale_price', 'SALE_NOT_BELOW_PRICE', sale);
      else discount = { mode: 'sale', sale_price: s };
    } else if (pct || start || end) {
      const p = num(pct);
      const sIso = isoDate(start);
      const eIso = isoDate(end);
      if (!pct || !start || !end)
        err(
          !pct
            ? 'discount_percent'
            : !start
              ? 'discount_start'
              : 'discount_end',
          'DISCOUNT_INCOMPLETE',
        );
      else if (p === null || p < 1 || p > 99 || !Number.isInteger(p))
        err('discount_percent', 'BAD_PERCENT', pct);
      else if (!sIso) err('discount_start', 'BAD_DATE', start);
      else if (!eIso) err('discount_end', 'BAD_DATE', end);
      else if (sIso >= eIso) err('discount_end', 'DISCOUNT_DATES_ORDER');
      else
        discount = { mode: 'window', percent: p, start_at: sIso, end_at: eIso };
    }

    // size system
    const systemRaw = P('size_system');
    const system = systemRaw
      ? ((Object.entries(SIZE_SYSTEM_WORDS).find(([code, w]) =>
          [code, w.ar, w.en].some((x) => plain(x) === plain(systemRaw)),
        )?.[0] ?? null) as SizeSystem | null)
      : null;
    if (!systemRaw) err('size_system', 'REQUIRED');
    else if (!system) err('size_system', 'UNKNOWN_VALUE', systemRaw);

    // specifications: only the category's own fields; closed lists by their words
    const specs: Record<string, string> = {};
    const template = category
      ? CATEGORY_SPEC_TEMPLATE[category.code]
      : undefined;
    const fields = template ? CLOTHING_CATEGORY_TEMPLATE_FIELDS[template] : [];
    for (const s of specCols) {
      if (!s.field) continue;
      const v = r.cells[s.index];
      if (!v) continue;
      const at = { sheet: 'products' as const, row: r.row, column: s.header };
      if (category && !fields.includes(s.field)) {
        errors.push({ ...at, code: 'SPEC_NOT_FOR_CATEGORY', value: v });
        continue;
      }
      const closed = CLOSED_SPEC_VALUES[s.field];
      if (!closed) {
        if (v.length > 120) errors.push({ ...at, code: 'TOO_LONG', value: v });
        else specs[s.field] = v;
        continue;
      }
      const parts = MULTI_VALUE_SPECS.has(s.field) ? splitList(v) : [v];
      const codes: string[] = [];
      for (const part of parts) {
        const code = closed.find((c) => {
          const w = SPEC_VALUE_WORDS[s.field!]?.[c];
          return [c, w?.ar ?? '', w?.en ?? ''].some(
            (x) => plain(x) === plain(part),
          );
        });
        if (code) codes.push(code);
        else errors.push({ ...at, code: 'UNKNOWN_VALUE', value: part });
      }
      if (codes.length) specs[s.field] = codes.join(',');
    }

    // colours, sizes and stock from «الألوان والمقاسات»
    const vRows = ref ? (versionsByRef.get(plain(ref)) ?? []) : [];
    if (ref && vRows.length === 0)
      errors.push({
        sheet: 'versions',
        row: null,
        column: colName(versionsSheet, vc.index.ref),
        code: 'NO_VERSIONS',
        value: ref,
      });
    type ColorAcc = DraftColor & {
      order: number | null;
      first: number;
      sizes: string[];
    };
    const colors = new Map<string, ColorAcc>();
    const stock: Record<string, Record<string, number>> = {};
    const seenVersions = new Set<string>();
    const sizesOfSystem = system
      ? ctx.sizes.filter((s) => sizeSystemOf(s.code) === system)
      : [];
    for (const v of vRows) {
      const V = (k: keyof typeof VERSION_COLUMNS) => cell(v.cells, vc.index[k]);
      const VC = (k: keyof typeof VERSION_COLUMNS) =>
        colName(versionsSheet, vc.index[k]);
      const verr = (
        k: keyof typeof VERSION_COLUMNS,
        code: string,
        value?: string | null,
      ) =>
        errors.push({
          sheet: 'versions',
          row: v.row,
          column: VC(k),
          code,
          ...(value ? { value } : {}),
        });
      const nameAr = V('color_name_ar');
      if (!nameAr) {
        verr('color_name_ar', 'REQUIRED');
        continue;
      }
      const nameKey = normalizeColorName(nameAr);
      const familyRaw = V('color_family');
      const family = familyRaw
        ? byWords(ctx.colors, familyRaw, (c) => [c.nameAr, c.nameEn])
        : null;
      if (!familyRaw) verr('color_family', 'REQUIRED');
      else if (!family) verr('color_family', 'UNKNOWN_VALUE', familyRaw);
      const hexRaw = V('color_hex');
      const hex = hexRaw
        ? (hexRaw.startsWith('#') ? hexRaw : `#${hexRaw}`).toLowerCase()
        : null;
      if (hex && !/^#[0-9a-f]{6}$/.test(hex))
        verr('color_hex', 'BAD_HEX', hexRaw);
      const orderRaw = V('color_order');
      const order = orderRaw === null ? null : num(orderRaw);
      if (
        orderRaw !== null &&
        (order === null || !Number.isInteger(order) || order < 1)
      )
        verr('color_order', 'NOT_A_NUMBER', orderRaw);
      const nameEn = V('color_name_en');

      let c = colors.get(nameKey);
      if (!c) {
        c = {
          key: `c${colors.size + 1}`,
          family: family?.code ?? null,
          name_ar: nameAr,
          ...(nameEn ? { name_en: nameEn } : {}),
          hex: hex && /^#[0-9a-f]{6}$/.test(hex) ? hex : null,
          images: [],
          order,
          first: v.row,
          sizes: [],
        };
        colors.set(nameKey, c);
      } else {
        // a colour's details are written the same way on each of its rows
        if (family && c.family && family.code !== c.family)
          verr('color_family', 'COLOR_MISMATCH', familyRaw);
        if (nameEn && c.name_en && plain(nameEn) !== plain(c.name_en))
          verr('color_name_en', 'COLOR_MISMATCH', nameEn);
        if (hex && c.hex && hex !== c.hex)
          verr('color_hex', 'COLOR_MISMATCH', hexRaw);
        if (order !== null && c.order !== null && order !== c.order)
          verr('color_order', 'COLOR_MISMATCH', orderRaw);
        c.family ??= family?.code ?? null;
        if (!c.name_en && nameEn) c.name_en = nameEn;
        c.hex ??= hex && /^#[0-9a-f]{6}$/.test(hex) ? hex : null;
        c.order ??= order;
      }

      const sizeRaw = V('size');
      if (!sizeRaw) {
        verr('size', 'REQUIRED');
        continue;
      }
      const size = system
        ? byWords(sizesOfSystem, sizeRaw, (s) => [s.label])
        : null;
      if (!size) {
        const elsewhere = ctx.sizes.find((s) =>
          [s.code, s.label].some((x) => plain(x) === plain(sizeRaw)),
        );
        if (system)
          verr(
            'size',
            elsewhere ? 'SIZE_NOT_IN_SYSTEM' : 'UNKNOWN_VALUE',
            sizeRaw,
          );
        continue;
      }
      const vk = versionKey(c.key, size.code);
      if (seenVersions.has(vk)) {
        verr('size', 'VERSION_DUPLICATE', `${nameAr} / ${sizeRaw}`);
        continue;
      }
      seenVersions.add(vk);
      c.sizes.push(size.code);

      for (const q of qtyCols) {
        const raw = v.cells[q.index];
        if (raw === null) continue;
        const n = num(raw);
        if (!q.branch) {
          errors.push({
            sheet: 'versions',
            row: v.row,
            column: q.header,
            code: 'UNKNOWN_BRANCH',
            value: q.rest,
          });
          continue;
        }
        if (n === null || n < 0 || !Number.isInteger(n) || n > 100_000) {
          errors.push({
            sheet: 'versions',
            row: v.row,
            column: q.header,
            code: 'BAD_QUANTITY',
            value: raw,
          });
          continue;
        }
        if (n > 0) (stock[q.branch.id] ??= {})[vk] = n;
      }
    }
    const colorList = [...colors.values()].sort(
      (a, b) =>
        (a.order ?? Number.MAX_SAFE_INTEGER) -
          (b.order ?? Number.MAX_SAFE_INTEGER) || a.first - b.first,
    );
    if (colorList.length > MAX_COLORS)
      errors.push({
        sheet: 'versions',
        row: null,
        column: null,
        code: 'TOO_MANY_COLORS',
        value: String(MAX_COLORS),
      });
    for (const c of colorList)
      if (c.sizes.length > MAX_SIZES_PER_COLOR)
        errors.push({
          sheet: 'versions',
          row: c.first,
          column: null,
          code: 'TOO_MANY_SIZES',
          value: c.name_ar,
        });
    const allSizes = [...new Set(colorList.flatMap((c) => c.sizes))];

    // the size table (optional)
    let measurements: DraftPayload['measurements'] = null;
    const mRows = ref ? (measures.get(plain(ref)) ?? []) : [];
    if (mRows.length > 0 && category && audience) {
      const allowed = measureKeysFor(category.code, audience.code) as string[];
      const keys = new Set<string>();
      const values: Record<string, Record<string, number>> = {};
      for (const m of mRows) {
        const size = system
          ? byWords(sizesOfSystem, m.size ?? '', (s) => [s.label])
          : null;
        if (!m.size || !size || !allSizes.includes(size.code)) {
          errors.push({
            sheet: 'measurements',
            row: m.row,
            column: m.sizeHeader,
            code: 'MEASURE_SIZE_UNKNOWN',
            value: m.size ?? '',
          });
          continue;
        }
        for (const [key, raw, header] of m.values) {
          if (!allowed.includes(key)) {
            errors.push({
              sheet: 'measurements',
              row: m.row,
              column: header,
              code: 'MEASURE_NOT_FOR_CATEGORY',
              value: raw,
            });
            continue;
          }
          const n = num(raw);
          if (n === null || n <= 0 || n > 400) {
            errors.push({
              sheet: 'measurements',
              row: m.row,
              column: header,
              code: 'NOT_A_NUMBER',
              value: raw,
            });
            continue;
          }
          keys.add(key);
          (values[size.code] ??= {})[key] = n;
        }
      }
      if (keys.size > 0)
        measurements = { keys: [...keys] as never, values: values as never };
    }

    // the model (optional): her height and the size she wears - one of the product's sizes
    let model: DraftPayload['model'] = null;
    const h = P('model_height');
    const ms = P('model_size');
    if (h || ms) {
      const hn = num(h);
      const msCode =
        ms && system
          ? byWords(sizesOfSystem, ms, (s) => [s.label])?.code
          : null;
      if (!h || !ms)
        err(!h ? 'model_height' : 'model_size', 'MODEL_INCOMPLETE');
      else if (hn === null || !Number.isInteger(hn) || hn < 80 || hn > 230)
        err('model_height', 'NOT_A_NUMBER', h);
      else if (!msCode || !allSizes.includes(msCode))
        err('model_size', 'MODEL_SIZE_NOT_IN_PRODUCT', ms);
      else model = { height_cm: hn, size: msCode };
    }

    // collections (optional): this store's own, by name - an unknown one is skipped with a warning
    const sections: string[] = [];
    const colRaw = P('collections');
    if (colRaw) {
      for (const name of splitList(colRaw)) {
        const s = ctx.collections.find(
          (x) =>
            plain(x.name) === plain(name) ||
            (x.nameEn && plain(x.nameEn) === plain(name)),
        );
        if (s) {
          if (!sections.includes(s.id)) sections.push(s.id);
        } else
          warnings.push({
            sheet: 'products',
            row: r.row,
            column: PC('collections'),
            code: 'UNKNOWN_COLLECTION',
            value: name,
          });
      }
    }

    // fabric composition, one cell per part, and the country of origin - both
    // optional; a cell written wrongly (format, fibre, percent, total) is named
    const parts: CompositionPartRow[] = [];
    for (const [key, part] of Object.entries(COMPOSITION_COLUMNS) as [
      keyof typeof COMPOSITION_COLUMNS,
      CompositionPart,
    ][]) {
      const raw = P(key);
      if (!raw) continue;
      const r = parseCompositionCell(raw);
      if ('fibers' in r) parts.push({ part, fibers: r.fibers });
      else err(key, r.code, r.value ?? raw);
    }
    const countryRaw = P('country_of_origin');
    const country = countryRaw ? countryFromCell(countryRaw) : null;
    if (countryRaw && !country)
      err('country_of_origin', 'UNKNOWN_COUNTRY', countryRaw);

    // the product's barcode (optional): checked here; an empty cell makes
    // none. A wrong one never refuses the product: it is fixed on the check
    const barcodeRaw = P('barcode');
    let barcode: string | null = null;
    const barcodeErrors: ImportProblem[] = [];
    const barcodeErr = (code: string, value: string) =>
      barcodeErrors.push({
        sheet: 'products',
        row: r.row,
        column: PC('barcode'),
        code,
        value,
      });
    if (barcodeRaw) {
      const normalized = normalizeBarcode(barcodeRaw);
      if (!normalized.ok)
        barcodeErr(
          `BARCODE_${normalized.problem.replace(/^BARCODE_/, '')}`,
          barcodeRaw,
        );
      else if (ctx.usedBarcodes.has(normalized.code))
        barcodeErr(
          'BARCODE_ALREADY_USED',
          ctx.usedBarcodes.get(normalized.code)!,
        );
      else {
        barcode = normalized.code;
        (
          fileBarcodes.get(barcode) ??
          fileBarcodes.set(barcode, []).get(barcode)!
        ).push({
          row: r.row,
          errors: barcodeErrors,
          raw: barcodeRaw,
          col: PC('barcode'),
        });
      }
    }

    const payload: DraftPayload | null =
      errors.length === 0
        ? {
            layout: 5,
            // imported drafts come complete (images from the ZIP): they open on the review
            step: 5,
            audience: audience!.code,
            category: category!.code,
            title_ar: title,
            ...(P('title_en') ? { title_en: P('title_en')! } : {}),
            brand,
            specs,
            colors: colorList.map((c) => ({
              key: c.key,
              family: c.family,
              name_ar: c.name_ar,
              ...(c.name_en ? { name_en: c.name_en } : {}),
              hex: c.hex ?? null,
              images: [],
            })),
            size_system: system,
            sizes: Object.fromEntries(colorList.map((c) => [c.key, c.sizes])),
            price: price!,
            stock,
            ...(P('description_ar')
              ? { description_ar: P('description_ar')! }
              : {}),
            ...(P('description_en')
              ? { description_en: P('description_en')! }
              : {}),
            measurements,
            discount,
            model,
            sections,
            ...(parts.length > 0 ? { composition: { parts } } : {}),
            ...(country ? { country_of_origin: country } : {}),
            ...(barcode
              ? { store_barcode: { mode: 'external' as const, code: barcode } }
              : {}),
          }
        : null;
    products.push({
      ref: ref ?? `#${r.row}`,
      title: title || `#${r.row}`,
      productRow: r.row,
      versionRows: vRows.map((v) => v.row),
      errors,
      warnings,
      barcodeErrors,
      payload,
      fingerprint:
        title && category
          ? [
              plain(title),
              category.code,
              [...colors.keys()].sort().join('+'),
            ].join('|')
          : null,
      colorKeys: colorList.map((c) => ({
        nameKey: normalizeColorName(c.name_ar),
        key: c.key,
        name: c.name_ar,
      })),
    });
  }
  // colour x size rows that belong to no product of the file
  for (const [ref, rows] of versionsByRef) {
    if (!seenRefs.has(ref))
      for (const v of rows)
        fileProblems.push({
          sheet: 'versions',
          row: v.row,
          column: colName(versionsSheet, vc.index.ref),
          code: 'REF_UNKNOWN',
          value: v.cells[vc.index.ref!] ?? '',
        });
  }
  for (const row of orphanVersions)
    fileProblems.push({
      sheet: 'versions',
      row,
      column: colName(versionsSheet, vc.index.ref),
      code: 'REQUIRED',
    });
  for (const [, rows] of fileBarcodes) {
    if (rows.length < 2) continue;
    for (const x of rows) {
      x.errors.push({
        sheet: 'products',
        row: x.row,
        column: x.col,
        code: 'BARCODE_DUPLICATE_IN_FILE',
        value: x.raw,
      });
      // neither keeps it (which one is right is unknown): both are fixed on the check
      const built = products.find((b) => b.productRow === x.row);
      if (built?.payload) delete built.payload.store_barcode;
    }
  }
  return { products, fileProblems };
}

interface MeasureRow {
  row: number;
  size: string | null;
  sizeHeader: string | null;
  values: [string, string, string][];
}

/** «جدول القياسات»: product no., size, then one column per measurement. */
function readMeasures(sheet: SheetRows): Map<string, MeasureRow[]> {
  const refIdx = sheet.headers.findIndex(
    (h) => headerKey(h, { ref: PRODUCT_COLUMNS.ref }) === 'ref',
  );
  const sizeIdx = sheet.headers.findIndex(
    (h) => headerKey(h, { size: VERSION_COLUMNS.size }) === 'size',
  );
  const keyCols = sheet.headers
    .map((h, i) => ({
      i,
      h,
      key: Object.entries(MEASURE_WORDS).find(([k, w]) =>
        [k, w.ar, w.en].some((x) => plain(x) === plain(h ?? '')),
      )?.[0],
    }))
    .filter((x): x is { i: number; h: string; key: string } => !!x.key);
  const out = new Map<string, MeasureRow[]>();
  for (const r of sheet.rows) {
    const ref = refIdx >= 0 ? r.cells[refIdx] : null;
    if (!ref) continue;
    const list = out.get(plain(ref)) ?? [];
    list.push({
      row: r.row,
      size: sizeIdx >= 0 ? r.cells[sizeIdx] : null,
      sizeHeader: sizeIdx >= 0 ? sheet.headers[sizeIdx] : null,
      values: keyCols
        .filter((k) => r.cells[k.i] !== null)
        .map((k) => [k.key, r.cells[k.i]!, k.h]),
    });
    out.set(plain(ref), list);
  }
  return out;
}
