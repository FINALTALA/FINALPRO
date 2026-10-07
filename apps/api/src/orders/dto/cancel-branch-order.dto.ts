import { IsOptional } from 'class-validator';
import { TrimmedText } from '../../common/validation/trimmed-text.decorator';

// PDR-028: a customer's own pre-prep self-service cancellation (whole
// order or a single item) never requires a reason - this is the
// customer's own free choice, not an action needing external
// justification. If one IS provided, it still has to be a real
// 10-1000 character reason after trimming, not an empty/whitespace
// placeholder.
export class CancelBranchOrderDto {
  @IsOptional()
  @TrimmedText(10, 1000)
  reason?: string;
}
