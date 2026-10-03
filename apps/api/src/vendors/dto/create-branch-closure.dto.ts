import {
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

const REASON_MAX_LENGTH = 500;

// Sprint 18b (G-ON-07): starts_at/ends_at are real instants (ISO 8601
// with an offset), stored timestamptz - the controller itself checks
// starts_at < ends_at (also a DB CHECK, the real guarantee). reason
// follows ConfirmPhysicalCountDto.note's own established pattern
// exactly: trimmed first, blank-after-trim rejected if sent at all,
// length-capped; omitted entirely is fine.
export class CreateBranchClosureDto {
  @IsISO8601()
  starts_at!: string;

  @IsISO8601()
  ends_at!: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(REASON_MAX_LENGTH)
  reason?: string;
}
