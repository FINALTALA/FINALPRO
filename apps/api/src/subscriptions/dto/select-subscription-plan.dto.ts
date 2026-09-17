import { IsEnum } from 'class-validator';
import { SubscriptionPlan } from '../../../generated/prisma/client';

export class SelectSubscriptionPlanDto {
  @IsEnum(SubscriptionPlan)
  plan!: SubscriptionPlan;
}
