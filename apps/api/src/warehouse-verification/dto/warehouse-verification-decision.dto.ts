import { IsIn, IsOptional, IsString } from 'class-validator';

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
export class WarehouseVerificationDecisionDto {
  @IsString()
  evidence_id!: string;

  @IsIn(['approve', 'reject', 'request_resubmission'])
  decision!: WarehouseVerificationDecision;

  @IsOptional()
  @IsString()
  reason?: string;
}
