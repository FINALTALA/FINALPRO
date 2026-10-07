import { TrimmedText } from '../../common/validation/trimmed-text.decorator';

// PLATFORM_ADMIN manual refund - always a "break-glass" action
// (BR-019), always a mandatory 10-1000 character reason, always
// audited. The amount itself is never part of this DTO - it is always
// the server-computed remaining refundable figure (see
// BranchOrderCancellationService.adminManualRefund's own comment).
export class AdminRefundBranchOrderDto {
  @TrimmedText(10, 1000)
  reason!: string;
}
