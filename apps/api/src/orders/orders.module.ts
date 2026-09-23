import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { OutboxModule } from '../outbox/outbox.module';
import { BranchOrderService } from './branch-order.service';
import { BranchOrdersStaffController } from './branch-orders-staff.controller';
import { CustomerOrdersController } from './customer-orders.controller';
import { FulfilmentReconciliationService } from './fulfilment-reconciliation.service';

// Sprint 9 (RB-ORD-001): BranchOrderService, exported for Sprint 10's
// checkout module to inject. See branch-order.service.ts's own
// comment. AuditModule must be imported here (not just available
// elsewhere in the app) - Nest's DI is scoped per module, so
// BranchOrderService's own AuditLogService dependency is only
// resolvable if this module imports it directly.
// Sprint 10 (RB-ORD-004): a minimal, read-only staff/owner order list
// controller added here - see BranchOrdersStaffController's own
// comment for exactly what it does and does not expose.
// Sprint 11 (RB-ORD-005, RB-FUL-002/003): the customer-facing Orders
// UI controller and the Sent/Delivered/confirm loop's fulfilment
// actions (added to BranchOrdersStaffController) and lazy
// reconciliation (FulfilmentReconciliationService, which writes
// notification-dispatch records via OutboxEventService - OutboxModule
// must be imported here for the same per-module DI reason as
// AuditModule above).
@Module({
  imports: [AuditModule, AuthModule, OutboxModule],
  controllers: [BranchOrdersStaffController, CustomerOrdersController],
  providers: [BranchOrderService, FulfilmentReconciliationService],
  exports: [BranchOrderService, FulfilmentReconciliationService],
})
export class OrdersModule {}
