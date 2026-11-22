import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { OutboxModule } from '../outbox/outbox.module';
import {
  OwnerReviewsController,
  ReviewMediaController,
} from './review-media.controller';
import { ReviewReadsController } from './review-reads.controller';
import { ReviewReadsService } from './review-reads.service';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';

// Sprint 23 (EPIC-REV). Exported: ReviewsService, so
// PlatformAdminModule's own AdminReviewsController (report decisions)
// can import this module and inject it - same per-module-DI pattern
// ReturnsModule already established for ReturnsService.
@Module({
  imports: [AuditModule, AuthModule, IdempotencyModule, OutboxModule],
  controllers: [
    ReviewsController,
    ReviewReadsController,
    ReviewMediaController,
    OwnerReviewsController,
  ],
  providers: [ReviewsService, ReviewReadsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
