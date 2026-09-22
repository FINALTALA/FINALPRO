import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BranchOrderService } from './branch-order.service';

// Sprint 9 (RB-ORD-001): no controller yet - schema plus a tested,
// standalone state-machine service, exported for Sprint 10's checkout
// module to inject once it exists. See branch-order.service.ts's own
// comment. AuditModule must be imported here (not just available
// elsewhere in the app) - Nest's DI is scoped per module, so
// BranchOrderService's own AuditLogService dependency is only
// resolvable if this module imports it directly.
@Module({
  imports: [AuditModule],
  providers: [BranchOrderService],
  exports: [BranchOrderService],
})
export class OrdersModule {}
