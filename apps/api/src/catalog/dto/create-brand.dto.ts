import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class CreateBrandDto {
  @IsString()
  name!: string;

  // Sprint 17b (FR-CAT-009) - see CreateCategoryDto's own comment.
  @IsOptional()
  @IsBoolean()
  confirm_despite_duplicate_warning?: boolean;
}
