import { IsIn, IsString, ValidateIf } from 'class-validator';

/** TB-26: entering one workspace - a store (by id) or the platform. */
export class CreateWorkspaceSessionDto {
  @IsIn(['vendor', 'platform'])
  type!: 'vendor' | 'platform';

  @ValidateIf((o: CreateWorkspaceSessionDto) => o.type === 'vendor')
  @IsString()
  vendor_id?: string;
}
