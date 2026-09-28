/**
 * Sprint 17 (D6, blocker 3): serializes ONLY the failed rows
 * (invalid_rows + conflicts - never imported/skipped) back into a
 * re-uploadable CSV, using EXACTLY the upload template's own column
 * headers plus one trailing `error_reason` column - no internal ids,
 * no other vendor's data, nothing beyond what is needed to fix and
 * re-upload. This is an IMMEDIATE, in-response artifact only - it is
 * never persisted (see OffersImportController's own comment on
 * ImportBatch) and cannot be re-downloaded later from batch history.
 */
export const IMPORT_TEMPLATE_HEADERS = [
  'title_ar',
  'title_en',
  'seller_sku',
  'base_price',
  'sale_price',
  'condition',
  'specs_text_ar',
  'specs_text_en',
  'identifier_type',
  'identifier_value',
  'store_inventory_barcode',
  'brand_name',
  'product_type',
  'mpn',
  'category_template',
  'template_attributes_json',
] as const;

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function buildFailedRowsCsv(
  failedRows: { rowNumber: number; raw: Record<string, string>; reason: string }[],
): string {
  const headers = [...IMPORT_TEMPLATE_HEADERS, 'error_reason'];
  const lines = [headers.join(',')];
  for (const { raw, reason } of failedRows) {
    const cells = IMPORT_TEMPLATE_HEADERS.map((h) => csvEscape(raw[h] ?? ''));
    cells.push(csvEscape(reason));
    lines.push(cells.join(','));
  }
  return lines.join('\n');
}
