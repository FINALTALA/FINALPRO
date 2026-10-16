import { IsString } from 'class-validator';

export class AddComparisonSetItemDto {
  @IsString()
  canonical_product_id!: string;
}
