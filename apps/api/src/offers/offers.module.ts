import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { MatchingModule } from '../matching/matching.module';
import { OutboxModule } from '../outbox/outbox.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { TaxonomyModule } from '../taxonomy/taxonomy.module';
import { DiscountActivationSweepService } from './discount-activation-sweep.service';
import { OfferPresentationController } from './offer-presentation.controller';
import { OfferPublishService } from './offer-publish.service';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { OffersImportController } from './offers-import.controller';
import { VendorOffersController } from './vendor-offers.controller';

// Sprint 19: DiscountActivationSweepService's own OutboxEventService
// dependency needs OutboxModule imported here (Nest DI is per-module
// scoped) - same reasoning OrdersModule's own comment already gives
// for FulfilmentReconciliationService.
import { VariantLocateController } from './variant-locate.controller';

@Module({
  imports: [
    AuditModule,
    AuthModule,
    MatchingModule,
    IdempotencyModule,
    SubscriptionsModule,
    OutboxModule,
    TaxonomyModule,
    FeatureFlagsModule,
  ],
  controllers: [
    VendorOffersController,
    OffersImportController,
    OfferPresentationController,
    VariantLocateController,
  ],
  providers: [DiscountActivationSweepService, OfferPublishService],
  exports: [DiscountActivationSweepService, OfferPublishService],
})
export class OffersModule {}
