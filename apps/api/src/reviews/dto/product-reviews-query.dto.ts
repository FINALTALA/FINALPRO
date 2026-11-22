import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { ReviewFit } from '../../../generated/prisma/client';

// PD-3: GET /canonical-products/:id/reviews query. Every value is
// validated here; anything else is dropped by the global whitelist pipe.
const CODE = /^[A-Z0-9_]{1,40}$/;

export class ProductReviewsQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @IsString()
  limit?: string;

  @IsOptional()
  @IsIn(['newest', 'helpful', 'rating_desc', 'rating_asc'])
  sort?: 'newest' | 'helpful' | 'rating_desc' | 'rating_asc';

  @IsOptional()
  @IsIn(['true', 'false'])
  has_media?: 'true' | 'false';

  @IsOptional()
  @Matches(CODE, { message: 'color must be a colour code' })
  color?: string;

  @IsOptional()
  @Matches(CODE, { message: 'size must be a size code' })
  size?: string;

  @IsOptional()
  @IsIn(['1', '2', '3', '4', '5'])
  rating?: string;

  @IsOptional()
  @IsIn(Object.values(ReviewFit))
  fit?: ReviewFit;

  @IsOptional()
  @Matches(/^[a-z0-9-]{1,120}$/, { message: 'store must be a store slug' })
  store?: string;
}
