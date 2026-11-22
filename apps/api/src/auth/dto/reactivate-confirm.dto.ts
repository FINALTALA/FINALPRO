import { IsString } from 'class-validator';
import { PhoneField } from '../../common/phone/phone-input';

export class ReactivateConfirmDto {
  @PhoneField()
  phone!: string;

  @IsString()
  verification_token!: string;
}
