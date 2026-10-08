import { IsNumber, Min, ValidateIf } from 'class-validator';

// Sprint 20b (FR-PRICE-006): shared shape for both the branch-level
// default and the delivery-zone override - a single required field
// (never "omit to leave unchanged", unlike UpdateDeliveryZoneDto.fee -
// this endpoint has nothing else to leave unchanged), explicit null
// meaning "no minimum" rather than any sentinel number.
export class UpdateMinimumOrderValueDto {
  @ValidateIf((o) => o.minimum_order_value !== null)
  @IsNumber()
  @Min(0)
  minimum_order_value!: number | null;
}
