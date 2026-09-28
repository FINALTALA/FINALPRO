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
  DRESSES: ['material', 'pattern', 'length', 'sleeve_type'],
  TOPS_SHIRTS: ['material', 'pattern', 'fit', 'sleeve_type'],
  BOTTOMS: ['material', 'pattern', 'cut', 'length_or_waist'],
  COATS_JACKETS: ['material', 'pattern', 'closure_type', 'length'],
  SETS_PYJAMAS: ['material', 'pattern', 'piece_count', 'cut'],
  KIDS_CLOTHING: ['age_range', 'material', 'pattern', 'detail'],
  SHOES: ['upper_material', 'closure_type', 'sole_type', 'size_system'],
  BAGS: ['material', 'bag_type', 'dimensions', 'closure_type'],
  JEWELLERY_WATCHES: ['material', 'sub_type', 'stone_or_finish', 'dimensions'],
  OTHER_ACCESSORIES: ['material', 'sub_type', 'pattern', 'dimensions_or_size'],
};

export type TemplateValidationProblem =
  | { type: 'MISSING_KEY'; key: string }
  | { type: 'UNKNOWN_KEY'; key: string }
  | { type: 'BLANK_VALUE'; key: string }
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
  if (typeof attributes !== 'object' || attributes === null || Array.isArray(attributes)) {
    return [{ type: 'NOT_AN_OBJECT' }];
  }
  const requiredKeys = CLOTHING_CATEGORY_TEMPLATE_FIELDS[template];
  const record = attributes as Record<string, unknown>;
  const problems: TemplateValidationProblem[] = [];

  for (const key of requiredKeys) {
    if (!(key in record)) {
      problems.push({ type: 'MISSING_KEY', key });
      continue;
    }
    const value = record[key];
    if (typeof value !== 'string' || (value.trim().length === 0 && value !== 'N/A')) {
      problems.push({ type: 'BLANK_VALUE', key });
    }
  }
  for (const key of Object.keys(record)) {
    if (!requiredKeys.includes(key)) {
      problems.push({ type: 'UNKNOWN_KEY', key });
    }
  }
  return problems;
}

export function describeTemplateProblems(problems: TemplateValidationProblem[]): string {
  return problems
    .map((p) => {
      switch (p.type) {
        case 'NOT_AN_OBJECT':
          return 'template_attributes must be an object';
        case 'MISSING_KEY':
          return `template_attributes is missing required key "${p.key}"`;
        case 'UNKNOWN_KEY':
          return `template_attributes has an unexpected key "${p.key}"`;
        case 'BLANK_VALUE':
          return `template_attributes."${p.key}" must be a non-blank string or the literal "N/A"`;
      }
    })
    .join('; ');
}
