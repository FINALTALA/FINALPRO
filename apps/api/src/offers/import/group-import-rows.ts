import { OfferIdentifierType } from '../../../generated/prisma/client';
import { ImportRowError, ValidatedImportRow } from './validate-import-row';

export interface ImportGroup {
  /** null for a row with no identifier - always its own single-variant
   * offer, never grouped/conflict-checked against anything else in the
   * file or any prior import. */
  identifierType: OfferIdentifierType | null;
  identifierValue: string | null;
  rows: ValidatedImportRow[];
}

/**
 * Sprint 7 (RB-MATCH-004, PDR-019): "Exact barcode plus a new colour/
 * size during import is an additive update, not a conflict. Mandatory
 * manual review conflicts are differing brand, differing base product
 * type, or differing MPN/model when present."
 *
 * The grouping key is the (`identifier_type`, `identifier_value`) PAIR,
 * not `identifier_value` alone (review-round fix - Blocker 3: two
 * different identifier types, e.g. an EAN and an MPN, can coincidentally
 * share the same raw string value without being the same real-world
 * product; grouping on value alone would have wrongly merged them).
 * Rows sharing both are the "same real-world product, different colour/
 * size" case and become multiple OfferVariants under one VendorOffer -
 * either a new one, or (review-round fix - Blocker 3, see
 * offers-import.controller.ts's importGroup()) an existing one from a
 * PRIOR import request, via ImportIdentifierRecord.
 *
 * Within such a group, a disagreement on brand_name/product_type/mpn
 * (only compared when BOTH sides of a pair have a non-empty value - a
 * row simply omitting one of these free-text columns is never itself a
 * conflict) is the mandatory-review case: the whole group is held out of
 * the import and reported, never silently resolved one way or the
 * other. The same comparison (conflictingField()) is reused by
 * offers-import.controller.ts to check a group against a PRIOR import's
 * persisted ImportIdentifierRecord, so the within-file and cross-import
 * conflict definitions never drift apart.
 *
 * These three columns are validation/grouping input only - there is
 * nowhere in the current schema to persist a per-offer brand/product
 * type (that is CanonicalProduct's own admin-owned domain), and
 * RB-MATCH-004 explicitly does not invent new taxonomy columns for it
 * (OPEN-013 is still unresolved) beyond the minimal cross-import
 * tracking ImportIdentifierRecord itself adds - see
 * validate-import-row.ts's own comment on the same fields.
 */
export function groupImportRows(rows: ValidatedImportRow[]): {
  groups: ImportGroup[];
  conflicts: ImportRowError[];
} {
  const byIdentifier = new Map<string, ValidatedImportRow[]>();
  const ungrouped: ValidatedImportRow[] = [];

  for (const row of rows) {
    if (!row.identifierType || !row.identifierValue) {
      ungrouped.push(row);
      continue;
    }
    const key = identifierKey(row.identifierType, row.identifierValue);
    const existing = byIdentifier.get(key);
    if (existing) {
      existing.push(row);
    } else {
      byIdentifier.set(key, [row]);
    }
  }

  const groups: ImportGroup[] = ungrouped.map((row) => ({
    identifierType: null,
    identifierValue: null,
    rows: [row],
  }));
  const conflicts: ImportRowError[] = [];

  for (const groupRows of byIdentifier.values()) {
    const conflictField = findConflictingField(groupRows);
    if (conflictField) {
      for (const row of groupRows) {
        conflicts.push({
          rowNumber: row.rowNumber,
          reason: `Conflicts with another row sharing identifier_type/identifier_value "${row.identifierType}/${row.identifierValue}" - differing ${conflictField} requires manual review (PDR-019)`,
        });
      }
      continue;
    }
    groups.push({
      identifierType: groupRows[0].identifierType,
      identifierValue: groupRows[0].identifierValue,
      rows: groupRows,
    });
  }

  return { groups, conflicts };
}

export function identifierKey(
  identifierType: OfferIdentifierType,
  identifierValue: string,
): string {
  return `${identifierType}:${identifierValue}`;
}

interface BrandFields {
  brandName: string | null;
  productType: string | null;
  mpn: string | null;
}

// Review-round fix (Sprint 7 round 4): the single non-null value present
// for each field across an already-conflict-checked group - never just
// the group's first row. findConflictingField() below already proved
// there is at most one DISTINCT non-null value per field among these
// rows, so picking the first non-null one anywhere in the group (not
// row 0 specifically) is the group's whole evidence, not a partial
// slice of it. Using only firstRow here was the bug: a group of [brand
// empty, brand "Nike"] has no in-file conflict (nothing differs, since
// the first row simply has no opinion) but firstRow.brandName is null -
// persisting that null would have silently discarded "Nike" as evidence
// for every later cross-import compatibility check.
export function collectGroupEvidence(rows: ValidatedImportRow[]): BrandFields {
  const fields: Array<keyof BrandFields> = ['brandName', 'productType', 'mpn'];
  const evidence: BrandFields = {
    brandName: null,
    productType: null,
    mpn: null,
  };
  for (const field of fields) {
    const value = rows
      .map((r) => r[field])
      .find((v): v is string => v !== null);
    evidence[field] = value ?? null;
  }
  return evidence;
}

/** Null-tolerant: a field only conflicts when BOTH sides have a
 * non-null value and they differ - absence of evidence on either side
 * is never itself a conflict (see this file's own header comment). */
export function conflictingField(
  a: BrandFields,
  b: BrandFields,
): string | null {
  const fields: Array<keyof BrandFields> = ['brandName', 'productType', 'mpn'];
  for (const field of fields) {
    if (a[field] !== null && b[field] !== null && a[field] !== b[field]) {
      return field;
    }
  }
  return null;
}

function findConflictingField(rows: ValidatedImportRow[]): string | null {
  const fields: Array<keyof BrandFields> = ['brandName', 'productType', 'mpn'];
  for (const field of fields) {
    const distinctValues = new Set(
      rows.map((r) => r[field]).filter((v): v is string => v !== null),
    );
    if (distinctValues.size > 1) {
      return field;
    }
  }
  return null;
}
