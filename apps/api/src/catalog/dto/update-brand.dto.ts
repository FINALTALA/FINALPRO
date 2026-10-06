import { IsString } from 'class-validator';

export class UpdateBrandDto {
  @IsString()
  name!: string;
}
