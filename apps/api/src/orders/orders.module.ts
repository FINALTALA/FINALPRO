import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { BranchOrderService } from './branch-order.service';
import { BranchOrdersStaffController } from './branch-orders-staff.controller';

// Sprint 9 (RB-ORD-001): BranchOrderService, exported for Sprint 10's
// checkout module to inject. See branch-order.service.ts's own
// comment. AuditModule must be imported here (not just available
// elsewhere in the app) - Nest's DI is scoped per module, so
// BranchOrderService's own AuditLogService dependency is only
// resolvable if this module imports it directly.
// Sprint 10 (RB-ORD-004): a minimal, read-only staff/owner order list
// controller added here - see BranchOrdersStaffController's own
// comment for exactly what it does and does not expose.
@Module({
  imports: [AuditModule, AuthModule],
  controllers: [BranchOrdersStaffController],
  providers: [BranchOrderService],
  exports: [BranchOrderService],
})
export class OrdersModule {}
