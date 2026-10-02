import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

const NOTE_MAX_LENGTH = 500;

// Sprint 18a (review-round fix): `note` is optional, but if it's sent
// at all it must be a real note, not a payload the handler receives
// and silently ignores. Trimmed first via @Transform (ValidationPipe's
// transform:true applies this before the checks below run), so
// whitespace-only input becomes '' and is then rejected by
// @IsNotEmpty() - "blank if sent" is refused, not silently accepted as
// "provided". @IsOptional() still lets the field be omitted entirely.
// Recorded ONLY in this endpoint's AuditLog.afterState, never written
// onto BranchStock itself - there is no column for it.
export class ConfirmPhysicalCountDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(NOTE_MAX_LENGTH)
  note?: string;
}
