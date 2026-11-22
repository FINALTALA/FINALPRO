import { IMPORT_TEMPLATE_HEADERS } from './failed-rows-csv';

/**
 * Phase A++ (condition 7): the product-entry fields the file import does
 * NOT take yet. A value sent in one of these columns is never silently
 * dropped: the import result lists the column and the rows it was in as
 * «لم يُستورد بعد», the template response names them, and the import
 * page's guide says so. (fit / stretch / occasion / care ARE imported -
 * inside template_attributes_json, checked against their closed lists.)
 */
export const NOT_IMPORTED_YET_COLUMNS: Record<string, string> = {
  model_height_cm: 'MODEL',
  model_size: 'MODEL',
  shared_images: 'SHARED_IMAGES',
  measurements_json: 'MEASUREMENTS',
  discount_percent: 'DISCOUNT_WINDOW',
  discount_start_at: 'DISCOUNT_WINDOW',
  discount_end_at: 'DISCOUNT_WINDOW',
};

/** Columns that carry no product data (the failed-rows file adds this one). */
const IGNORED_SAFELY = new Set(['error_reason']);

export interface NotImportedColumn {
  column: string;
  /** NOT_IMPORTED_YET: a known field the import does not take yet; UNKNOWN_COLUMN: not a template column. */
  reason: 'NOT_IMPORTED_YET' | 'UNKNOWN_COLUMN';
  /** For NOT_IMPORTED_YET: which product field (MODEL, SHARED_IMAGES, MEASUREMENTS, DISCOUNT_WINDOW). */
  field: string | null;
  /** The file's row numbers (the header is row 1) where the column had a value. */
  rows: number[];
}

/** Every non-template column that has a value in at least one row. */
export function notImportedValues(
  rows: Record<string, string>[],
): NotImportedColumn[] {
  const known = new Set<string>(IMPORT_TEMPLATE_HEADERS);
  const found = new Map<string, number[]>();
  rows.forEach((row, i) => {
    for (const [column, value] of Object.entries(row)) {
      const name = column.trim();
      if (!name || known.has(name) || IGNORED_SAFELY.has(name)) continue;
      if (value === undefined || value === null || String(value).trim() === '')
        continue;
      const list = found.get(name) ?? [];
      list.push(i + 2);
      found.set(name, list);
    }
  });
  return [...found.entries()]
    .map(([column, rowNumbers]) => ({
      column,
      reason:
        column in NOT_IMPORTED_YET_COLUMNS
          ? ('NOT_IMPORTED_YET' as const)
          : ('UNKNOWN_COLUMN' as const),
      field: NOT_IMPORTED_YET_COLUMNS[column] ?? null,
      rows: rowNumbers,
    }))
    .sort((a, b) => a.column.localeCompare(b.column));
}
