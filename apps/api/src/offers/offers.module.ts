import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { MatchingModule } from '../matching/matching.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { VendorOffersController } from './vendor-offers.controller';

@Module({
  imports: [
    AuditModule,
    AuthModule,
    MatchingModule,
    IdempotencyModule,
    SubscriptionsModule,
  ],
  controllers: [VendorOffersController],
})
export class OffersModule {}
