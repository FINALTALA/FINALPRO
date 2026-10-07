import { IsOptional } from 'class-validator';
import { TrimmedText } from '../../common/validation/trimmed-text.decorator';

// PDR-027: a failed-delivery report - the reason is optional (unlike
// cancellation, this isn't an authority-bypass action; it is simply
// reporting what happened at the door).
export class MarkDeliveryFailedDto {
  @IsOptional()
  @TrimmedText(10, 1000)
  reason?: string;
}
