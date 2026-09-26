import { IsEnum } from 'class-validator';
import { SuspensionReasonCode } from '../../../generated/prisma/client';
import { TrimmedText } from '../../common/validation/trimmed-text.decorator';

// FR-VEND-009: "suspend/reactivate a vendor with reason capture and an
// audit record". reason is required, trimmed, 10-1000 characters.
export class SuspendVendorDto {
  @IsEnum(SuspensionReasonCode)
  reason_code!: SuspensionReasonCode;

  @TrimmedText(10, 1000)
  reason!: string;
}

export class ReactivateVendorDto {
  @TrimmedText(10, 1000)
  reason!: string;
}
