import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class UpdateBrandDto {
  @IsString()
  name!: string;

  // M-09: the same possible-duplicate warning as create, overridable only
  // by an explicit confirmation (an exact duplicate is always refused).
  @IsOptional()
  @IsBoolean()
  confirm_despite_duplicate_warning?: boolean;
}
