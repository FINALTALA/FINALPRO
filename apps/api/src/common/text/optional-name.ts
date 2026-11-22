/**
 * Phase A+ (SRS FR-CAT-014/015): a product has ONE required title (the
 * Arabic one); its English name is optional and is never translated
 * mechanically. An optional name is stored as '' when absent - this is
 * the one rule for reading it: trimmed, and blank / whitespace-only means
 * "no name".
 */
export function optionalName(value: string | null | undefined): string | null {
  const t = (value ?? '').trim();
  return t === '' ? null : t;
}

/** The English name when there is one, else the Arabic one (display only). */
export function nameOrArabic(
  en: string | null | undefined,
  ar: string,
): string {
  return optionalName(en) ?? ar;
}
