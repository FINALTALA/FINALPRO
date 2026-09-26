import { IsIn, IsInt, Min } from 'class-validator';
import { VerificationDecisionReason } from '../../common/validation/trimmed-text.decorator';

export type BranchVerificationDecision =
  'approve' | 'reject' | 'request_resubmission';

// FR-VEND-003: "approve, reject, or request resubmission" - three
// distinct reviewer outcomes, not two (see BranchVerificationStatus's
// RESUBMISSION_REQUESTED schema comment).
//
// Sprint 16 (D3): evidence_revision is required - the revision the
// reviewer read via GET .../verification-evidence. A mismatch with the
// branch's current revision is a 409 BRANCH_EVIDENCE_STALE, so a
// resubmission between the read and the decision can never be decided
// unseen. reason: required (trimmed, 10-1000) for reject and
// request_resubmission; must be absent for approve.
export class BranchVerificationDecisionDto {
  @IsIn(['approve', 'reject', 'request_resubmission'])
  decision!: BranchVerificationDecision;

  @IsInt()
  @Min(1)
  evidence_revision!: number;

  @VerificationDecisionReason()
  reason?: string;
}
