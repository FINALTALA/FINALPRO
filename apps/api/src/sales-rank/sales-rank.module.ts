import { Global, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { AdminSalesRankController } from './admin-sales-rank.controller';
import { OwnerSalesRankController } from './owner-sales-rank.controller';
import { SalesRankReadService } from './sales-rank-read.service';
import { SalesRankSweepService } from './sales-rank-sweep.service';
import { SalesRankService } from './sales-rank.service';

// Global: the public reads (product page, discovery, store page) inject
// SalesRankReadService from their own modules.
@Global()
@Module({
  imports: [AuditModule, AuthModule, IdempotencyModule, FeatureFlagsModule],
  controllers: [AdminSalesRankController, OwnerSalesRankController],
  providers: [SalesRankService, SalesRankSweepService, SalesRankReadService],
  exports: [SalesRankService, SalesRankReadService],
})
export class SalesRankModule {}
