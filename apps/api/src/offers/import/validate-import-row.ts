import {
  OfferCondition,
  OfferIdentifierType,
} from '../../../generated/prisma/client';

const VALID_CONDITIONS = new Set(Object.values(OfferCondition));
const VALID_IDENTIFIER_TYPES = new Set(Object.values(OfferIdentifierType));

export interface ValidatedImportRow {
  rowNumber: number;
  titleAr: string;
  titleEn: string;
  sellerSku: string;
  basePrice: number;
  salePrice: number | null;
  condition: OfferCondition;
  specsTextAr: string | null;
  specsTextEn: string | null;
  storeInventoryBarcode: string | null;
  identifierType: OfferIdentifierType | null;
  identifierValue: string | null;
  /** Free-text, validation/grouping-only - never persisted as a new
   * column (RB-MATCH-004: "لا تخترع taxonomy جديدة"). Sourced from the
   * row's own brand_name/product_type/mpn columns. */
  brandName: string | null;
  productType: string | null;
  mpn: string | null;
}

export interface ImportRowError {
  rowNumber: number;
  reason: string;
}

function readString(
  row: Record<string, string>,
  key: string,
): string | undefined {
  const value = row[key];
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Sprint 7 (RB-MATCH-004): validates and coerces one raw parsed row.
 * Every failure is collected and returned as a clear reason string,
 * not thrown - a single bad row must never abort the whole import (the
 * "clear report of correct vs. incorrect rows" requirement) and a row
 * can fail more than one check at once, worth reporting together.
 */
export function validateImportRow(
  row: Record<string, string>,
  rowNumber: number,
): { row: ValidatedImportRow } | { errors: ImportRowError[] } {
  const problems: string[] = [];

  const titleAr = readString(row, 'title_ar');
  if (!titleAr) problems.push('title_ar is required');
  const titleEn = readString(row, 'title_en');
  if (!titleEn) problems.push('title_en is required');
  const sellerSku = readString(row, 'seller_sku');
  if (!sellerSku) problems.push('seller_sku is required');

  const basePriceRaw = readString(row, 'base_price');
  let basePrice = NaN;
  if (!basePriceRaw) {
    problems.push('base_price is required');
  } else {
    basePrice = Number(basePriceRaw);
    if (!Number.isFinite(basePrice) || basePrice <= 0) {
      problems.push('base_price must be a positive number');
    }
  }

  let salePrice: number | null = null;
  const salePriceRaw = readString(row, 'sale_price');
  if (salePriceRaw) {
    salePrice = Number(salePriceRaw);
    if (!Number.isFinite(salePrice) || salePrice <= 0) {
      problems.push('sale_price must be a positive number when provided');
      salePrice = null;
    }
  }

  let condition: OfferCondition = OfferCondition.NEW;
  const conditionRaw = readString(row, 'condition');
  if (conditionRaw) {
    if (!VALID_CONDITIONS.has(conditionRaw as OfferCondition)) {
      problems.push(
        `condition must be one of ${Array.from(VALID_CONDITIONS).join(', ')}`,
      );
    } else {
      condition = conditionRaw as OfferCondition;
    }
  }

  const identifierTypeRaw = readString(row, 'identifier_type');
  const identifierValueRaw = readString(row, 'identifier_value');
  let identifierType: OfferIdentifierType | null = null;
  let identifierValue: string | null = null;
  if (identifierTypeRaw || identifierValueRaw) {
    if (!identifierTypeRaw || !identifierValueRaw) {
      problems.push(
        'identifier_type and identifier_value must both be provided together',
      );
    } else if (
      !VALID_IDENTIFIER_TYPES.has(identifierTypeRaw as OfferIdentifierType)
    ) {
      problems.push(
        `identifier_type must be one of ${Array.from(VALID_IDENTIFIER_TYPES).join(', ')}`,
      );
    } else {
      identifierType = identifierTypeRaw as OfferIdentifierType;
      identifierValue = identifierValueRaw;
    }
  }

  if (problems.length > 0) {
    return { errors: problems.map((reason) => ({ rowNumber, reason })) };
  }

  return {
    row: {
      rowNumber,
      titleAr: titleAr!,
      titleEn: titleEn!,
      sellerSku: sellerSku!,
      basePrice,
      salePrice,
      condition,
      specsTextAr: readString(row, 'specs_text_ar') ?? null,
      specsTextEn: readString(row, 'specs_text_en') ?? null,
      storeInventoryBarcode: readString(row, 'store_inventory_barcode') ?? null,
      identifierType,
      identifierValue,
      brandName: readString(row, 'brand_name') ?? null,
      productType: readString(row, 'product_type') ?? null,
      mpn: readString(row, 'mpn') ?? null,
    },
  };
}
