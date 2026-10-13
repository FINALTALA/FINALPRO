import {
  IsBoolean,
  IsEnum,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsPhoneNumber,
  IsString,
} from 'class-validator';
import { DeliveryZoneRegion } from '../../../generated/prisma/client';

// Sprint 22 (FR-AUTH-008, PDR-029): every field optional - a partial
// update. is_default folds "set as default" into this same generic
// PATCH rather than a bespoke /set-default action route.
export class PatchAddressDto {
  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsLatitude()
  lat?: number;

  @IsOptional()
  @IsLongitude()
  lng?: number;

  @IsOptional()
  @IsString()
  landmark_note?: string;

  @IsOptional()
  @IsPhoneNumber(undefined)
  phone_number_1?: string;

  @IsOptional()
  @IsPhoneNumber(undefined)
  phone_number_2?: string;

  @IsOptional()
  @IsEnum(DeliveryZoneRegion)
  zone?: DeliveryZoneRegion;

  @IsOptional()
  @IsBoolean()
  is_default?: boolean;
}
