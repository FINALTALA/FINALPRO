import { IsIn, ValidateIf } from 'class-validator';
import { TrimmedText } from '../../common/validation/trimmed-text.decorator';

// Sprint 23 (PDR-032): a PLATFORM_ADMIN's decision on a PENDING
// ReviewReport. dismiss leaves the review VISIBLE; uphold moves it to
// HIDDEN - see ReviewsService.decide(). PD-3: an uphold must say why
// (kept on the reports, the audit log and the author's notification);
// a dismissal may carry one too.
export class ReviewDecisionDto {
  @IsIn(['dismiss', 'uphold'])
  decision!: 'dismiss' | 'uphold';

  @ValidateIf(
    (o: ReviewDecisionDto) => o.decision === 'uphold' || o.reason !== undefined,
  )
  @TrimmedText(1, 500)
  reason?: string;
}

/** PD-3: an administrator hides one image of a review, with a reason. */
export class HideReviewMediaDto {
  @TrimmedText(1, 500)
  reason!: string;
}
