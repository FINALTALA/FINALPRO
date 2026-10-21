import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ReviewsModule } from '../reviews/reviews.module';
import {
  ComparisonSetsController,
  ComparisonSetsSharedController,
} from './comparison-sets.controller';
import { ComparisonSetsService } from './comparison-sets.service';
import {
  ComparisonController,
  CrossComparisonController,
} from './comparison.controller';
import { ComparisonService } from './comparison.service';
import { DiscoveryController } from './discovery.controller';
import { DiscoveryBrowseService } from './discovery-browse.service';
import { FollowingController } from './following.controller';

@Module({
  imports: [AuthModule, ReviewsModule],
  controllers: [
    DiscoveryController,
    ComparisonController,
    CrossComparisonController,
    FollowingController,
    ComparisonSetsController,
    ComparisonSetsSharedController,
  ],
  providers: [ComparisonService, ComparisonSetsService, DiscoveryBrowseService],
})
export class DiscoveryModule {}
