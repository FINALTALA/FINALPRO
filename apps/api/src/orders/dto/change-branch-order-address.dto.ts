import { IsString } from 'class-validator';

export class ChangeBranchOrderAddressDto {
  @IsString()
  address_id!: string;
}
