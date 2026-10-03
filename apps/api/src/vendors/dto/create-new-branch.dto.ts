import { IsLatitude, IsLongitude, IsOptional, IsString } from 'class-validator';

// Sprint 18b (G-ON-07, FR-VEND-006): adding a branch AFTER the initial
// application (CreateBranchDto, POST /vendors). Deliberately no
// is_physical field - a branch added this way is always physical
// (forced true in the controller); ONLINE_ONLY vendors never gain a
// branch at all, they use the existing hidden-Warehouse flow (PDR-010).
export class CreateNewBranchDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsLatitude()
  lat?: number;

  @IsOptional()
  @IsLongitude()
  lng?: number;
}
