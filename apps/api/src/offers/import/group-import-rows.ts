import { ImportRowError, ValidatedImportRow } from './validate-import-row';

export interface ImportGroup {
  /** null for a row with no identifier_value - always its own
   * single-variant offer, never grouped/conflict-checked against
   * anything else in the file. */
  identifierValue: string | null;
  rows: ValidatedImportRow[];
}

/**
 * Sprint 7 (RB-MATCH-004, PDR-019): "Exact barcode plus a new colour/
 * size during import is an additive update, not a conflict. Mandatory
 * manual review conflicts are differing brand, differing base product
 * type, or differing MPN/model when present."
 *
 * `identifier_value` (the manufacturer/matching barcode - the same
 * field the single-offer JSON API already has, reused here, not a new
 * column) is the grouping key: rows sharing one are the "same real-
 * world product, different colour/size" case and become multiple
 * OfferVariants under one new VendorOffer. Within such a group, a
 * disagreement on brand_name/product_type/mpn (only compared when
 * BOTH sides of a pair have a non-empty value - a row simply omitting
 * one of these free-text columns is never itself a conflict) is the
 * mandatory-review case: the whole group is held out of the import and
 * reported, never silently resolved one way or the other.
 *
 * These three columns are validation/grouping input only - there is
 * nowhere in the current schema to persist a per-offer brand/product
 * type (that is CanonicalProduct's own admin-owned domain), and
 * RB-MATCH-004 explicitly does not invent new taxonomy columns for it
 * (OPEN-013 is still unresolved) - see validate-import-row.ts's own
 * comment on the same fields.
 */
export function groupImportRows(rows: ValidatedImportRow[]): {
  groups: ImportGroup[];
  conflicts: ImportRowError[];
} {
  const byIdentifier = new Map<string, ValidatedImportRow[]>();
  const ungrouped: ValidatedImportRow[] = [];

  for (const row of rows) {
    if (!row.identifierValue) {
      ungrouped.push(row);
      continue;
    }
    const existing = byIdentifier.get(row.identifierValue);
    if (existing) {
      existing.push(row);
    } else {
      byIdentifier.set(row.identifierValue, [row]);
    }
  }

  const groups: ImportGroup[] = ungrouped.map((row) => ({
    identifierValue: null,
    rows: [row],
  }));
  const conflicts: ImportRowError[] = [];

  for (const [identifierValue, groupRows] of byIdentifier) {
    const conflictFields = findConflictingField(groupRows);
    if (conflictFields) {
      for (const row of groupRows) {
        conflicts.push({
          rowNumber: row.rowNumber,
          reason: `Conflicts with another row sharing identifier_value "${identifierValue}" - differing ${conflictFields} requires manual review (PDR-019)`,
        });
      }
      continue;
    }
    groups.push({ identifierValue, rows: groupRows });
  }

  return { groups, conflicts };
}

function findConflictingField(rows: ValidatedImportRow[]): string | null {
  const fields: Array<
    keyof Pick<ValidatedImportRow, 'brandName' | 'productType' | 'mpn'>
  > = ['brandName', 'productType', 'mpn'];
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
