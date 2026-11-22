import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/**
 * «مجموعات المتجر»: a collection's own fields. The Arabic name is required
 * on create (`name_ar`, or `name` - the older field, kept as its alias);
 * the English name and the cover are optional; a collection is visible
 * unless `visible: false`. `cover_url: null` removes the cover.
 */
export class CreateStoreSectionDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  name_ar?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(80)
  name_en?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(500)
  cover_url?: string | null;

  @IsOptional()
  @IsBoolean()
  visible?: boolean;
}
