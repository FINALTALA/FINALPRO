import { IsOptional, IsString, MinLength } from 'class-validator';

// Sprint 7 (RB-MATCH-003, Sec 3.2): "Any matched vendor may request a
// canonical-name change for admin approve/reject."
export class RequestNameChangeDto {
  @IsString()
  @MinLength(1)
  requested_name_ar!: string;

  @IsString()
  @MinLength(1)
  requested_name_en!: string;

  @IsOptional()
  @IsString()
  reason?: string;
}
