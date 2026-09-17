import { IsOptional, IsString, IsUUID } from 'class-validator';

// FR-CAT-001: every category node carries both Arabic and English labels.
export class CreateCategoryDto {
  @IsString()
  name_ar!: string;

  @IsString()
  name_en!: string;

  @IsOptional()
  @IsUUID()
  parent_id?: string;
}
