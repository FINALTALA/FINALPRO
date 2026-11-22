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
  // PD-5.3: gates the public Bestseller mark (product page, discovery
  // cards) and the «الأكثر مبيعاً» sort (discovery, store page) - see
  // sales-rank-read.service.ts. Off by default; the hourly ranking job
  // itself runs either way.
  bestseller_enabled: {
    description: 'يتحكم بظهور شارة «الأكثر مبيعاً» وترتيبها للعملاء',
  },
  // TB-8: gates the periodic expired-checkout-reservation sweep
  // (checkout/reservation-sweep.service.ts) - off by default, so the
  // first clean-up of a database's old holds runs only when an admin
  // switches it on, and can be stopped at once with no redeploy. The
  // lazy release on reserve/confirm/cancel/POS works either way.
  reservation_sweep_enabled: {
    description:
      'يتحكم بتشغيل التنظيف الدوري للحجوزات المنتهية وتحرير ما تحجزه من مخزون',
  },
  // TB-15: gates the store notifications for a platform decision on an
  // escalated return and for a customer cancelling a return
  // (returns.service.ts writes the event only while this is on). Off by
  // default. Switching it off stops NEW events only: events already
  // written are still sent, and notifications already created stay.
  return_store_notifications_enabled: {
    description:
      'يتحكم بإشعار المتجر بقرار إدارة المنصة في طلب إرجاع وبإلغاء العميل لطلب الإرجاع',
  },
  // TB-26: while on, every store route (VendorMembershipGuard) and every
  // platform route (PlatformRoleGuard) also needs a workspace token for
  // that store / the platform (auth/workspace-session.ts), and
  // GET /me/notifications (the shopping bell) shows CUSTOMER notifications
  // only - store and platform ones are read in their own workspace. Off
  // by default: the web app must send workspace tokens before it is on.
  // Product-entry wizard (2026-11-16): gates the hourly draft clean-up
  // (offer-drafts/draft-upload-sweep.service.ts) - closes drafts untouched
  // for 90 days and deletes closed drafts' images nothing else uses. Off by
  // default; discarding or creating a draft cleans its images either way.
  offer_draft_cleanup_enabled: {
    description:
      'يتحكم بالتنظيف الدوري لمسودات المنتجات المهجورة وحذف صورها غير المستخدمة',
  },
  // Barcodes and in-store sales (2026-11-20): gates every route of
  // store-pos/ (product barcodes, label data, the cashier lookup, in-store
  // sales and their void) - 404 FEATURE_DISABLED when off - and the web's
  // cashier icon / barcode section. Off by default.
  store_cashier_enabled: {
    description:
      'يتحكم بباركود المنتجات وطباعة الملصقات وشاشة «بيع من المحل» ومبيعات المحل',
  },
  // «الصفحة الرئيسية المرنة للمتجر» (2026-11-20): gates the owner's home
  // page designer (store-home/ - 404 FEATURE_DISABLED when off) and what
  // shoppers see of it (GET /storefronts/:slug/home answers no blocks, the
  // store page stays exactly as before). Off by default.
  store_home_blocks_enabled: {
    description:
      'يتحكم بتصميم الصفحة الرئيسية للمتجر (البلوكات أعلى قسم المنتجات) وظهورها للمتسوقات',
  },
  workspace_scoping_enabled: {
    description:
      'يفصل التسوق عن مساحات العمل: أدوات المتجر والإدارة تحتاج دخولاً صريحاً لمساحة العمل (جرس التسوق يعرض إشعارات العميل فقط دائماً، مع العلم أو بدونه)',
  },
} as const satisfies Record<string, FeatureFlagDefinition>;

export type FeatureFlagKey = keyof typeof FEATURE_FLAG_REGISTRY;

export function isKnownFeatureFlag(key: string): key is FeatureFlagKey {
  return Object.prototype.hasOwnProperty.call(FEATURE_FLAG_REGISTRY, key);
}
