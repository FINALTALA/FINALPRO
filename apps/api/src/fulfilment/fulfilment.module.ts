import { Global, Module } from '@nestjs/common';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { FulfilmentEligibilityService } from './fulfilment-eligibility.service';

// Global: checkout, cart, discovery, the public store routes and the
// comparison all read the same FulfilmentEligibilityService (PD-2).
@Global()
@Module({
  imports: [SubscriptionsModule],
  providers: [FulfilmentEligibilityService],
  exports: [FulfilmentEligibilityService],
})
export class FulfilmentModule {}
