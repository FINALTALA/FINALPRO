import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { OfferPairingsController } from './offer-pairings.controller';
import { OfferPairingsService } from './offer-pairings.service';

@Module({
  imports: [AuditModule, AuthModule, IdempotencyModule, SubscriptionsModule],
  controllers: [OfferPairingsController],
  providers: [OfferPairingsService],
})
export class OfferPairingsModule {}
