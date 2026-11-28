import { Transform } from 'class-transformer';
import { IsNotEmpty, IsBoolean, IsOptional, IsString, IsUUID } from 'class-validator';

// FR-CAT-001: every category node carries both Arabic and English labels.
export class CreateCategoryDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  name_ar!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  name_en!: string;

  @IsOptional()
  @IsUUID()
  parent_id?: string;

  // Sprint 17b (FR-CAT-009): set true on a resubmission to proceed past
  // a near-duplicate warning the first attempt returned - never bypasses
  // anything else, the warning is the only thing this flag overrides.
  @IsOptional()
  @IsBoolean()
  confirm_despite_duplicate_warning?: boolean;
}
