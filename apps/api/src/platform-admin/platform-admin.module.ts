import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { OutboxModule } from '../outbox/outbox.module';
import { AdminVendorsController } from './admin-vendors.controller';
import { VerificationQueueController } from './verification-queue.controller';

@Module({
  imports: [AuditModule, AuthModule, IdempotencyModule, OutboxModule],
  controllers: [VerificationQueueController, AdminVendorsController],
})
export class PlatformAdminModule {}
