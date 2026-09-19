import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { AuthController } from './auth.controller';
import { MeController } from './me.controller';
import { OtpService } from './otp.service';
import { PhoneVerificationService } from './phone-verification.service';
import { PlatformRoleGuard } from './platform-role.guard';
import { SessionAuthGuard } from './session-auth.guard';
import { SessionService } from './session.service';
import { SmsService } from './sms.service';
import { VendorMembershipGuard } from './vendor-membership.guard';

@Module({
  imports: [AuditModule, IdempotencyModule],
  controllers: [AuthController, MeController],
  providers: [
    OtpService,
    SmsService,
    SessionService,
    PhoneVerificationService,
    SessionAuthGuard,
    PlatformRoleGuard,
    VendorMembershipGuard,
  ],
  exports: [
    SessionService,
    SessionAuthGuard,
    PlatformRoleGuard,
    VendorMembershipGuard,
    OtpService,
    PhoneVerificationService,
  ],
})
export class AuthModule {}
