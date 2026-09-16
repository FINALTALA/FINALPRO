import { IsIn, IsPhoneNumber } from 'class-validator';
import { WIRE_OTP_PURPOSES, WireOtpPurpose } from '../otp-purpose.util';

// Field names are snake_case to match Part 4, H.3's documented wire
// contract (`{ phone, otp_code, purpose }`) exactly, rather than
// translating to/from camelCase at the boundary.
export class OtpRequestDto {
  @IsPhoneNumber(undefined, {
    message: 'phone must be a valid phone number in international format',
  })
  phone!: string;

  @IsIn(WIRE_OTP_PURPOSES)
  purpose!: WireOtpPurpose;
}
