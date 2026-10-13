import { IsPhoneNumber, IsString } from 'class-validator';

export class ReactivateConfirmDto {
  @IsPhoneNumber(undefined)
  phone!: string;

  @IsString()
  verification_token!: string;
}
