import { IsIn, IsString, Length } from 'class-validator';
import { WIRE_OTP_PURPOSES, WireOtpPurpose } from '../otp-purpose.util';
import { PhoneField } from '../../common/phone/phone-input';

export class OtpVerifyDto {
  @PhoneField()
  phone!: string;

  @IsString()
  @Length(6, 6, { message: 'otp_code must be a 6-digit code' })
  otp_code!: string;

  @IsIn(WIRE_OTP_PURPOSES)
  purpose!: WireOtpPurpose;
}
