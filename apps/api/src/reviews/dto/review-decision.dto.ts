import { IsIn } from 'class-validator';

// Sprint 23 (PDR-032): a PLATFORM_ADMIN's decision on a PENDING
// ReviewReport. dismiss leaves the review VISIBLE; uphold moves it to
// HIDDEN - see ReviewsService.decide().
export class ReviewDecisionDto {
  @IsIn(['dismiss', 'uphold'])
  decision!: 'dismiss' | 'uphold';
}
