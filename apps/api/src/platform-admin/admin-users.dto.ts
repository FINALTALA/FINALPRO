import { TrimmedText } from '../common/validation/trimmed-text.decorator';

// VIA phase 3 - Users Management. Every action needs a written reason,
// kept in the audit log (and, for a suspension, on the account itself).

export class SuspendUserDto {
  @TrimmedText(5, 500)
  reason!: string;
}

export class LiftSuspensionDto {
  @TrimmedText(5, 500)
  note!: string;
}

export class ForceSignOutDto {
  @TrimmedText(5, 500)
  reason!: string;
}
