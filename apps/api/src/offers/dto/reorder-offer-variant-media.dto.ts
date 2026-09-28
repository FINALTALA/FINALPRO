import { ArrayMinSize, IsString } from 'class-validator';

export class ReorderOfferVariantMediaDto {
  @IsString({ each: true })
  @ArrayMinSize(1)
  media_ids!: string[];
}
