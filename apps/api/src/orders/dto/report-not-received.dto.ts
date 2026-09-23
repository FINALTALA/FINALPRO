import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

// PDR-026: "a 'not received' report requires a reason." Codex review
// on commit f940a80: a whitespace-only reason (e.g. "   ") passed a
// plain MinLength(1) check trivially - trimmed here BEFORE validation
// runs (main.ts's global ValidationPipe has transform: true, so
// class-transformer's @Transform always applies before class-
// validator's own decorators see the value), so an empty-after-trim
// reason is correctly rejected as 400, never silently accepted as a
// single space.
export class ReportNotReceivedDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1, { message: 'reason must not be empty or whitespace-only' })
  @MaxLength(1000)
  reason!: string;
}
