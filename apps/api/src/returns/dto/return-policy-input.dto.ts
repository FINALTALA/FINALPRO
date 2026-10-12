import { Type } from 'class-transformer';
import { IsIn, IsNumber, Min, ValidateIf } from 'class-validator';

// Sprint 21/21b (PDR-030): shared shape for BOTH CreateVendorDto's
// mandatory initial selection ("selected at registration") and the
// later PUT .../return-policy update - one validation rule, used in
// both places, so they can never silently drift apart.
//
// window_days applies to BOTH outcomes (how long after delivery a
// request of either kind may be submitted) - required whenever mode
// is not NO_RETURN. fee_ils (the return fee) and exchange_fee_ils (a
// SEPARATE fixed ILS fee, PDR-030's own "separate... fees" wording)
// are each required only for the mode(s) that can actually produce
// that outcome - BOTH requires both fees set, since either outcome
// may be chosen per request.
export class ReturnPolicyInputDto {
  @IsIn(['NO_RETURN', 'REFUND_ONLY', 'EXCHANGE_ONLY', 'BOTH'])
  mode!: 'NO_RETURN' | 'REFUND_ONLY' | 'EXCHANGE_ONLY' | 'BOTH';

  @ValidateIf((o) => o.mode !== 'NO_RETURN')
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  window_days?: number;

  @ValidateIf((o) => o.mode === 'REFUND_ONLY' || o.mode === 'BOTH')
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  fee_ils?: number;

  @ValidateIf((o) => o.mode === 'EXCHANGE_ONLY' || o.mode === 'BOTH')
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  exchange_fee_ils?: number;
}
