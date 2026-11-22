import { PhoneField } from '../../common/phone/phone-input';

export class PasswordResetRequestDto {
  @PhoneField()
  phone!: string;
}
