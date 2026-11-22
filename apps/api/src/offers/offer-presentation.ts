/**
 * Phase A++ (items 5 and 6): the rules for a product's model information and
 * its shared images - ONE place, used by the wizard's draft check, the
 * product's creation from a draft, and the product page's own edits.
 */

export const MODEL_HEIGHT_MIN_CM = 100;
export const MODEL_HEIGHT_MAX_CM = 220;
export const MODEL_SIZE_MAX = 40;
/** At most this many images shared by every colour (the table's CHECK says the same). */
export const MAX_SHARED_IMAGES = 6;

export type ModelProblem =
  'MODEL_INCOMPLETE' | 'MODEL_HEIGHT_RANGE' | 'MODEL_SIZE_NOT_IN_PRODUCT';

/**
 * Model information is optional; when given, it is both a height (whole
 * cm, 100-220) and the size the model wears, which must be one of THIS
 * product's sizes. The size is compared as text (a size code today; a
 * custom size label may be allowed later - see the migration's note).
 * Returns null when there is nothing wrong (including "no model information").
 */
export function modelProblem(
  heightCm: number | null | undefined,
  size: string | null | undefined,
  productSizes: Iterable<string>,
): ModelProblem | null {
  const h = heightCm ?? null;
  const s = (size ?? '').trim() || null;
  if (h === null && s === null) return null;
  if (h === null || s === null) return 'MODEL_INCOMPLETE';
  if (
    !Number.isInteger(h) ||
    h < MODEL_HEIGHT_MIN_CM ||
    h > MODEL_HEIGHT_MAX_CM
  )
    return 'MODEL_HEIGHT_RANGE';
  if (![...productSizes].includes(s)) return 'MODEL_SIZE_NOT_IN_PRODUCT';
  return null;
}
