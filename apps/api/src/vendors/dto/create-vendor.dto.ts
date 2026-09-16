import { Type } from 'class-transformer';
import { ArrayMinSize, IsString, ValidateNested } from 'class-validator';
import { CreateBranchDto } from './create-branch.dto';

// FR-VEND-001 / BL-VEND-001: "application form + >=1 branch required
// to submit" - the ArrayMinSize(1) below is that acceptance criterion.
export class CreateVendorDto {
  @IsString()
  legal_name!: string;

  @ValidateNested({ each: true })
  @Type(() => CreateBranchDto)
  @ArrayMinSize(1, { message: 'At least one branch is required to submit' })
  branches!: CreateBranchDto[];
}
