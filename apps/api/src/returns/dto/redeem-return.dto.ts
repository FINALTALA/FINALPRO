import { IsIn, IsString, Length } from 'class-validator';

// Sprint 21 (PDR-031): no :branchId in this endpoint's own route (see
// ReturnsVendorController's own comment) - receiving_branch_id names
// which of the vendor's branches is doing the redeeming, body-level
// since any branch of the SAME vendor may accept the drop-off.
export class RedeemReturnDto {
  @IsString()
  @Length(6, 6)
  code!: string;

  @IsString()
  receiving_branch_id!: string;

  @IsIn(['RESELLABLE', 'DAMAGED'])
  item_condition!: 'RESELLABLE' | 'DAMAGED';
}
