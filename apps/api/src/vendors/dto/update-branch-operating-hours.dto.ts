import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

// Sprint 18b + «ساعات العمل والإغلاقات v1»: PUT replaces the WHOLE week in
// one call. A day may have several periods (e.g. 09:00-14:00 and
// 16:00-21:00); omitting a day means closed that day. The controller
// re-checks open < close, the 15-minute step and that periods of the same
// day never overlap (also a DB EXCLUDE, the real guarantee). A period never
// crosses midnight: 24:00 (1440) only as an end. Palestine (Asia/Hebron)
// wall-clock minutes - see common/branch-opening.util.ts. Informational
// only: never read by checkout/reserve to refuse anything.
export const HOURS_STEP_MINUTES = 15;
export const MAX_PERIODS_PER_WEEK = 42;
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
  @ArrayMaxSize(MAX_PERIODS_PER_WEEK)
  @ValidateNested({ each: true })
  @Type(() => OperatingHoursEntryDto)
  hours!: OperatingHoursEntryDto[];
}
