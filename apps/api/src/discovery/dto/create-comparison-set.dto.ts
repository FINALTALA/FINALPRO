import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsString,
} from 'class-validator';

export class CreateComparisonSetDto {
  @IsString({ each: true })
  @ArrayUnique()
  @ArrayMinSize(1, { message: 'At least one product is required' })
  @ArrayMaxSize(4, { message: 'A comparison set can hold at most 4 items' })
  canonical_product_ids!: string[];
}
