import { IsString, MaxLength, MinLength } from 'class-validator';

// PDR-026: "a 'not received' report requires a reason."
export class ReportNotReceivedDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  reason!: string;
}
