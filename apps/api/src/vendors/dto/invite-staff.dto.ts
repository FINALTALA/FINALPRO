import { IsPhoneNumber } from 'class-validator';

export class InviteStaffDto {
  @IsPhoneNumber(undefined, {
    message: 'phone must be a valid phone number in international format',
  })
  phone!: string;
}
