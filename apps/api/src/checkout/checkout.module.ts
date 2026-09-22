import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { SandboxPaymentService } from './sandbox-payment.service';

@Module({
  imports: [AuditModule, AuthModule, IdempotencyModule, SubscriptionsModule],
  controllers: [CheckoutController],
  providers: [CheckoutService, SandboxPaymentService],
  exports: [CheckoutService],
})
export class CheckoutModule {}
