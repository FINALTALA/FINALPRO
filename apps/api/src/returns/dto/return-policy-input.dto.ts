import { Type } from 'class-transformer';
import { IsIn, IsNumber, Min, ValidateIf } from 'class-validator';

// Sprint 21 (PDR-030): shared shape for BOTH CreateVendorDto's
// mandatory initial selection ("selected at registration") and the
// later PUT .../return-policy update - one validation rule, used in
// both places, so they can never silently drift apart.
//
// S21a accepts ONLY NO_RETURN/REFUND_ONLY - EXCHANGE_ONLY/BOTH exist
// on the DB enum for forward compatibility (S21b) but are rejected
// HERE, at the DTO boundary, with a 400 - never silently accepted and
// then quietly behaving like REFUND_ONLY, which would be a promise
// for a feature that doesn't exist yet.
export class ReturnPolicyInputDto {
  @IsIn(['NO_RETURN', 'REFUND_ONLY'], {
    message:
      'mode must be NO_RETURN or REFUND_ONLY (exchange is not built yet)',
  })
  mode!: 'NO_RETURN' | 'REFUND_ONLY';

  @ValidateIf((o) => o.mode === 'REFUND_ONLY')
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  window_days?: number;

  @ValidateIf((o) => o.mode === 'REFUND_ONLY')
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  fee_ils?: number;
}
