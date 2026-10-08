import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';
import {
  BranchOrderPaymentMethod,
  FulfilmentMethod,
} from '../../../generated/prisma/client';
import { TrimmedText } from '../../common/validation/trimmed-text.decorator';

class ReserveGroupDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  cart_item_ids!: string[];

  @IsString()
  branch_id!: string;

  @IsEnum(FulfilmentMethod)
  fulfilment_method!: FulfilmentMethod;

  @IsIn(['ONLINE', 'COD'])
  payment_method!: BranchOrderPaymentMethod;

  @IsOptional()
  @IsString()
  address_id?: string;

  @IsOptional()
  @IsString()
  delivery_window_id?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  scheduled_date?: string;

  // Sprint 20b (FR-CART-014): the customer's own free-text note for
  // THIS branch-group only (e.g. delivery instructions) - never a
  // vendor-wide or cart-wide note. Optional: a group with no note is
  // the common case.
  @IsOptional()
  @TrimmedText(1, 500)
  customer_note?: string;
}

// RB-ORD-002: the customer's final per-group choices, submitted
// together as one atomic reserve() call - see CheckoutService.reserve
// for why every group in one request either all succeed or all roll
// back (a customer should never end up with half a checkout held and
// half rejected silently).
export class ReserveCheckoutDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReserveGroupDto)
  groups!: ReserveGroupDto[];

  // Sprint 20b (FR-CART-012, platform terms only): required on every
  // reserve() call - platform terms are checkout-wide, not per group.
  // See CheckoutService's own CURRENT_PLATFORM_TERMS_VERSION constant.
  @IsBoolean()
  terms_accepted!: boolean;

  @IsString()
  terms_version!: string;
}
