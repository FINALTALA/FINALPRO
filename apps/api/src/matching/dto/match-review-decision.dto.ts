import { IsIn } from 'class-validator';

export type MatchReviewDecision = 'approve' | 'reject';

// Sprint 6 (RB-MATCH-002): mirrors ConfirmMatchDto's own
// confirm/reject shape (the exact-match flow) - "approve" here plays
// the same role "confirm" does there. Two outcomes only, same as that
// DTO - "request re-search" is a different endpoint entirely (calling
// search again), not a third decision value here.
export class MatchReviewDecisionDto {
  @IsIn(['approve', 'reject'])
  decision!: MatchReviewDecision;
}
