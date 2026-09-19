import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthController } from './auth.controller';
import { OtpService } from './otp.service';
import { PhoneVerificationService } from './phone-verification.service';
import { PlatformRoleGuard } from './platform-role.guard';
import { SessionAuthGuard } from './session-auth.guard';
import { SessionService } from './session.service';
import { SmsService } from './sms.service';

@Module({
  imports: [AuditModule],
  controllers: [AuthController],
  providers: [
    OtpService,
    SmsService,
    SessionService,
    PhoneVerificationService,
    SessionAuthGuard,
    PlatformRoleGuard,
  ],
  exports: [SessionService, SessionAuthGuard, PlatformRoleGuard],
})
export class AuthModule {}
