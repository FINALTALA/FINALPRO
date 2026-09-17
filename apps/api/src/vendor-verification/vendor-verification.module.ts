import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { VendorVerificationController } from './vendor-verification.controller';

@Module({
  imports: [AuditModule, AuthModule],
  controllers: [VendorVerificationController],
})
export class VendorVerificationModule {}
