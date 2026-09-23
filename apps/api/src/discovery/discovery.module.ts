import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ComparisonController } from './comparison.controller';
import { ComparisonService } from './comparison.service';
import { DiscoveryController } from './discovery.controller';
import { FollowingController } from './following.controller';

@Module({
  imports: [AuthModule],
  controllers: [DiscoveryController, ComparisonController, FollowingController],
  providers: [ComparisonService],
})
export class DiscoveryModule {}
