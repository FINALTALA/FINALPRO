import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { VendorsController } from './vendors.controller';

@Module({
  imports: [AuditModule, AuthModule, IdempotencyModule],
  controllers: [VendorsController],
})
export class VendorsModule {}
