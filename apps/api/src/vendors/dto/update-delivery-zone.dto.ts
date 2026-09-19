import { IsBoolean } from 'class-validator';

export class UpdateDeliveryZoneDto {
  @IsBoolean()
  enabled!: boolean;
}
