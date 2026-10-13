import { IsPhoneNumber } from 'class-validator';

export class ReactivateRequestDto {
  @IsPhoneNumber(undefined)
  phone!: string;
}
