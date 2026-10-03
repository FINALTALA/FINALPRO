import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

// Sprint 18b (FR-VEND-006/FR-VPORTAL-009, informational only - product
// decision): PUT replaces the WHOLE week in one call - at most 7
// entries (one per day), omitting a day means closed that day. The
// controller re-checks day_of_week uniqueness within the array and
// open_minute < close_minute (also a DB CHECK on the stored rows, the
// real guarantee) - this DTO only bounds each field's own range.
// Interpreted as Asia/Jerusalem wall-clock minutes - see
// branch-operating-hours.util.ts. Never read by checkout/reserve.
export class OperatingHoursEntryDto {
  @IsInt()
  @Min(0)
  @Max(6)
  day_of_week!: number;

  @IsInt()
  @Min(0)
  @Max(1439)
  open_minute!: number;

  @IsInt()
  @Min(1)
  @Max(1440)
  close_minute!: number;
}

export class UpdateBranchOperatingHoursDto {
  @IsArray()
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => OperatingHoursEntryDto)
  hours!: OperatingHoursEntryDto[];
}
