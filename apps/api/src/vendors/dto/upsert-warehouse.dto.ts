import { Transform } from 'class-transformer';
import {
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class UpsertWarehouseDto {
  @IsOptional()
  @IsLatitude()
  lat?: number;

  @IsOptional()
  @IsLongitude()
  lng?: number;

  // Trimmed BEFORE validation (global ValidationPipe has transform: true),
  // so a whitespace-only note becomes '' and fails MinLength(1) as a 400
  // instead of being stored as a value that looks set but is blank.
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1, {
    message: 'address_note must not be empty or whitespace-only',
  })
  address_note?: string;
}
