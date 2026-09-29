import { ValidationOptions, registerDecorator } from 'class-validator';

/**
 * Sprint 17: a STRUCTURAL-ONLY check (plain object of non-blank
 * strings) - used on UpdateVendorOfferDto, where whether
 * `template_attributes` is valid also depends on which
 * `category_template` is EFFECTIVE (the one in this same request, or
 * the one already stored if this request doesn't touch it) - a fact
 * the DTO layer alone cannot know. The controller does the full
 * key-matching validation (offers/catalog/clothing-category-templates.ts)
 * once it has resolved the effective template from whichever source
 * applies.
 */
export function IsTemplateAttributesShape(options?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'isTemplateAttributesShape',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown) {
          if (value === undefined || value === null) return true;
          if (typeof value !== 'object' || Array.isArray(value)) return false;
          return Object.values(value as Record<string, unknown>).every(
            (v) => typeof v === 'string',
          );
        },
        defaultMessage() {
          return 'template_attributes must be an object whose values are all strings';
        },
      },
    });
  };
}
