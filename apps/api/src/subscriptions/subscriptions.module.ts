import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { SubscriptionsController } from './subscriptions.controller';

@Module({
  imports: [AuditModule, AuthModule, IdempotencyModule],
  controllers: [SubscriptionsController],
})
export class SubscriptionsModule {}
