/**
 * Shared, side-effect-free constants for the Sprint 12 demo seed
 * (scripts/seed-demo.ts) and its idempotency verification
 * (test/seed-demo-idempotency.e2e-spec.ts) - kept in their own module,
 * separate from seed-demo.ts's own top-level `main().catch(...)` call,
 * so importing these values never accidentally re-runs the seed.
 *
 * LOCAL DEMO DATA ONLY - never real secrets.
 */
export const DEMO = {
  owner: {
    phone: '+970560000001',
    password: 'DemoOwner#2026',
    displayName: 'صاحبة المتجر التجريبي',
  },
  employee: {
    phone: '+970560000002',
    password: 'DemoEmployee#2026',
    displayName: 'موظف الفرع التجريبي',
  },
  customer: {
    phone: '+970560000003',
    password: 'DemoCustomer#2026',
    displayName: 'زبون تجريبي',
  },
} as const;

export const VENDOR_ONE = {
  slug: 'demo-fashion-house',
  legalName: 'دار الأزياء التجريبية للاستيراد والتصدير',
  displayName: 'دار الأزياء التجريبية',
  whatsappUrl: 'https://wa.me/970560000001',
  instagramUrl: 'https://instagram.com/demo_fashion_house',
} as const;

export const VENDOR_TWO = {
  slug: 'demo-style-corner',
  legalName: 'ركن الأناقة التجريبي للتجارة العامة',
  displayName: 'ركن الأناقة التجريبي',
  facebookUrl: 'https://facebook.com/demo.style.corner',
  instagramUrl: 'https://instagram.com/demo_style_corner',
} as const;

export const BRAND_NORMALIZED_NAME = 'demo-style-brand';
export const CATEGORY_NAME_EN = 'Demo Women Fashion';
export const CANONICAL_GTIN = '0000000000demo1';
export const CANONICAL_PLATFORM_BARCODE = 'PPB-DEMO-0000001';
export const OFFER_ONE_SELLER_SKU = 'DEMO-SKU-V1-001';
export const OFFER_TWO_SELLER_SKU = 'DEMO-SKU-V2-001';
export const BRANCH_ONE_A_NAME = 'الفرع الرئيسي';
export const BRANCH_ONE_B_NAME = 'فرع رام الله';
export const BRANCH_TWO_A_NAME = 'الفرع الوحيد';
export const DEMO_ADDRESS_LABEL = 'عنوان تجريبي';
