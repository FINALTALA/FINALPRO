import { ArrayMinSize, IsArray, IsString, IsUUID } from 'class-validator';

export class SplitCanonicalProductDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  variant_ids!: string[];

  @IsUUID()
  brand_id!: string;

  @IsUUID()
  category_id!: string;

  @IsString()
  model_name!: string;
}
