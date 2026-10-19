/**
 * Sprint 25 (FR-ADMIN-004): the ONE fixed, code-defined list of
 * feature-flag keys this app actually understands - never an
 * open-ended key an admin can invent from the UI or API.
 * `FeatureFlagsService.setFlag()` rejects any key not listed here with
 * 400 UNKNOWN_FEATURE_FLAG before it ever reaches a DB write.
 *
 * Each entry's `description` names the REAL capability it gates - no
 * flag exists here unless something in the running app actually reads
 * it to decide behaviour (see the comment on each). Adding a flag
 * "for later" with no real consumer is exactly what this registry is
 * meant to prevent.
 */
export interface FeatureFlagDefinition {
  /** What this flag controls, in plain terms - shown to the admin as-is. */
  description: string;
}

export const FEATURE_FLAG_REGISTRY = {
  // Sprint 25 (FR-VEND-011): gates both GET /vendors/:id/performance
  // and GET /admin/vendors/performance (404 FEATURE_DISABLED when
  // off), and the vendor-dashboard performance section that calls the
  // first of those - see vendor-performance.controller.ts and
  // apps/web/src/app/vendor/[vendorId]/page.tsx. Lets this sprint's own
  // new dashboard be hidden instantly, with no redeploy, if its
  // metrics formulas turn out wrong after release.
  vendor_performance_dashboard_enabled: {
    description: 'يتحكم بظهور لوحة مؤشرات أداء البائع للبائع والأدمن',
  },
} as const satisfies Record<string, FeatureFlagDefinition>;

export type FeatureFlagKey = keyof typeof FEATURE_FLAG_REGISTRY;

export function isKnownFeatureFlag(key: string): key is FeatureFlagKey {
  return Object.prototype.hasOwnProperty.call(FEATURE_FLAG_REGISTRY, key);
}
