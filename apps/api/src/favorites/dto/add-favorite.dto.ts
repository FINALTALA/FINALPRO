import { IsIn, IsString, ValidateIf } from 'class-validator';

export class AddFavoriteDto {
  @IsIn(['PRODUCT', 'OFFER'])
  target_type!: 'PRODUCT' | 'OFFER';

  @ValidateIf((o: AddFavoriteDto) => o.target_type === 'PRODUCT')
  @IsString()
  canonical_product_id?: string;

  @ValidateIf((o: AddFavoriteDto) => o.target_type === 'OFFER')
  @IsString()
  offer_variant_id?: string;
}
