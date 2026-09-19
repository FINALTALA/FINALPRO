import { IsEnum } from 'class-validator';
import { StoreType } from '../../../generated/prisma/client';

export class UpdateStoreTypeDto {
  @IsEnum(StoreType)
  store_type!: StoreType;
}
