import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { CanonicalProductStatus } from '../../../generated/prisma/client';

export class CreateCanonicalProductDto {
  @IsUUID()
  brand_id!: string;

  @IsUUID()
  category_id!: string;

  @IsString()
  model_name!: string;

  @IsOptional()
  @IsEnum(CanonicalProductStatus)
  status?: CanonicalProductStatus;
}
