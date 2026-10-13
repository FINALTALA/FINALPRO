import {
  IsIn,
  IsOptional,
  IsPhoneNumber,
  IsString,
  ValidateIf,
} from 'class-validator';

// Sprint 22 (FR-AUTH-006/009): the one generic PATCH /customers/me
// SRS Part 4 names literally - phone change, language preference, and
// display name all go through it, rather than bespoke action routes
// per field.
export class PatchMeDto {
  @IsOptional()
  @IsPhoneNumber(undefined)
  phone?: string;

  // Required WHENEVER phone is present (an unverified phone change is
  // never allowed), and simply inert/unused when phone is absent - a
  // verification_token with no phone to apply it to does nothing, by
  // construction of the handler below, not by a separate rejection
  // rule for that specific combination.
  @ValidateIf((o: PatchMeDto) => o.phone !== undefined)
  @IsString()
  verification_token?: string;

  @IsOptional()
  @IsIn(['ar', 'en'])
  language_pref?: 'ar' | 'en';

  @IsOptional()
  @IsString()
  display_name?: string;
}
