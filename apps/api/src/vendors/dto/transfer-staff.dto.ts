import { IsString } from 'class-validator';

// Sprint 18b (G-IN-05, RB-ROLE-003): branch_id is the TARGET branch -
// controller re-validates it (same vendor, APPROVED, not archived)
// fresh under lock, never trusts this value alone.
export class TransferStaffDto {
  @IsString()
  branch_id!: string;
}
