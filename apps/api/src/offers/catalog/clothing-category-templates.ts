import { ClothingCategoryTemplate } from '../../../generated/prisma/client';

/**
 * Sprint 17 (PDR-036, D1): the ten fixed clothing/accessory category
 * templates from approved-product-decisions-2026-09.md Sec 3.2 - the
 * exact four NON-brand fields each one requires (brand itself is its
 * own governed VendorOffer.brandId column, never one of these keys).
 *
 * Deliberately a fixed map in code, not a database-driven template
 * system (AttributeDefinition/AttributeOption, FR-CAT-003) - that is
 * S17b scope, requiring an admin-managed template editor this sprint
 * does not build. A category outside this list has no template at all
 * (VendorOffer.categoryTemplate stays null) and keeps using the
 * free-text specsText fallback (BL-CAT-004b) - PDR-036 only closes
 * OPEN-013 for these ten, not for any future category.
 */
export const CLOTHING_CATEGORY_TEMPLATE_FIELDS: Record<
  ClothingCategoryTemplate,
  readonly string[]
> = {
  // Phase A++ (item 4): the clothing templates also take fit, stretch,
  // occasion and care - all optional, closed lists (CLOSED_SPEC_VALUES).
  DRESSES: [
    'material',
    'pattern',
    'length',
    'sleeve_type',
    'fit',
    'stretch',
    'occasion',
    'care',
  ],
  TOPS_SHIRTS: [
    'material',
    'pattern',
    'fit',
    'sleeve_type',
    'stretch',
    'occasion',
    'care',
  ],
  BOTTOMS: [
    'material',
    'pattern',
    'cut',
    'length_or_waist',
    'fit',
    'stretch',
    'occasion',
    'care',
  ],
  COATS_JACKETS: [
    'material',
    'pattern',
    'closure_type',
    'length',
    'fit',
    'stretch',
    'occasion',
    'care',
  ],
  SETS_PYJAMAS: [
    'material',
    'pattern',
    'piece_count',
    'cut',
    'fit',
    'stretch',
    'occasion',
    'care',
  ],
  KIDS_CLOTHING: [
    'age_range',
    'material',
    'pattern',
    'detail',
    'fit',
    'stretch',
    'occasion',
    'care',
  ],
  SHOES: ['upper_material', 'closure_type', 'sole_type', 'size_system'],
  BAGS: ['material', 'bag_type', 'dimensions', 'closure_type'],
  JEWELLERY_WATCHES: ['material', 'sub_type', 'stone_or_finish', 'dimensions'],
  OTHER_ACCESSORIES: ['material', 'sub_type', 'pattern', 'dimensions_or_size'],
};

/**
 * Phase A++ (item 4): specifications whose value is one of a closed list of
 * codes (shown in each language by the screens) - so a store page or
 * discovery could later filter on them. `care` may hold several codes,
 * comma-separated. The rule is here, so the wizard, the API and the import
 * apply it alike.
 */
export const CLOSED_SPEC_VALUES: Record<string, readonly string[]> = {
  fit: ['SLIM', 'REGULAR', 'LOOSE', 'OVERSIZED'],
  stretch: ['NONE', 'SLIGHT', 'HIGH'],
  occasion: ['CASUAL', 'EVENING', 'WORK', 'SPORT', 'HOME', 'FORMAL', 'EID'],
  care: [
    'HAND_WASH',
    'MACHINE_WASH',
    'DRY_CLEAN',
    'NO_BLEACH',
    'NO_TUMBLE_DRY',
    'IRON_LOW',
  ],
};
export const MULTI_VALUE_SPECS: ReadonlySet<string> = new Set(['care']);
/**
 * Values stored before the closed lists (TOPS_SHIRTS' free-text «fit» was
 * offered in Arabic) keep validating, so no existing product breaks; new
 * values are codes.
 */
export const LEGACY_SPEC_VALUES: Record<string, readonly string[]> = {
  fit: ['ضيّق', 'عادي', 'واسع', 'أوفرسايز'],
};

function closedValueOk(key: string, value: string): boolean {
  const allowed = CLOSED_SPEC_VALUES[key];
  if (!allowed) return true;
  if (LEGACY_SPEC_VALUES[key]?.includes(value.trim())) return true;
  const parts = MULTI_VALUE_SPECS.has(key)
    ? value.split(',').map((x) => x.trim())
    : [value.trim()];
  return (
    parts.length > 0 &&
    parts.every((x) => allowed.includes(x)) &&
    new Set(parts).size === parts.length
  );
}

export type TemplateValidationProblem =
  | { type: 'MISSING_KEY'; key: string }
  | { type: 'UNKNOWN_KEY'; key: string }
  | { type: 'BLANK_VALUE'; key: string }
  | { type: 'INVALID_VALUE'; key: string }
  | { type: 'NOT_AN_OBJECT' };

/**
 * Validates a candidate `templateAttributes` payload against exactly
 * the four keys `template` requires - no more, no fewer. Each value
 * must be a non-blank string after trimming, or the literal "N/A".
 * Returns an empty array when valid.
 */
export function validateTemplateAttributes(
  template: ClothingCategoryTemplate,
  attributes: unknown,
): TemplateValidationProblem[] {
  if (
    typeof attributes !== 'object' ||
    attributes === null ||
    Array.isArray(attributes)
  ) {
    return [{ type: 'NOT_AN_OBJECT' }];
  }
  // Product decision 2026-11-16: every specification is OPTIONAL - a
  // value the seller does not know is simply left out (never "N/A", never
  // invented). A key that IS sent must be one of this template's own keys
  // and a non-blank string. ("N/A" stays accepted only so products saved
  // before this rule keep validating.)
  const allowedKeys = CLOTHING_CATEGORY_TEMPLATE_FIELDS[template];
  const record = attributes as Record<string, unknown>;
  const problems: TemplateValidationProblem[] = [];

  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      problems.push({ type: 'UNKNOWN_KEY', key });
      continue;
    }
    const value = record[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      problems.push({ type: 'BLANK_VALUE', key });
    } else if (!closedValueOk(key, value)) {
      problems.push({ type: 'INVALID_VALUE', key });
    }
  }
  return problems;
}

export function describeTemplateProblems(
  problems: TemplateValidationProblem[],
): string {
  return problems
    .map((p) => {
      switch (p.type) {
        case 'NOT_AN_OBJECT':
          return 'template_attributes must be an object';
        case 'MISSING_KEY':
          return `template_attributes is missing required key "${p.key}"`;
        case 'UNKNOWN_KEY':
          return `template_attributes has an unexpected key "${p.key}"`;
        case 'INVALID_VALUE':
          return `template_attributes."${p.key}" must be one of: ${(CLOSED_SPEC_VALUES[p.key] ?? []).join(', ')}${MULTI_VALUE_SPECS.has(p.key) ? ' (several, comma-separated)' : ''}`;
        case 'BLANK_VALUE':
          return `template_attributes."${p.key}" must be a non-blank string or the literal "N/A"`;
      }
    })
    .join('; ');
}
