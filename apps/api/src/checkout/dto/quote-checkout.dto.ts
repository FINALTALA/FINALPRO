import { ArrayMinSize, IsArray, IsOptional, IsString } from 'class-validator';

export class QuoteCheckoutDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  cart_item_ids!: string[];

  @IsOptional()
  @IsString()
  address_id?: string;
}
