import type { NotImportedColumn } from '../import/not-imported';

// Sprint 7 (RB-MATCH-004): the plain response shape for a completed
// import - not a class-validator DTO (nothing here is request input),
// just a documented, stable shape for OffersImportController's report.
export interface ImportedRow {
  row_number: number;
  offer_id: string;
  variant_id: string;
}

export interface SkippedRow {
  row_number: number;
  reason: string;
  offer_id: string;
}

export interface FailedRow {
  row_number: number;
  reason: string;
}

export interface ImportReport {
  total_rows: number;
  /**
   * Phase A++ (condition 7): columns that had values but were NOT imported -
   * a product field the import does not take yet, or an unknown column.
   * Never silently ignored.
   */
  not_imported?: NotImportedColumn[];
  imported: ImportedRow[];
  skipped_already_imported: SkippedRow[];
  invalid_rows: FailedRow[];
  conflicts: FailedRow[];
}
