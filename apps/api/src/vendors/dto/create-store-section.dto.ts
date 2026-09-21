import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateStoreSectionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name: string;
}
