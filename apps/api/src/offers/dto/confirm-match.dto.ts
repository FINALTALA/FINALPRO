import { IsIn } from 'class-validator';

export type MatchConfirmationDecision = 'confirm' | 'reject';

// FR-MATCH-012 (approved-product-decisions-2026-09.md, Sec 3.2 - not
// PDR-012, which is unrelated/covers store sections): "the vendor must
// explicitly confirm a proposed match... rejected/ignored matches
// publish as unmatched and can be re-searched." Two outcomes only -
// there is no "request more info" step like FR-VEND-003's branch
// verification has.
export class ConfirmMatchDto {
  @IsIn(['confirm', 'reject'])
  decision!: MatchConfirmationDecision;
}
