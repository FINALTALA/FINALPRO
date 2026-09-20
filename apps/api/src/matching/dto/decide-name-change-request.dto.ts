import { IsIn, IsOptional, IsString } from 'class-validator';

export type NameChangeRequestDecision = 'approve' | 'reject';

export class DecideNameChangeRequestDto {
  @IsIn(['approve', 'reject'])
  decision!: NameChangeRequestDecision;

  @IsOptional()
  @IsString()
  note?: string;
}
