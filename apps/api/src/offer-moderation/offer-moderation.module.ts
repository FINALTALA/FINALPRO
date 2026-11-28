import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import {
  AdminOfferModerationController,
  OwnerOfferHoldController,
} from './offer-moderation.controller';
import { OfferModerationService } from './offer-moderation.service';

/** VIA phase 2C - platform offer moderation (Platform Hold). */
@Module({
  imports: [AuditModule, AuthModule, IdempotencyModule],
  controllers: [AdminOfferModerationController, OwnerOfferHoldController],
  providers: [OfferModerationService],
})
export class OfferModerationModule {}
