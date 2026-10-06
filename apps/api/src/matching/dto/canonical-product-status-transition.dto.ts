import { IsEnum } from 'class-validator';
import { CanonicalProductStatus } from '../../../generated/prisma/client';

export class CanonicalProductStatusTransitionDto {
  @IsEnum(CanonicalProductStatus)
  to_status!: CanonicalProductStatus;
}
