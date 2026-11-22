import { IsInt, Max, Min } from 'class-validator';
import { MAX_DELIVERY_LEAD_MINUTES } from '../../checkout/delivery-calendar.util';

/** PD-5.1: a branch's preparation time before a delivery window. */
export class UpdateDeliveryLeadTimeDto {
  @IsInt()
  @Min(0)
  @Max(MAX_DELIVERY_LEAD_MINUTES)
  delivery_lead_minutes!: number;
}
