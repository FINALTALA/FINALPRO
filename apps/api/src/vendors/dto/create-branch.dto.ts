import {
  IsBoolean,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
} from 'class-validator';

export class CreateBranchDto {
  @IsString()
  name!: string;

  @IsBoolean()
  is_physical!: boolean;

  // Deliberately optional even for a physical branch: FR-VEND-002's
  // mandatory pin + storefront photo is enforced before *approval*
  // (BL-VEND-002, Sprint 3), not at initial application submission
  // (BL-VEND-001, this endpoint).
  @IsOptional()
  @IsLatitude()
  lat?: number;

  @IsOptional()
  @IsLongitude()
  lng?: number;
}
