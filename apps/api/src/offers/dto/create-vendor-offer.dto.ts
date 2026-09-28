import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ClothingCategoryTemplate } from '../../../generated/prisma/client';
import { IsValidTemplateAttributes } from './template-fields.decorator';

// Sprint 17 (PDR-036, D1): the three structural fields are all
// OPTIONAL at creation - the publish gate (updateStatus) is the only
// place they are actually enforced (blocker 2: DRAFT with partial
// data must never be rejected). Supplying them up front simply saves
// the owner a later PATCH.
export class CreateVendorOfferDto {
  @IsString()
  title_ar!: string;

  @IsString()
  title_en!: string;

  @IsOptional()
  @IsString()
  brand_id?: string;

  @IsOptional()
  @IsEnum(ClothingCategoryTemplate)
  category_template?: ClothingCategoryTemplate;

  @IsValidTemplateAttributes()
  template_attributes?: Record<string, string>;
}
