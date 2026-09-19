import { IsLatitude, IsLongitude, IsOptional, IsString } from 'class-validator';

export class UpsertWarehouseDto {
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
