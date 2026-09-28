import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ClothingCategoryTemplate } from '../../../generated/prisma/client';
import { IsTemplateAttributesShape } from './template-attributes-shape.decorator';

// Sprint 17 (PDR-036, D1, blocker 2): every field optional (a partial
// update) - none of these are enforced here; the publish gate is the
// only enforcement point. If both category_template and
// template_attributes are omitted from a request entirely, the
// existing stored value is left untouched. Sending
// category_template: null clears both (see the controller).
export class UpdateVendorOfferDto {
  @IsOptional()
  @IsString()
  title_ar?: string;

  @IsOptional()
  @IsString()
  title_en?: string;

  @IsOptional()
  @IsString()
  brand_id?: string;

  @IsOptional()
  @IsEnum(ClothingCategoryTemplate)
  category_template?: ClothingCategoryTemplate | null;

  @IsTemplateAttributesShape()
  template_attributes?: Record<string, string> | null;
}
