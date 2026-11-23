import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CreateDeliveryWindowDto } from './create-delivery-window.dto';

// Full replace, not a partial update - same shape as create, matching
// this sprint's deliberately simple "owner re-submits the whole window"
// editing model (no partial-field PATCH semantics needed yet).
// «نوافذ التوصيل v1»: `reason` is required whenever the capacity changes
// (checked in the controller - it goes into the audit log).
export class UpdateDeliveryWindowDto extends CreateDeliveryWindowDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(3, { message: 'reason must be at least 3 characters' })
  @MaxLength(300)
  reason?: string;
}
