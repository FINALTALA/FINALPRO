import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  OfferCondition,
  OfferIdentifierType,
  ProductAudience,
  ProductSeason,
} from '../../../generated/prisma/client';

// Sprint 27 (product taxonomy). Shape checks only - whether a category
// belongs to the chosen audiences, or an age size to a KIDS product, is
// decided by TaxonomyService against the seeded reference tables.

export class SetClassificationDto {
  @IsArray()
  @ArrayMinSize(1, {
    message: 'audiences must contain at least one of WOMEN, MEN, KIDS',
  })
  @ArrayMaxSize(3)
  @IsIn(['WOMEN', 'MEN', 'KIDS'], { each: true })
  audiences!: ProductAudience[];

  @IsArray()
  @ArrayMinSize(1, {
    message: 'categories must contain at least one category code',
  })
  @ArrayMaxSize(20)
  @IsString({ each: true })
  categories!: string[];

  /** One season at most; null/absent = not seasonal. */
  @IsOptional()
  @IsIn(['SUMMER', 'WINTER', 'FALL', 'SPRING'])
  season?: ProductSeason | null;
}

/** Full replacement of the ONE price every variant of the offer shares. */
export class SetOfferPriceDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  base_price!: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  sale_price?: number | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  discount_percent?: number | null;

  @IsOptional()
  @IsString()
  discount_start_at?: string | null;

  @IsOptional()
  @IsString()
  discount_end_at?: string | null;
}

export class CombinationStockDto {
  @IsUUID()
  branch_id!: string;

  @IsInt()
  @Min(0)
  @Max(100000)
  quantity!: number;
}

export class CombinationDto {
  /** null/absent = this product has no colour option. */
  @IsOptional()
  @IsString()
  color_code?: string | null;

  /**
   * Product colours: the product's own colour (preferred). Without it,
   * color_code names the product's ONLY colour of that family (none: one is
   * created, named after the family; two or more: COLOR_AMBIGUOUS).
   */
  @IsOptional()
  @IsUUID()
  offer_color_id?: string;

  /** null/absent = this product has no size option. */
  @IsOptional()
  @IsString()
  size_code?: string | null;

  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CombinationStockDto)
  stock!: CombinationStockDto[];

  // The legacy variant path's own optional fields, same validators as
  // CreateOfferVariantDto. All optional: the API generates seller_sku and
  // the store inventory barcode (PDR-018) when absent; an identifier runs
  // the existing exact-match proposal (MatchingService.findExactMatch),
  // confirmed later through the existing match-confirmation endpoint.
  @IsOptional()
  @IsString()
  seller_sku?: string;

  @IsOptional()
  @IsString()
  store_inventory_barcode?: string;

  @IsOptional()
  @IsEnum(OfferIdentifierType)
  identifier_type?: OfferIdentifierType;

  @IsOptional()
  @IsString()
  identifier_value?: string;

  @IsOptional()
  @IsEnum(OfferCondition)
  condition?: OfferCondition;

  @IsOptional()
  @IsString()
  specs_text_ar?: string;

  @IsOptional()
  @IsString()
  specs_text_en?: string;
}

export class CreateCombinationsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => CombinationDto)
  items!: CombinationDto[];

  /**
   * Only for the offer's FIRST combinations (it has no variant yet, so no
   * price exists to inherit). Once any variant exists the price is
   * changed only through PUT .../price - sending it here is refused.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => SetOfferPriceDto)
  price?: SetOfferPriceDto;
}
