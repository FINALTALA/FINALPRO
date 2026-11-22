import { PhoneField } from '../../common/phone/phone-input';

export class InviteStaffDto {
  @PhoneField()
  phone!: string;
}
