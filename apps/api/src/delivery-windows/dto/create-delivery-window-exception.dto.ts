import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  Min,
} from 'class-validator';

// PDR-024's "exceptions" - a dated override for one specific calendar
// date: either a full closure (is_closed) or a capacity override
// (capacity_override) - never both at once (checked in the controller,
// a cross-field rule class-validator's per-field decorators can't
// express cleanly on their own; also backstopped by this migration's
// own CHECK constraint on the DB row itself).
export class CreateDeliveryWindowExceptionDto {
  @IsDateString()
  exception_date!: string;

  @IsOptional()
  @IsBoolean()
  is_closed?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  capacity_override?: number;
}
