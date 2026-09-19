import { IsIn, IsInt, IsNotEmpty, IsString, NotEquals } from 'class-validator';
import { StockMovementReason } from '../../../generated/prisma/client';

// Sprint 6 (RB-INV-003, PDR-021): "Manual non-sale stock reductions
// (damage, loss, count correction) need a mandatory reason." reason is
// the fixed category (checked against the enum, not free text);
// reason_note is the free-text explanation - both required, matching
// PDR-021's "mandatory reason" literally (a category alone, with no
// explanation, would not tell an owner reviewing the log *why* three
// units were marked damaged). quantity_delta is signed: negative for a
// reduction (the only direction DAMAGE/LOSS allow - enforced in
// InventoryController, not here, since it depends on `reason`), either
// direction for COUNT_CORRECTION (a physical recount can find more
// stock than recorded, not just less).
export class CreateStockMovementDto {
  @IsIn(['DAMAGE', 'LOSS', 'COUNT_CORRECTION'])
  reason!: StockMovementReason;

  @IsInt()
  @NotEquals(0)
  quantity_delta!: number;

  @IsString()
  @IsNotEmpty()
  reason_note!: string;
}
