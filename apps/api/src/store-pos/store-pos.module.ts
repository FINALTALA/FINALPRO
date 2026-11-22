import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { OutboxModule } from '../outbox/outbox.module';
import { OfferBarcodesController } from './offer-barcodes.controller';
import { OfferBarcodesService } from './offer-barcodes.service';
import { StoreSalesController } from './store-sales.controller';
import { StoreSalesService } from './store-sales.service';

/** Barcodes and in-store sales (2026-11-20) - behind `store_cashier_enabled`. */
@Module({
  imports: [
    AuditModule,
    AuthModule,
    IdempotencyModule,
    OutboxModule,
    FeatureFlagsModule,
  ],
  controllers: [OfferBarcodesController, StoreSalesController],
  providers: [OfferBarcodesService, StoreSalesService],
  // the wizard's publish attaches / generates the product's code in its own transaction
  exports: [OfferBarcodesService],
})
export class StorePosModule {}
