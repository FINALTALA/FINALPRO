import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { CanonicalNamingService } from './canonical-naming.service';
import { CanonicalProductsController } from './canonical-products.controller';
import { MatchReviewController } from './match-review.controller';
import { MatchingService } from './matching.service';

@Module({
  imports: [AuditModule, AuthModule, IdempotencyModule],
  controllers: [CanonicalProductsController, MatchReviewController],
  providers: [MatchingService, CanonicalNamingService],
  exports: [MatchingService, CanonicalNamingService],
})
export class MatchingModule {}
