import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** A code the owner scanned or typed (normalized and checked by barcode.util). */
export class AddOfferBarcodeDto {
  @IsString()
  @MaxLength(64)
  code!: string;
}

export const MAX_SALE_LINES = 50;
export const MAX_LINE_QUANTITY = 999;

export class StoreSaleLineDto {
  @IsUUID()
  offer_variant_id!: string;

  @IsInt()
  @Min(1)
  @Max(MAX_LINE_QUANTITY)
  quantity!: number;

  /** The unit price the cashier screen showed - a different current price is PRICE_CHANGED, never silently charged. */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  expected_unit_price!: number;

  /** The code this line was added by (stored as plain text with the line). */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  scanned_code?: string;
}

export class CreateStoreSaleDto {
  @IsIn(['CASH', 'CARD'])
  payment_method!: 'CASH' | 'CARD';

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_SALE_LINES)
  @ValidateNested({ each: true })
  @Type(() => StoreSaleLineDto)
  lines!: StoreSaleLineDto[];
}

export class VoidStoreSaleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
