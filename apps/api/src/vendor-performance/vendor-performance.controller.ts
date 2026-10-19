import {
  Controller,
  Get,
  NotFoundException,
  Param,
  UseGuards,
} from '@nestjs/common';
import { VendorMembershipGuard } from '../auth/vendor-membership.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { RequireVendorRole } from '../auth/vendor-role.decorator';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { VendorPerformanceService } from './vendor-performance.service';

async function requireFeatureEnabled(
  featureFlags: FeatureFlagsService,
): Promise<void> {
  const enabled = await featureFlags.isEnabled(
    'vendor_performance_dashboard_enabled',
  );
  if (!enabled) {
    throw new NotFoundException({
      code: 'FEATURE_DISABLED',
      message: 'This feature is not currently available',
    });
  }
}

// Sprint 25 (FR-VEND-011): owner-only (per FR-VPORTAL-007's own text -
// "employee has ... no ... analytics access") - VendorMembershipGuard
// is BOLA-safe by the same design every other vendor-scoped route in
// this codebase already relies on. Gated by
// `vendor_performance_dashboard_enabled` at the API itself, not just
// hidden in the UI - a direct call with the flag off gets the exact
// same 404 a non-existent route would.
@Controller('vendors/:vendorId/performance')
@UseGuards(SessionAuthGuard, VendorMembershipGuard)
@RequireVendorRole('OWNER')
export class VendorPerformanceController {
  constructor(
    private readonly vendorPerformance: VendorPerformanceService,
    private readonly featureFlags: FeatureFlagsService,
  ) {}

  @Get()
  async get(@Param('vendorId') vendorId: string) {
    await requireFeatureEnabled(this.featureFlags);
    return this.vendorPerformance.computeForVendor(vendorId);
  }
}
