import { IsBoolean, IsIn } from 'class-validator';

export class SetNotificationPreferenceDto {
  @IsIn(['PRICE_DROP', 'BACK_IN_STOCK', 'NEW_OFFER'])
  alert_type!: 'PRICE_DROP' | 'BACK_IN_STOCK' | 'NEW_OFFER';

  @IsBoolean()
  enabled!: boolean;
}
