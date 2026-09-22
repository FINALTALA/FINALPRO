import { IsString } from 'class-validator';

export class ConfirmCheckoutDto {
  @IsString()
  reservation_id!: string;
}
