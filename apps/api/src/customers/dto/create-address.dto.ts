import {
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsPhoneNumber,
  IsString,
} from 'class-validator';

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
}
