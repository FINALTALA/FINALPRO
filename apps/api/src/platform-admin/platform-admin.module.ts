import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { OrdersModule } from '../orders/orders.module';
import { OutboxModule } from '../outbox/outbox.module';
import { ReturnsModule } from '../returns/returns.module';
import { ReviewsModule } from '../reviews/reviews.module';
import { VendorPerformanceModule } from '../vendor-performance/vendor-performance.module';
import { AdminAuditLogsController } from './admin-audit-logs.controller';
import { AdminBranchOrdersController } from './admin-branch-orders.controller';
import { AdminFeatureFlagsController } from './admin-feature-flags.controller';
import { AdminOutboxController } from './admin-outbox.controller';
import { AdminReturnsController } from './admin-returns.controller';
import { AdminReviewsController } from './admin-reviews.controller';
import { AdminVendorPerformanceController } from './admin-vendor-performance.controller';
import { AdminVendorsController } from './admin-vendors.controller';
import { VerificationQueueController } from './verification-queue.controller';

// Sprint 20a: AdminBranchOrdersController needs OrdersModule imported
// here (not just available elsewhere) for the same per-module-DI
// reason as every other cross-module service dependency in this
// codebase - BranchOrderCancellationService is only resolvable if
// this module imports the module that exports it. Sprint 21:
// AdminReturnsController needs ReturnsModule for the same reason
// (ReturnsService). Sprint 23: AdminReviewsController needs
// ReviewsModule (ReviewsService). Sprint 25: AdminFeatureFlagsController
// needs FeatureFlagsModule (FeatureFlagsService);
// AdminVendorPerformanceController needs both VendorPerformanceModule
// (VendorPerformanceService) and FeatureFlagsModule (its own feature
// gate check). AdminAuditLogsController needs neither - it reads
// AuditLog directly via PrismaService, already available through
// AuditModule.
@Module({
  imports: [
    AuditModule,
    AuthModule,
    IdempotencyModule,
    OrdersModule,
    OutboxModule,
    ReturnsModule,
    ReviewsModule,
    FeatureFlagsModule,
    VendorPerformanceModule,
  ],
  controllers: [
    VerificationQueueController,
    // AdminVendorPerformanceController's literal 'admin/vendors/performance'
    // route must be registered before AdminVendorsController's
    // 'admin/vendors/:vendorId' - Express/Nest matches routes in
    // registration order, so a param route registered first would
    // otherwise swallow the literal one (vendorId="performance").
    AdminVendorPerformanceController,
    AdminVendorsController,
    AdminOutboxController,
    AdminBranchOrdersController,
    AdminReturnsController,
    AdminReviewsController,
    AdminAuditLogsController,
    AdminFeatureFlagsController,
  ],
})
export class PlatformAdminModule {}
