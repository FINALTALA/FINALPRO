import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { FeatureFlagsService } from './feature-flags.service';

// Sprint 25 (FR-ADMIN-004): a pure service module - no controller of
// its own. `AdminFeatureFlagsController` (the only consumer that
// writes) lives in `platform-admin/`, same established pattern
// ReviewsModule/ReturnsModule already use for their own admin-facing
// controllers; `VendorPerformanceModule` imports this module too, to
// read (never write) the one flag it gates on.
@Module({
  imports: [AuditModule],
  providers: [FeatureFlagsService],
  exports: [FeatureFlagsService],
})
export class FeatureFlagsModule {}
