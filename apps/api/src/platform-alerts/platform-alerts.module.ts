import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { AdminAlertRecipientsController } from './admin-alert-recipients.controller';
import { PlatformAlertRecipientsService } from './platform-alert-recipients.service';

// TB-12.2: who receives platform alerts. The resolver is exported for
// the alert senders (OrdersModule's integrity check today; returns
// escalation in TB-14); the admin management API lives here too.
@Module({
  imports: [AuditModule, AuthModule, IdempotencyModule],
  controllers: [AdminAlertRecipientsController],
  providers: [PlatformAlertRecipientsService],
  exports: [PlatformAlertRecipientsService],
})
export class PlatformAlertsModule {}
