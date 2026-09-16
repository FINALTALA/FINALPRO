import { IsPhoneNumber, IsString } from 'class-validator';

export class LoginDto {
  @IsPhoneNumber(undefined)
  phone!: string;

  @IsString()
  password!: string;
}
