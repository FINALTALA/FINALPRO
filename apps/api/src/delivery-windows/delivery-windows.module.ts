import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { DeliveryLeadTimeController } from './delivery-lead-time.controller';
import { DeliveryWindowsController } from './delivery-windows.controller';

@Module({
  imports: [AuditModule, AuthModule, IdempotencyModule],
  controllers: [DeliveryWindowsController, DeliveryLeadTimeController],
})
export class DeliveryWindowsModule {}
