import { TrimmedText } from '../../common/validation/trimmed-text.decorator';

// PLATFORM_ADMIN forced cancel - always a "break-glass" action
// (BR-019), always a mandatory 10-1000 character reason, always
// audited.
export class AdminCancelBranchOrderDto {
  @TrimmedText(10, 1000)
  reason!: string;
}
