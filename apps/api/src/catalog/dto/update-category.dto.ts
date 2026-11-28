import { Transform } from 'class-transformer';
import { IsNotEmpty, ValidateIf, IsOptional, IsString, IsUUID } from 'class-validator';

export class UpdateCategoryDto {
  @ValidateIf((_, value) => value !== undefined)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  name_ar?: string;

  @ValidateIf((_, value) => value !== undefined)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  name_en?: string;

  @IsOptional()
  @IsUUID()
  parent_id?: string | null;
}
