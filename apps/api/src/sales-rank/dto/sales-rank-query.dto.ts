import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import {
  ProductAudience,
  SalesRankScope,
} from '../../../generated/prisma/client';

export class SalesRankQueryDto {
  @IsOptional()
  @IsIn(Object.values(SalesRankScope))
  scope?: SalesRankScope;

  @IsOptional()
  @Matches(/^[A-Z0-9_]{1,60}$/)
  category?: string;

  @IsOptional()
  @IsIn(Object.values(ProductAudience))
  audience?: ProductAudience;

  @IsOptional()
  @IsIn(['true', 'false'])
  qualified?: 'true' | 'false';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;
}
