import { IsEnum } from 'class-validator';
import { OfferStatus } from '../../../generated/prisma/client';

export class UpdateVendorOfferStatusDto {
  @IsEnum(OfferStatus)
  status!: OfferStatus;
}
