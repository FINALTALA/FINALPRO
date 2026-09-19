import { IsLatitude, IsLongitude, IsOptional, IsString } from 'class-validator';

export class CreatePickupPointDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsLatitude()
  lat?: number;

  @IsOptional()
  @IsLongitude()
  lng?: number;

  @IsOptional()
  @IsString()
  address_note?: string;
}
