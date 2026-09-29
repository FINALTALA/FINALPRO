import {
  IsDateString,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';
import {
  OfferCondition,
  OfferIdentifierType,
} from '../../../generated/prisma/client';

// Sprint 17 (blocker 2): a partial update - every field optional, none
// enforced here (the publish gate is the sole enforcement point).
// Every field the controller actually applies is folded into the same
// transaction/lock as the resulting PriceHistory write and the
// identity-lock/rerun-matching checks - see
// VendorOffersController.updateVariant()'s own comment.
export class UpdateOfferVariantDto {
  @IsOptional()
  @IsEnum(OfferCondition)
  condition?: OfferCondition;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  base_price?: number;

  // Sending sale_price clears any scheduled discount on this variant;
  // sending discount_percent/start/end clears sale_price - mutually
  // exclusive (blocker 1), enforced in the controller and by the DB
  // CHECK. Sending `sale_price: null` explicitly clears it without
  // setting a discount either.
  @IsOptional()
  @IsNumber()
  @IsPositive()
  sale_price?: number | null;

  @IsOptional()
  @IsNumber()
  discount_percent?: number | null;

  @IsOptional()
  @IsDateString()
  discount_start_at?: string | null;

  @IsOptional()
  @IsDateString()
  discount_end_at?: string | null;

  @IsOptional()
  @IsString()
  colour?: string;

  @IsOptional()
  @IsString()
  size?: string;

  @IsOptional()
  @IsString()
  specs_text_ar?: string;

  @IsOptional()
  @IsString()
  specs_text_en?: string;

  // Sprint 17: PATCHing the identifier on a variant that is NOT yet
  // CONFIRMED re-runs MatchingService.findExactMatch() automatically
  // (same function createVariant() already uses). PATCHing it on a
  // CONFIRMED variant is refused - 409 CONFIRMED_MATCH_IDENTITY_LOCKED
  // - see the controller.
  @IsOptional()
  @IsEnum(OfferIdentifierType)
  identifier_type?: OfferIdentifierType;

  @IsOptional()
  @IsString()
  identifier_value?: string;

  @IsOptional()
  @IsIn(['ILS'], {
    message: 'currency must be ILS - this platform is ILS-only (PDR-001)',
  })
  currency?: 'ILS';
}
