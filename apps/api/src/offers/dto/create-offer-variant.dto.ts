import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';
import {
  OfferCondition,
  OfferIdentifierType,
} from '../../../generated/prisma/client';

export class CreateOfferVariantDto {
  @IsString()
  seller_sku!: string;

  @IsOptional()
  @IsEnum(OfferCondition)
  condition?: OfferCondition;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsNumber()
  @IsPositive()
  base_price!: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  sale_price?: number;

  @IsOptional()
  @IsString()
  specs_text_ar?: string;

  @IsOptional()
  @IsString()
  specs_text_en?: string;

  // FR-MATCH-002 / BL-MATCH-002: submitting both fields together
  // attempts an exact-match auto-link (BR-001) - see
  // MatchingService.findExactMatch(). Neither field is required: an
  // offer with no identifier stays unmatched/unique (FR-MATCH-009).
  @IsOptional()
  @IsEnum(OfferIdentifierType)
  identifier_type?: OfferIdentifierType;

  @IsOptional()
  @IsString()
  identifier_value?: string;
}
