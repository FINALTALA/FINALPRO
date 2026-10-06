import { TrimmedText } from '../../common/validation/trimmed-text.decorator';

// Sprint 17b (FR-CAT-006): forward-looking-only restriction - reason is
// mandatory, same 10-1000 char convention as vendor suspension's own
// reason field. PLATFORM_ADMIN-visible only (CategoriesController's
// own toDto() never includes it on the public GET routes).
export class RestrictCategoryDto {
  @TrimmedText(10, 1000)
  reason!: string;
}
