import { IsInt, IsString, Min } from 'class-validator';

export class AddCartItemDto {
  @IsString()
  vendor_id!: string;

  @IsString()
  offer_variant_id!: string;

  @IsInt()
  @Min(1)
  quantity!: number;
}
