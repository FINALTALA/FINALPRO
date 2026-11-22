import { IsOptional, IsUUID } from 'class-validator';
import { TrimmedText } from '../../common/validation/trimmed-text.decorator';

export class ReportReviewDto {
  @TrimmedText(1, 1000)
  reason!: string;

  /** PD-3: the report is about this one image of the review. */
  @IsOptional()
  @IsUUID()
  media_id?: string;
}
