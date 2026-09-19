import { IsIn } from 'class-validator';

export type MatchConfirmationDecision = 'confirm' | 'reject';

// PDR-012 (approved-product-decisions-2026-09.md): "the vendor must
// explicitly confirm a proposed match... rejected/ignored matches
// publish as unmatched and can be re-searched." Two outcomes only -
// there is no "request more info" step like FR-VEND-003's branch
// verification has.
export class ConfirmMatchDto {
  @IsIn(['confirm', 'reject'])
  decision!: MatchConfirmationDecision;
}
