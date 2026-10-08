import { IsOptional } from 'class-validator';
import { TrimmedText } from '../../common/validation/trimmed-text.decorator';

// PDR-028: "before preparation ... after preparation but before Sent,
// staff may cancel an item/order after external contact." Whether the
// reason is MANDATORY depends on the order's CURRENT status (PLACED:
// optional, matching the customer's own window; PREPARING: mandatory,
// this cancellation's own auditable record of the required external
// contact) - a fact the DTO itself cannot know before the order is
// even loaded under lock, so that conditional check happens in the
// controller/service, not here. This DTO only validates the SHAPE of
// a reason that IS provided (10-1000 chars after trimming).
export class StaffCancelBranchOrderDto {
  @IsOptional()
  @TrimmedText(10, 1000)
  reason?: string;
}
