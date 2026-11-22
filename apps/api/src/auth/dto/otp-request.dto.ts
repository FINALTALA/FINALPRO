import { IsIn } from 'class-validator';
import { WIRE_OTP_PURPOSES, WireOtpPurpose } from '../otp-purpose.util';
import { PhoneField } from '../../common/phone/phone-input';

// Field names are snake_case to match Part 4, H.3's documented wire
// contract (`{ phone, otp_code, purpose }`) exactly, rather than
// translating to/from camelCase at the boundary.
export class OtpRequestDto {
  @PhoneField()
  phone!: string;

  @IsIn(WIRE_OTP_PURPOSES)
  purpose!: WireOtpPurpose;
}
