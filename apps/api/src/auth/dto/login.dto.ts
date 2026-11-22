import { IsString } from 'class-validator';
import { PhoneField } from '../../common/phone/phone-input';

export class LoginDto {
  @PhoneField()
  phone!: string;

  @IsString()
  password!: string;
}
