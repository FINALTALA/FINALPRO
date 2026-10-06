import { IsOptional, IsUUID } from 'class-validator';
import { TrimmedText } from '../../common/validation/trimmed-text.decorator';

// Sprint 17b (FR-MATCH-005): never accepts a candidate id directly -
// the server derives the current candidate from offer_variant_id alone
// (MatchReportsService), so a caller can never target an arbitrary
// MatchReviewCandidate row.
export class CreateMatchReportDto {
  @IsUUID()
  offer_variant_id!: string;

  @IsOptional()
  @TrimmedText(1, 500)
  note?: string;
}
