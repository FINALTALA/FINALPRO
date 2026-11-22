import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import {
  ReviewAuthorDisplay,
  ReviewFit,
  ReviewTag,
} from '../../../generated/prisma/client';
import { TrimmedText } from '../../common/validation/trimmed-text.decorator';
import {
  MAX_REVIEW_TAGS,
  REVIEW_AUTHOR_DISPLAYS,
  REVIEW_FITS,
  REVIEW_TAGS,
} from '../review-presenter';

// Sprint 23 (PDR-032): deliberately does NOT accept a client-supplied
// canonical_product_id/vendor_id - the target is always derived
// server-side from source_branch_order_item_id + target_type (see
// ReviewsService.submit()), so there is nothing a client could spoof
// to review a product/store they never actually bought. PD-3 adds the
// optional structured signals - never a purchased colour/size, which
// is copied from the order item's own snapshot.
export class CreateReviewDto {
  @IsString()
  source_branch_order_item_id!: string;

  @IsIn(['PRODUCT', 'STORE'])
  target_type!: 'PRODUCT' | 'STORE';

  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @TrimmedText(1, 1000)
  body!: string;

  /** PRODUCT reviews only. */
  @IsOptional()
  @IsIn(REVIEW_FITS)
  fit_feedback?: ReviewFit;

  /** PRODUCT reviews only; at most three, no repeats. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_REVIEW_TAGS)
  @ArrayUnique()
  @IsIn(REVIEW_TAGS, { each: true })
  tags?: ReviewTag[];

  @IsOptional()
  @IsIn(REVIEW_AUTHOR_DISPLAYS)
  author_display?: ReviewAuthorDisplay;
}

/**
 * PD-3 (decision 1): the author's own edit. Omitted = unchanged;
 * `fit_feedback: null` clears the verdict. Content changes are allowed
 * within 30 days of creation; author_display alone may change any time.
 */
export class UpdateReviewDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @IsOptional()
  @TrimmedText(1, 1000)
  body?: string;

  @IsOptional()
  @IsIn(REVIEW_FITS)
  fit_feedback?: ReviewFit | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_REVIEW_TAGS)
  @ArrayUnique()
  @IsIn(REVIEW_TAGS, { each: true })
  tags?: ReviewTag[];

  @IsOptional()
  @IsIn(REVIEW_AUTHOR_DISPLAYS)
  author_display?: ReviewAuthorDisplay;
}
