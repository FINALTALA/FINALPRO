import { IsIn, IsString } from 'class-validator';
import { VerificationDecisionReason } from '../../common/validation/trimmed-text.decorator';

export type WarehouseVerificationDecision =
  'approve' | 'reject' | 'request_resubmission';

// PDR-035: same three reviewer outcomes as BranchVerificationDecisionDto
// (FR-VEND-003), applied to a WarehouseVerificationEvidence snapshot
// instead of a StoreBranch row. evidence_id is required - the decision
// is bound to one exact snapshot the reviewer read via
// GET .../warehouse/verification-evidence, never to "whichever row is
// currently pending" implicitly (see the controller: a mismatched or
// stale evidence_id is rejected with 409 WAREHOUSE_EVIDENCE_STALE
// rather than silently acting on a different row).
// Sprint 16: reason is required (trimmed, 10-1000) for reject and
// request_resubmission, and must be absent for approve.
export class WarehouseVerificationDecisionDto {
  @IsString()
  evidence_id!: string;

  @IsIn(['approve', 'reject', 'request_resubmission'])
  decision!: WarehouseVerificationDecision;

  @VerificationDecisionReason()
  reason?: string;
}
