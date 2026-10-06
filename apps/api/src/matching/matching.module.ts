import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { CanonicalNamingService } from './canonical-naming.service';
import { CanonicalProductLifecycleService } from './canonical-product-lifecycle.service';
import { CanonicalProductMergeService } from './canonical-product-merge.service';
import { CanonicalProductsController } from './canonical-products.controller';
import { MatchReportsController } from './match-reports.controller';
import { MatchReportsService } from './match-reports.service';
import { MatchReviewController } from './match-review.controller';
import { MatchingService } from './matching.service';

@Module({
  imports: [AuditModule, AuthModule, IdempotencyModule],
  controllers: [
    CanonicalProductsController,
    MatchReviewController,
    MatchReportsController,
  ],
  providers: [
    MatchingService,
    CanonicalNamingService,
    CanonicalProductLifecycleService,
    CanonicalProductMergeService,
    MatchReportsService,
  ],
  exports: [MatchingService, CanonicalNamingService],
})
export class MatchingModule {}
