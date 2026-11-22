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
import { VendorSuspendedGuard } from './vendor-suspended.guard';
import { WorkspaceSessionsController } from './workspace-sessions.controller';
import {
  AdminNotificationsController,
  VendorNotificationsController,
} from './workspace-notifications.controller';

@Module({
  imports: [AuditModule, IdempotencyModule],
  controllers: [
    AuthController,
    MeController,
    WorkspaceSessionsController,
    VendorNotificationsController,
    AdminNotificationsController,
  ],
  providers: [
    OtpService,
    SmsService,
    SessionService,
    PhoneVerificationService,
    SessionAuthGuard,
    PlatformRoleGuard,
    VendorMembershipGuard,
    VendorSuspendedGuard,
  ],
  exports: [
    SessionService,
    SessionAuthGuard,
    PlatformRoleGuard,
    VendorMembershipGuard,
    VendorSuspendedGuard,
    OtpService,
    PhoneVerificationService,
  ],
})
export class AuthModule {}
