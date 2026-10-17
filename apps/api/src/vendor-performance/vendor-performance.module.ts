import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { ReviewsModule } from '../reviews/reviews.module';
import { VendorPerformanceController } from './vendor-performance.controller';
import { VendorPerformanceService } from './vendor-performance.service';

// Sprint 25 (FR-VEND-011): exports VendorPerformanceService so
// PlatformAdminModule's own AdminVendorPerformanceController can
// import this module and inject it - same per-module-DI pattern
// ReviewsModule/ReturnsModule already established.
@Module({
  imports: [AuthModule, ReviewsModule, FeatureFlagsModule],
  controllers: [VendorPerformanceController],
  providers: [VendorPerformanceService],
  exports: [VendorPerformanceService],
})
export class VendorPerformanceModule {}
