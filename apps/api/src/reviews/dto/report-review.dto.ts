import { TrimmedText } from '../../common/validation/trimmed-text.decorator';

export class ReportReviewDto {
  @TrimmedText(1, 1000)
  reason!: string;
}
