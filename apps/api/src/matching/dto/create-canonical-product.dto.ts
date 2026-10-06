import { IsBoolean, IsOptional, IsString, IsUUID } from 'class-validator';

// Sprint 17b (FR-CAT-008 review-round fix): `status` is deliberately
// NOT accepted here any more - every CanonicalProduct is created at
// DRAFT, full stop (CanonicalProductsController.create() hardcodes it),
// closing the gap where a caller could previously create one directly
// at PUBLISHED, bypassing the review lifecycle entirely. Use
// POST /canonical-products/:id/status-transition to move it afterward.
export class CreateCanonicalProductDto {
  @IsUUID()
  brand_id!: string;

  @IsUUID()
  category_id!: string;

  @IsString()
  model_name!: string;

  // Sprint 17b (FR-CAT-009) - see CreateCategoryDto's own comment.
  @IsOptional()
  @IsBoolean()
  confirm_despite_duplicate_warning?: boolean;
}
