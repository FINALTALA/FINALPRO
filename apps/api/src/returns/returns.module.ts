import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { OutboxModule } from '../outbox/outbox.module';
import { PlatformAlertsModule } from '../platform-alerts/platform-alerts.module';
import {
  BranchReturnQueueController,
  VendorReturnQueueController,
} from './branch-return-queue.controller';
import { BranchReturnQueueService } from './branch-return-queue.service';
import { BranchReturnsController } from './branch-returns.controller';
import { CustomerReturnsController } from './customer-returns.controller';
import { ReturnSweepService } from './return-sweep.service';
import { ReturnsService } from './returns.service';
import { VendorReturnsController } from './vendor-returns.controller';

// Sprint 21 (EPIC-RET). Exported: ReturnsService, so
// PlatformAdminModule's own AdminReturnsController (escalation
// decisions) can import this module and inject it, the same
// per-module-DI pattern OrdersModule already established for
// BranchOrderCancellationService.
@Module({
  imports: [
    AuditModule,
    AuthModule,
    OutboxModule,
    IdempotencyModule,
    PlatformAlertsModule,
    FeatureFlagsModule,
  ],
  controllers: [
    CustomerReturnsController,
    BranchReturnsController,
    VendorReturnsController,
    BranchReturnQueueController,
    VendorReturnQueueController,
  ],
  providers: [ReturnsService, ReturnSweepService, BranchReturnQueueService],
  exports: [ReturnsService],
})
export class ReturnsModule {}
