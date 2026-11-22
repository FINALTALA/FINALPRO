import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { OutboxModule } from '../outbox/outbox.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { SandboxPaymentService } from './sandbox-payment.service';
import { ReserveRateLimitGuard } from './reserve-rate-limit.guard';
import { ReservationSweepService } from './reservation-sweep.service';

@Module({
  imports: [
    AuditModule,
    AuthModule,
    IdempotencyModule,
    SubscriptionsModule,
    OutboxModule,
    FeatureFlagsModule,
  ],
  controllers: [CheckoutController],
  providers: [
    CheckoutService,
    SandboxPaymentService,
    ReserveRateLimitGuard,
    ReservationSweepService,
  ],
  exports: [CheckoutService, ReservationSweepService],
})
export class CheckoutModule {}
