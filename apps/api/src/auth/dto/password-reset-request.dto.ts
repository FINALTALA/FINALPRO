import { IsPhoneNumber } from 'class-validator';

export class PasswordResetRequestDto {
  @IsPhoneNumber(undefined)
  phone!: string;
}
