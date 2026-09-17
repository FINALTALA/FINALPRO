import { IsIn, IsOptional, IsString } from 'class-validator';

export type BranchVerificationDecision =
  'approve' | 'reject' | 'request_resubmission';

// FR-VEND-003: "approve, reject, or request resubmission" - three
// distinct reviewer outcomes, not two (see BranchVerificationStatus's
// RESUBMISSION_REQUESTED schema comment).
export class BranchVerificationDecisionDto {
  @IsIn(['approve', 'reject', 'request_resubmission'])
  decision!: BranchVerificationDecision;

  @IsOptional()
  @IsString()
  reason?: string;
}
