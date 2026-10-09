import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { OutboxModule } from '../outbox/outbox.module';
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
  imports: [AuditModule, AuthModule, OutboxModule, IdempotencyModule],
  controllers: [
    CustomerReturnsController,
    BranchReturnsController,
    VendorReturnsController,
  ],
  providers: [ReturnsService, ReturnSweepService],
  exports: [ReturnsService],
})
export class ReturnsModule {}
