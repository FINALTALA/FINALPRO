import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { HealthController } from './health.controller';

@Module({
  imports: [AuditModule, IdempotencyModule],
  controllers: [HealthController],
})
export class HealthModule {}
