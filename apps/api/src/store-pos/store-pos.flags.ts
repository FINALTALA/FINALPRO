import { NotFoundException } from '@nestjs/common';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';

/**
 * Barcodes and the in-store cashier sit behind `store_cashier_enabled`
 * (off by default): with it off every route of this module answers the
 * same 404 FEATURE_DISABLED a missing route would - checked at the API,
 * not only hidden in the UI.
 */
export async function requireCashierEnabled(
  featureFlags: FeatureFlagsService,
): Promise<void> {
  if (!(await featureFlags.isEnabled('store_cashier_enabled'))) {
    throw new NotFoundException({
      code: 'FEATURE_DISABLED',
      message: 'This feature is not currently available',
    });
  }
}
