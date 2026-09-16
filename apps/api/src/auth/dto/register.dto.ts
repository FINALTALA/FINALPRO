import { IsPhoneNumber, IsString, MinLength } from 'class-validator';

export class RegisterDto {
  @IsPhoneNumber(undefined)
  phone!: string;

  // Minimum length only - the SRS doesn't specify a full password
  // policy (complexity rules etc.); 8 chars is a reasonable, commonly
  // used default, not an asserted business rule.
  @IsString()
  @MinLength(8, { message: 'password must be at least 8 characters' })
  password!: string;

  // The session_token POST /auth/otp/verify returned for purpose=signup.
  @IsString()
  verification_token!: string;
}
