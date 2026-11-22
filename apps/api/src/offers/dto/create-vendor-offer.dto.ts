import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
} from 'class-validator';
import {
  ClothingCategoryTemplate,
  ProductAudience,
  ProductSeason,
} from '../../../generated/prisma/client';
import { Transform } from 'class-transformer';
import { IsValidTemplateAttributes } from './template-fields.decorator';

// Sprint 17 (PDR-036, D1): the three structural fields are all
// OPTIONAL at creation - the publish gate (updateStatus) is the only
// place they are actually enforced (blocker 2: DRAFT with partial
// data must never be rejected). Supplying them up front simply saves
// the owner a later PATCH.
export class CreateVendorOfferDto {
  @IsString()
  title_ar!: string;

  /** Optional (FR-CAT-014/015): '' or absent = no English name. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  title_en?: string;

  @IsOptional()
  @IsString()
  brand_id?: string;

  @IsOptional()
  @IsEnum(ClothingCategoryTemplate)
  category_template?: ClothingCategoryTemplate;

  @IsValidTemplateAttributes()
  template_attributes?: Record<string, string>;

  // Sprint 27 (product taxonomy): a new product is born classified.
  // Shape-checked here; "at least one" and category-in-audience are
  // TaxonomyService.validateClassification's job (AUDIENCE_REQUIRED /
  // CATEGORY_REQUIRED / UNKNOWN_CATEGORY / CATEGORY_NOT_IN_AUDIENCE),
  // the same rules and codes as PUT .../classification.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsIn(['WOMEN', 'MEN', 'KIDS'], { each: true })
  audiences?: ProductAudience[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  categories?: string[];

  /** One season at most; null/absent = not seasonal. */
  @IsOptional()
  @IsIn(['SUMMER', 'WINTER', 'FALL', 'SPRING'])
  season?: ProductSeason | null;
}
