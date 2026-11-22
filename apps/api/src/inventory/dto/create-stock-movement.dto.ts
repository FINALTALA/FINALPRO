import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  NotEquals,
} from 'class-validator';

// Sprint 6 (RB-INV-003, PDR-021): "Manual non-sale stock reductions
// (damage, loss, count correction) need a mandatory reason." reason is
// the fixed category; reason_note is the free-text explanation - both
// required (a category alone does not tell an owner reviewing the log
// *why* three units left the shelf).
//
// «إدارة مخزون الفرع v1» (2026-11-22) - the manual movements:
//  - RECEIVE (goods received): quantity_delta > 0 only.
//  - DAMAGE / LOSS / INTERNAL_USE (internal use, gift, sample):
//    quantity_delta < 0 only.
//  - COUNT_CORRECTION (a physical count): counted_quantity (what is on the
//    shelf) + expected_quantity (what the screen showed when the count
//    started); the server works the difference out and refuses
//    STOCK_CHANGED_RECOUNT if the stock moved meanwhile. The older
//    `quantity_delta` form is still accepted for COUNT_CORRECTION only
//    (existing callers/fixtures); the store's screen never sends it.
//  - SALE is accepted here ONLY to be refused with a clear code
//    (MANUAL_SALE_NOT_ALLOWED): a sale is the cashier's alone. A manual
//    movement never creates an invoice, a sale, an order or any money.
export const MANUAL_MOVEMENT_REASONS = [
  'RECEIVE',
  'DAMAGE',
  'LOSS',
  'INTERNAL_USE',
  'COUNT_CORRECTION',
] as const;
export type ManualMovementReason = (typeof MANUAL_MOVEMENT_REASONS)[number];

export class CreateStockMovementDto {
  @IsIn([...MANUAL_MOVEMENT_REASONS, 'SALE'])
  reason!: ManualMovementReason | 'SALE';

  @IsOptional()
  @IsInt()
  @NotEquals(0)
  @Min(-100000)
  @Max(100000)
  quantity_delta?: number;

  /** COUNT_CORRECTION: the number on the shelf. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000000)
  counted_quantity?: number;

  /** COUNT_CORRECTION: the quantity the screen showed when counting began. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000000)
  expected_quantity?: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason_note!: string;
}
