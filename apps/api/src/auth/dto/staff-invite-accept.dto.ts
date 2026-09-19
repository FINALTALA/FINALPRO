import {
  IsOptional,
  IsPhoneNumber,
  IsString,
  MinLength,
} from 'class-validator';

// Sprint 4 (RB-ROLE-002): same shape as RegisterDto's
// verification_token contract (the session_token POST /auth/otp/verify
// returned for purpose=staff_invite), plus an optional password - only
// required when the invited phone has no existing User account yet.
// An existing user proves the same phone via the same OTP but keeps
// their current password.
export class StaffInviteAcceptDto {
  @IsPhoneNumber(undefined)
  phone!: string;

  @IsString()
  verification_token!: string;

  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'password must be at least 8 characters' })
  password?: string;
}
