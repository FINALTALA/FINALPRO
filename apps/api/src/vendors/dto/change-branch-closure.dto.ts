import { Transform } from 'class-transformer';
import { IsISO8601, IsNotEmpty, IsString, MaxLength } from 'class-validator';

const REASON_MAX_LENGTH = 500;
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// «ساعات العمل والإغلاقات v1»: cancelling or shortening a closure always
// carries a reason (mandatory, trimmed, never blank) - it lands in the
// audit row next to the before/after and the actor.
export class CancelBranchClosureDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(REASON_MAX_LENGTH)
  reason!: string;
}

export class ShortenBranchClosureDto {
  @IsISO8601()
  ends_at!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(REASON_MAX_LENGTH)
  reason!: string;
}
