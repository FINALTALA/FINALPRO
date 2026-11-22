import { IsString, Length, MinLength } from 'class-validator';
import { PhoneField } from '../../common/phone/phone-input';

export class PasswordResetConfirmDto {
  @PhoneField()
  phone!: string;

  @IsString()
  @Length(6, 6, { message: 'otp_code must be a 6-digit code' })
  otp_code!: string;

  @IsString()
  @MinLength(8, { message: 'new_password must be at least 8 characters' })
  new_password!: string;
}
