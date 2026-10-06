import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
} from 'class-validator';
import { ProductType } from '../../../generated/prisma/client';
import { TrimmedText } from '../../common/validation/trimmed-text.decorator';

// Sprint 17b (BL-CAT-003, FR-CAT-007/010/011/012): deliberately does
// NOT accept `status` (see CanonicalProductStatusTransitionDto) or
// isRestricted/restrictionReason (see the dedicated restrict/unrestrict
// endpoints, which require a reason) - this is the "catalog detail
// polish" fields only.
export class UpdateCanonicalProductDto {
  @IsOptional()
  @IsEnum(ProductType)
  product_type?: ProductType;

  @IsOptional()
  @IsString()
  warranty_period?: string;

  @IsOptional()
  @IsString()
  warranty_type?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @TrimmedText(1, 200)
  seo_title_ar?: string;

  @IsOptional()
  @TrimmedText(1, 200)
  seo_title_en?: string;

  @IsOptional()
  @TrimmedText(1, 500)
  seo_description_ar?: string;

  @IsOptional()
  @TrimmedText(1, 500)
  seo_description_en?: string;
}
