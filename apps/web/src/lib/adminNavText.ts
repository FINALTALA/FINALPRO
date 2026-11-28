import { registerTranslations } from "./i18n";

// VIA admin frame (app/admin/layout.tsx): the sidebar / mobile section
// labels, keyed by each section's route (lib/nav.ts adminTiles decides
// which sections a role sees - this only names them). The Arabic labels
// are the tiles' own titles. The role label reuses ws.enter.role.*
// (lib/workspaceText.ts).

export const ADMIN_NAV_KEY_PREFIX = "admin.nav.";

registerTranslations({
  ar: {
    "admin.frame.title": "إدارة المنصة",
    "admin.frame.sections_aria": "أقسام إدارة المنصة",
    "admin.nav./admin": "نظرة عامة",
    "admin.nav./admin/approvals": "مركز الموافقات",
    "admin.nav./admin/brands/requests": "طلبات العلامات التجارية",
    "admin.nav./admin/verification": "طابور التحقق",
    "admin.nav./admin/vendors": "المتاجر",
    "admin.nav./admin/offers": "إشراف العروض",
    "admin.nav./admin/orders": "الطلبات",
    "admin.nav./admin/analytics": "التحليلات",
    "admin.nav./admin/media": "مكتبة الوسائط",
    "admin.nav./admin/content": "استوديو المحتوى",
    "admin.nav./admin/users": "المستخدمون",
    "admin.nav./admin/settings": "الإعدادات والفريق",
    "admin.nav./admin/name-change-requests": "طلبات تغيير الاسم",
    "admin.nav./admin/categories": "التصنيفات",
    "admin.nav./admin/brands": "العلامات التجارية",
    "admin.nav./admin/canonical-products": "المنتجات المرجعية",
    "admin.nav./admin/branch-orders": "إلغاء/استرداد الطلبات",
    "admin.nav./admin/returns": "الإرجاعات المتصاعدة",
    "admin.nav./admin/reviews": "بلاغات المراجعات",
    "admin.nav./admin/audit-logs": "سجل التدقيق",
    "admin.nav./admin/feature-flags": "أعلام الميزات",
    "admin.nav./admin/vendors/performance": "أداء المتاجر",
    "admin.nav./admin/size-guides": "أدلة المقاسات",
    "admin.nav./admin/collections": "مجموعات المنصة",
    "admin.nav./admin/alert-recipients": "مستلمو تنبيهات المنصة",
  },
  en: {
    "admin.frame.title": "Platform management",
    "admin.frame.sections_aria": "Platform admin sections",
    "admin.nav./admin": "Overview",
    "admin.nav./admin/approvals": "Approval Center",
    "admin.nav./admin/brands/requests": "Brand requests",
    "admin.nav./admin/verification": "Verification queue",
    "admin.nav./admin/vendors": "Stores",
    "admin.nav./admin/offers": "Offer moderation",
    "admin.nav./admin/orders": "Orders",
    "admin.nav./admin/analytics": "Analytics",
    "admin.nav./admin/media": "Media Library",
    "admin.nav./admin/content": "Content Studio",
    "admin.nav./admin/users": "Users",
    "admin.nav./admin/settings": "Settings & Team",
    "admin.nav./admin/name-change-requests": "Name change requests",
    "admin.nav./admin/categories": "Categories",
    "admin.nav./admin/brands": "Brands",
    "admin.nav./admin/canonical-products": "Canonical products",
    "admin.nav./admin/branch-orders": "Order cancellations & refunds",
    "admin.nav./admin/returns": "Escalated returns",
    "admin.nav./admin/reviews": "Reported reviews",
    "admin.nav./admin/audit-logs": "Audit log",
    "admin.nav./admin/feature-flags": "Feature flags",
    "admin.nav./admin/vendors/performance": "Store performance",
    "admin.nav./admin/size-guides": "Size guides",
    "admin.nav./admin/collections": "Platform collections",
    "admin.nav./admin/alert-recipients": "Platform alert recipients",
  },
});

// The hub shortcuts' one-line descriptions, keyed by route. Arabic stays
// in each tile's own `description` (lib/nav.ts); English lives here.
// A route without an entry shows the tile's Arabic description.
export const ADMIN_DESC_KEY_PREFIX = "admin.desc.";

registerTranslations({
  ar: {},
  en: {
    "admin.desc./admin/approvals": "Everything awaiting your decision, from every source, with counts and links",
    "admin.desc./admin/verification": "Branch and warehouse evidence awaiting a decision",
    "admin.desc./admin/analytics": "Orders, sales, refunds, stores, products, customers and POS, with exports",
    "admin.desc./admin/vendors": "The store list: suspend and reactivate stores",
    "admin.desc./admin/offers": "Hide an offer or request changes, and review a store's correction",
    "admin.desc./admin/orders": "Online store orders with their details, amounts, refunds and returns",
    "admin.desc./admin/media": "Platform images and videos for the homepage, trending, ads and collections",
    "admin.desc./admin/content": "Homepage, trending and ads content: draft, preview, publish, schedule and past versions",
    "admin.desc./admin/users": "Accounts: suspend, lift a suspension, sign out of every device",
    "admin.desc./admin/settings": "Platform team, feature flags, alert recipients and the audit log",
    "admin.desc./admin/name-change-requests": "Requests to rename canonical products",
    "admin.desc./admin/brands/requests": "Brands requested by store owners: approve or reject",
    "admin.desc./admin/categories": "The product category tree: create, restrict and delete",
    "admin.desc./admin/brands": "The brand list and adding brands",
    "admin.desc./admin/canonical-products": "Canonical product states and variants, merge and split",
    "admin.desc./admin/branch-orders": "Force-cancel or manually refund a single branch order",
    "admin.desc./admin/returns": "Returns the customer disputed or the store let expire, awaiting your decision",
    "admin.desc./admin/reviews": "Reviews with an open report: dismiss it or hide the review",
    "admin.desc./admin/audit-logs": "Search and export the log of every tracked operation",
    "admin.desc./admin/feature-flags": "Turn approved features on or off",
    "admin.desc./admin/vendors/performance": "Cancellation rate, response time and rating per store",
    "admin.desc./admin/size-guides": "Create, publish and link size guides to categories, and store requests",
    "admin.desc./admin/collections": "Editorial product collections: publish, archive and order",
    "admin.desc./admin/alert-recipients": "Who receives order-safety and return-escalation alerts",
  },
});
