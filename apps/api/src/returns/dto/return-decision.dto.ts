import { IsIn } from 'class-validator';
import { VerificationDecisionReason } from '../../common/validation/trimmed-text.decorator';

// Sprint 21: reuses the exact same reason-validation convention
// already established for vendor-verification decisions (approve ->
// no reason at all; reject -> required, trimmed, 10-1000 chars) -
// the decorator reads the sibling `decision` field by its literal
// 'approve' value, which this DTO's own field also uses.
export class ReturnDecisionDto {
  @IsIn(['approve', 'reject'])
  decision!: 'approve' | 'reject';

  @VerificationDecisionReason()
  rejection_reason?: string;
}
