import { Module } from '@nestjs/common';
import { ComparisonController } from './comparison.controller';
import { ComparisonService } from './comparison.service';
import { DiscoveryController } from './discovery.controller';

@Module({
  controllers: [DiscoveryController, ComparisonController],
  providers: [ComparisonService],
})
export class DiscoveryModule {}
