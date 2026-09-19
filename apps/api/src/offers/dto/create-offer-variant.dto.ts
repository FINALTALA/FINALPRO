import {
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

export class CreateOfferVariantDto {
  @IsString()
  seller_sku!: string;

  @IsOptional()
  @IsEnum(OfferCondition)
  condition?: OfferCondition;

  // Sprint 3 remediation (PDR-001): ILS is the only platform currency -
  // there is no FX conversion or vendor-native checkout currency. This
  // field is deliberately NOT a free-text currency selector; omit it
  // (the only real use case) or send exactly "ILS" - anything else is
  // rejected outright (400), not silently coerced or dropped.
  @IsOptional()
  @IsIn(['ILS'], {
    message: 'currency must be ILS - this platform is ILS-only (PDR-001)',
  })
  currency?: 'ILS';

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

  // FR-MATCH-002 / BL-MATCH-002, Sprint 3 remediation (FR-MATCH-012,
  // approved-product-decisions-2026-09.md Sec 3.2 - not PDR-012, which
  // is unrelated/covers store sections):
  // submitting both fields together makes MatchingService.findExactMatch()
  // look for a candidate, but an exact match is only ever stored as a
  // *pending proposal* now - it never links immediately, however exact
  // the identifier is. See VendorOffersController's match-confirmation
  // endpoint for the store owner's explicit confirm/reject step, which
  // is the only thing that can set canonicalVariantId. Neither field is
  // required: an offer with no identifier (or no match found) stays
  // unmatched/unique (FR-MATCH-009).
  @IsOptional()
  @IsEnum(OfferIdentifierType)
  identifier_type?: OfferIdentifierType;

  @IsOptional()
  @IsString()
  identifier_value?: string;

  // Sprint 5 (RB-INV-001, PDR-018): "A seller must provide a barcode
  // for every product. If no manufacturer code exists, the platform
  // generates a printable store-internal inventory barcode." Optional
  // here for exactly that reason - a vendor with a real manufacturer
  // barcode supplies it; otherwise VendorOffersController.createVariant
  // auto-generates one. Never the same field as identifier_value above
  // (that one drives platform-wide matching; this one is store-scoped
  // and scanner-facing only - see OfferVariant.storeInventoryBarcode's
  // schema comment).
  @IsOptional()
  @IsString()
  store_inventory_barcode?: string;
}
