import { PhoneField } from '../../common/phone/phone-input';

export class ReactivateRequestDto {
  @PhoneField()
  phone!: string;
}
