/**
 * Sprint 24 (FR-COMP-004): pure, testable similarity/difference
 * highlighting - given the same named field read off every compared
 * row (in a fixed, matching order), reports whether every row agrees
 * on that field. No scoring, no "better/worse" judgment (FR-COMP-005's
 * best-value formula is explicitly not built this sprint, decision
 * #1) - purely "same across every row" vs "differs."
 */
export interface ComparisonDiffField {
  field: string;
  values: (string | number | boolean | null)[];
  all_same: boolean;
}

export function computeComparisonDiff(
  rows: Record<string, string | number | boolean | null>[],
  fields: string[],
): ComparisonDiffField[] {
  return fields.map((field) => {
    const values = rows.map((r) => r[field] ?? null);
    const allSame = values.every((v) => v === values[0]);
    return { field, values, all_same: allSame };
  });
}
