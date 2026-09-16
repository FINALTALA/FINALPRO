import { IsPhoneNumber, IsString, Length, MinLength } from 'class-validator';

export class PasswordResetConfirmDto {
  @IsPhoneNumber(undefined)
  phone!: string;

  @IsString()
  @Length(6, 6, { message: 'otp_code must be a 6-digit code' })
  otp_code!: string;

  @IsString()
  @MinLength(8, { message: 'new_password must be at least 8 characters' })
  new_password!: string;
}
