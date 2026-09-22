import {
  IsEnum,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsPhoneNumber,
  IsString,
} from 'class-validator';
import { DeliveryZoneRegion } from '../../../generated/prisma/client';

// FR-AUTH-008 / BL-AUTH-004 ("minimal slice"): map pin + landmark +
// phone number(s), captured at the point of use. Field names are
// snake_case to match Part 4, H.2's domain-table naming style used
// throughout this API.
export class CreateAddressDto {
  @IsOptional()
  @IsString()
  label?: string;

  @IsLatitude()
  lat!: number;

  @IsLongitude()
  lng!: number;

  @IsOptional()
  @IsString()
  landmark_note?: string;

  @IsPhoneNumber(undefined)
  phone_number_1!: string;

  @IsOptional()
  @IsPhoneNumber(undefined)
  phone_number_2?: string;

  // Sprint 10 (PDR-022): the customer's own declared delivery region -
  // NOT a geographically verified boundary (OPEN-012 leaves that
  // source undecided - see Address.zone's own schema.prisma comment).
  // Required going forward so every NEW address is usable for delivery
  // checkout; pre-existing Sprint 2 addresses simply have zone = null
  // until re-saved.
  @IsEnum(DeliveryZoneRegion)
  zone!: DeliveryZoneRegion;
}
