import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { WarehouseVerificationController } from './warehouse-verification.controller';

@Module({
  imports: [AuditModule, AuthModule, IdempotencyModule],
  controllers: [WarehouseVerificationController],
})
export class WarehouseVerificationModule {}
