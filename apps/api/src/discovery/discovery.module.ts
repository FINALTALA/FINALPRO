import { Module } from '@nestjs/common';
import { FollowingFeedService } from './following-feed.service';
import { StoreComparisonService } from './store-comparison.service';
import { AuthModule } from '../auth/auth.module';
import { ReviewsModule } from '../reviews/reviews.module';
import { TaxonomyModule } from '../taxonomy/taxonomy.module';
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
  imports: [AuthModule, ReviewsModule, TaxonomyModule],
  controllers: [
    DiscoveryController,
    ComparisonController,
    CrossComparisonController,
    FollowingController,
    ComparisonSetsController,
    ComparisonSetsSharedController,
  ],
  providers: [
    ComparisonService,
    ComparisonSetsService,
    DiscoveryBrowseService,
    FollowingFeedService,
    StoreComparisonService,
  ],
  // PD-5b.2: platform collections show the same card as discovery.
  exports: [ComparisonService],
})
export class DiscoveryModule {}
