import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';

/**
 * Sprint 7 (RB-MATCH-004): converts either an uploaded CSV or XLSX
 * file into the same shape - an array of plain row objects keyed by
 * header name (trimmed strings, no type coercion here - each field is
 * validated/coerced per-row by validateImportRow()). No image/video
 * columns are ever read, even if present in the file - RB-MATCH-004's
 * own scope line ("لا تستورد صوراً أو فيديوهات عبر الملف"): media stays
 * manual-only via the existing OfferVariantMedia endpoints (Sprint 6).
 */
export async function parseImportFile(
  buffer: Buffer,
  originalFilename: string,
): Promise<Record<string, string>[]> {
  const lower = originalFilename.toLowerCase();
  if (lower.endsWith('.csv')) {
    return parseCsvBuffer(buffer);
  }
  if (lower.endsWith('.xlsx')) {
    return parseXlsxBuffer(buffer);
  }
  throw new Error('UNSUPPORTED_FILE_TYPE');
}

function parseCsvBuffer(buffer: Buffer): Record<string, string>[] {
  const records = parseCsv(buffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];
  return records;
}

async function parseXlsxBuffer(
  buffer: Buffer,
): Promise<Record<string, string>[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    return [];
  }

  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber] = String(cell.value ?? '').trim();
  });

  const rows: Record<string, string>[] = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    if (row.cellCount === 0) {
      continue;
    }
    const record: Record<string, string> = {};
    let hasAnyValue = false;
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const header = headers[colNumber];
      if (!header) {
        return;
      }
      const value = cell.value;
      record[header] =
        value === null || value === undefined ? '' : String(value).trim();
      if (record[header] !== '') {
        hasAnyValue = true;
      }
    });
    if (hasAnyValue) {
      rows.push(record);
    }
  }
  return rows;
}
