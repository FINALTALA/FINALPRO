import {
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';
import { ClothingCategoryTemplate } from '../../../generated/prisma/client';
import { validateTemplateAttributes } from '../catalog/clothing-category-templates';

/**
 * Sprint 17 (PDR-036, D1/D2): cross-field validation on
 * `template_attributes`, applied only when `category_template` is
 * present on the same DTO (sibling field, read via `args.object`).
 * category_template = null/undefined means "outside the ten templates"
 * (D2) - template_attributes must then be absent too; this decorator
 * is a no-op in that case, matching offers/catalog/clothing-category-
 * templates.ts's own free-text fallback for those categories.
 */
export function IsValidTemplateAttributes(options?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'isValidTemplateAttributes',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const template = (args.object as { category_template?: ClothingCategoryTemplate })
            .category_template;
          if (!template) {
            return value === undefined || value === null;
          }
          if (value === undefined || value === null) return false;
          return validateTemplateAttributes(template, value).length === 0;
        },
        defaultMessage(args: ValidationArguments) {
          const template = (args.object as { category_template?: ClothingCategoryTemplate })
            .category_template;
          const value = (args.object as Record<string, unknown>)[args.property];
          if (!template) {
            return 'template_attributes must not be sent without category_template';
          }
          if (value === undefined || value === null) {
            return 'template_attributes is required when category_template is set';
          }
          const problems = validateTemplateAttributes(template, value);
          return problems
            .map((p) =>
              p.type === 'NOT_AN_OBJECT'
                ? 'template_attributes must be an object'
                : p.type === 'MISSING_KEY'
                  ? `missing required key "${p.key}"`
                  : p.type === 'UNKNOWN_KEY'
                    ? `unexpected key "${p.key}"`
                    : `"${p.key}" must be a non-blank string or "N/A"`,
            )
            .join('; ');
        },
      },
    });
  };
}
