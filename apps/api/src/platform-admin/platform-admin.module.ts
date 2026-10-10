import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { OrdersModule } from '../orders/orders.module';
import { OutboxModule } from '../outbox/outbox.module';
import { ReturnsModule } from '../returns/returns.module';
import { AdminBranchOrdersController } from './admin-branch-orders.controller';
import { AdminOutboxController } from './admin-outbox.controller';
import { AdminReturnsController } from './admin-returns.controller';
import { AdminVendorsController } from './admin-vendors.controller';
import { VerificationQueueController } from './verification-queue.controller';

// Sprint 20a: AdminBranchOrdersController needs OrdersModule imported
// here (not just available elsewhere) for the same per-module-DI
// reason as every other cross-module service dependency in this
// codebase - BranchOrderCancellationService is only resolvable if
// this module imports the module that exports it. Sprint 21:
// AdminReturnsController needs ReturnsModule for the same reason
// (ReturnsService).
@Module({
  imports: [
    AuditModule,
    AuthModule,
    IdempotencyModule,
    OrdersModule,
    OutboxModule,
    ReturnsModule,
  ],
  controllers: [
    VerificationQueueController,
    AdminVendorsController,
    AdminOutboxController,
    AdminBranchOrdersController,
    AdminReturnsController,
  ],
})
export class PlatformAdminModule {}
