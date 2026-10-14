import { IsIn, IsInt, IsString, Max, Min } from 'class-validator';
import { TrimmedText } from '../../common/validation/trimmed-text.decorator';

// Sprint 23 (PDR-032): deliberately does NOT accept a client-supplied
// canonical_product_id/vendor_id - the target is always derived
// server-side from source_branch_order_item_id + target_type (see
// ReviewsService.submit()), so there is nothing a client could spoof
// to review a product/store they never actually bought.
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
}
