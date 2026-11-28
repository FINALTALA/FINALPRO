import { adminErrorMessage } from "./admin";
import { ApiError } from "./api";
import { registerTranslations, translate, type Lang } from "./i18n";

registerTranslations({
  ar: {
    "adminDirectory.vendors.forbidden": "هذه الصفحة لمدير المنصة فقط",
    "adminDirectory.vendors.title": "المتاجر",
    "adminDirectory.vendors.statusFilter": "تصفية حسب الحالة",
    "adminDirectory.vendors.allStatuses": "كل الحالات",
    "adminDirectory.vendors.searchLabel": "بحث باسم المتجر",
    "adminDirectory.vendors.searchPlaceholder": "ابحثي باسم المتجر (حرفان على الأقل)",
    "adminDirectory.vendors.search": "بحث",
    "adminDirectory.vendors.empty": "لا توجد متاجر مطابقة",
    "adminDirectory.vendors.emptyHint": "غيّري الحالة أو نص البحث.",
    "adminDirectory.vendors.type": "النوع",
    "adminDirectory.vendors.created": "تاريخ الإنشاء",
    "adminDirectory.vendors.membership": "أنتِ عضوة",
    "adminDirectory.vendors.details": "التفاصيل",
    "adminDirectory.verification.forbidden": "هذه الصفحة لموظفي المنصة فقط",
    "adminDirectory.verification.title": "طابور التحقق",
    "adminDirectory.verification.pending": "بانتظار القرار",
    "adminDirectory.verification.decided": "تم البتّ فيها",
    "adminDirectory.verification.pendingEmpty": "لا توجد أدلة بانتظار القرار",
    "adminDirectory.verification.decidedEmpty": "لم يُبتّ في أي دليل بعد",
    "adminDirectory.verification.pendingHint": "ستظهر هنا الأدلة فور تقديمها من أصحاب المتاجر.",
    "adminDirectory.verification.kind": "النوع",
    "adminDirectory.verification.storeType": "نوع المتجر",
    "adminDirectory.verification.submitted": "تاريخ التقديم",
    "adminDirectory.verification.reviewed": "تاريخ القرار",
    "adminDirectory.verification.review": "مراجعة",
    "adminDirectory.shared.dashboard": "إدارة المنصة",
    "adminDirectory.shared.account": "حسابي",
    "adminDirectory.shared.loading": "جارٍ التحميل",
    "adminDirectory.shared.loadingMore": "جارٍ التحميل...",
    "adminDirectory.shared.loadMore": "تحميل المزيد",
    "adminDirectory.shared.store": "المتجر",
    "adminDirectory.shared.status": "الحالة",
    "adminDirectory.error": "تعذّر الاتصال بالخادم",
    "adminDirectory.invalidSearch": "أدخلي حرفين على الأقل للبحث.",
  },
  en: {
    "adminDirectory.vendors.forbidden": "This page is only available to platform administrators.",
    "adminDirectory.vendors.title": "Stores",
    "adminDirectory.vendors.statusFilter": "Filter by status",
    "adminDirectory.vendors.allStatuses": "All statuses",
    "adminDirectory.vendors.searchLabel": "Search by store name",
    "adminDirectory.vendors.searchPlaceholder": "Search by store name (at least two characters)",
    "adminDirectory.vendors.search": "Search",
    "adminDirectory.vendors.empty": "No matching stores",
    "adminDirectory.vendors.emptyHint": "Change the status filter or search term.",
    "adminDirectory.vendors.type": "Type",
    "adminDirectory.vendors.created": "Created at",
    "adminDirectory.vendors.membership": "Member",
    "adminDirectory.vendors.details": "Details",
    "adminDirectory.verification.forbidden": "This page is only available to platform staff.",
    "adminDirectory.verification.title": "Verification queue",
    "adminDirectory.verification.pending": "Awaiting decision",
    "adminDirectory.verification.decided": "Decided",
    "adminDirectory.verification.pendingEmpty": "No evidence awaiting a decision",
    "adminDirectory.verification.decidedEmpty": "No evidence has been reviewed yet",
    "adminDirectory.verification.pendingHint": "Evidence appears here when store owners submit it.",
    "adminDirectory.verification.kind": "Evidence type",
    "adminDirectory.verification.storeType": "Store type",
    "adminDirectory.verification.submitted": "Submitted at",
    "adminDirectory.verification.reviewed": "Decision date",
    "adminDirectory.verification.review": "Review",
    "adminDirectory.shared.dashboard": "Platform management",
    "adminDirectory.shared.account": "My account",
    "adminDirectory.shared.loading": "Loading",
    "adminDirectory.shared.loadingMore": "Loading…",
    "adminDirectory.shared.loadMore": "Load more",
    "adminDirectory.shared.store": "Store",
    "adminDirectory.shared.status": "Status",
    "adminDirectory.error": "Could not load the data. Try again.",
    "adminDirectory.invalidSearch": "Enter at least two characters to search.",
  },
});

const EN_LABELS: Record<"storeType" | "storeStatus" | "evidenceKind" | "verificationStatus", Record<string, string>> = {
  storeType: {
    PHYSICAL: "Physical",
    ONLINE_ONLY: "Online only",
    HYBRID: "Hybrid",
  },
  storeStatus: {
    APPLIED: "Applied",
    UNDER_REVIEW: "Under review",
    APPROVED: "Approved",
    REJECTED: "Rejected",
    ACTIVE: "Active",
    SUSPENDED: "Suspended",
    CANCELLED: "Cancelled",
  },
  evidenceKind: {
    BRANCH: "Branch evidence",
    WAREHOUSE: "Warehouse evidence",
  },
  verificationStatus: {
    PENDING: "Pending review",
    APPROVED: "Approved",
    REJECTED: "Rejected",
    RESUBMISSION_REQUESTED: "Resubmission requested",
  },
};

export function adminDirectoryLabel(
  lang: Lang,
  category: keyof typeof EN_LABELS,
  arabicLabels: Record<string, string>,
  value: string,
): string {
  const labels = lang === "en" ? EN_LABELS[category] : arabicLabels;
  return labels[value] ?? value;
}

export function adminDirectoryError(lang: Lang, error: unknown): string {
  if (error instanceof ApiError && error.code === "INVALID_SEARCH") {
    return translate(lang, "adminDirectory.invalidSearch");
  }
  return lang === "ar" ? adminErrorMessage(error) : translate(lang, "adminDirectory.error");
}
