import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { VendorVerificationController } from './vendor-verification.controller';
import { VerificationStatusController } from './verification-status.controller';

@Module({
  imports: [AuditModule, AuthModule, IdempotencyModule],
  controllers: [VendorVerificationController, VerificationStatusController],
})
export class VendorVerificationModule {}
