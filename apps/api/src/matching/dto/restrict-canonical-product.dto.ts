import { TrimmedText } from '../../common/validation/trimmed-text.decorator';

// Sprint 17b (FR-CAT-006) - same forward-looking-only semantics as
// RestrictCategoryDto, applied to CanonicalProduct directly.
export class RestrictCanonicalProductDto {
  @TrimmedText(10, 1000)
  reason!: string;
}
