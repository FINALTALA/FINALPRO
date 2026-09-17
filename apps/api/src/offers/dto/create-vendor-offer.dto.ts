import { IsString } from 'class-validator';

export class CreateVendorOfferDto {
  @IsString()
  title_ar!: string;

  @IsString()
  title_en!: string;
}
