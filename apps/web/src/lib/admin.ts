import { ApiError } from "./api";

// Sprint 16: labels and small helpers shared by the /admin pages and the
// owner's verification page. Pure functions - no browser APIs - so they
// can be unit-tested without a DOM.

export const VERIFICATION_STATUS_LABEL: Record<string, string> = {
  PENDING: "قيد المراجعة",
  APPROVED: "معتمد",
  REJECTED: "مرفوض",
  RESUBMISSION_REQUESTED: "مطلوب إعادة إرسال",
};

export const VENDOR_STATUS_LABEL: Record<string, string> = {
  APPLIED: "مقدَّم",
  UNDER_REVIEW: "قيد المراجعة",
  APPROVED: "معتمد",
  REJECTED: "مرفوض",
  ACTIVE: "نشط",
  SUSPENDED: "معلَّق",
  CANCELLED: "ملغى",
};

export const STORE_TYPE_LABEL: Record<string, string> = {
  PHYSICAL: "فعلي",
  ONLINE_ONLY: "إلكتروني فقط",
  HYBRID: "مختلط",
};

export const SUSPENSION_REASON_LABEL: Record<string, string> = {
  POLICY_VIOLATION: "مخالفة السياسة",
  NON_PAYMENT: "عدم السداد",
  OTHER: "سبب آخر",
};

export const KIND_LABEL: Record<string, string> = {
  BRANCH: "دليل فرع",
  WAREHOUSE: "دليل مستودع",
};

// Sprint 17b: the platform catalog admin pages (categories/brands/
// canonical products).
export const CANONICAL_PRODUCT_STATUS_LABEL: Record<string, string> = {
  DRAFT: "مسودة",
  PENDING_REVIEW: "قيد المراجعة",
  PUBLISHED: "منشور",
  ARCHIVED: "مؤرشف",
  MERGED: "مدمج",
};

export const PRODUCT_TYPE_LABEL: Record<string, string> = {
  PHYSICAL: "فعلي",
  BUNDLE: "مجموعة",
  SERVICE: "خدمة",
};

export function formatDateTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("ar", { dateStyle: "medium", timeStyle: "short" });
}

/** The 10-1000 character rule the API applies after trimming. */
export function reasonProblem(raw: string): string | null {
  const len = raw.trim().length;
  if (len < 10) return "اكتبي سبباً من 10 أحرف على الأقل";
  if (len > 1000) return "السبب طويل جداً (الحد 1000 حرف)";
  return null;
}

const ERROR_MESSAGES: Record<string, string> = {
  BRANCH_EVIDENCE_STALE:
    "تغيّر الدليل بعد أن قرأتِه. أعيدي تحميل الصفحة وقرّري على النسخة الحالية.",
  WAREHOUSE_EVIDENCE_STALE:
    "لم يعد هذا الدليل هو الدليل المعلّق الحالي. أعيدي التحميل.",
  NO_PENDING_BRANCH_EVIDENCE: "لا يوجد دليل معلّق لهذا الفرع الآن.",
  NO_PENDING_WAREHOUSE_EVIDENCE: "لا يوجد دليل معلّق لهذا المستودع الآن.",
  PLATFORM_VENDOR_CONFLICT_OF_INTEREST:
    "أنتِ عضوة في هذا المتجر، لذلك لا يمكنك اتخاذ قرار بشأنه.",
  VENDOR_NOT_UNDER_REVIEW: "هذا المتجر لم يعد قيد المراجعة.",
  BRANCH_NOT_PENDING: "تم البتّ في هذا الفرع بالفعل.",
  VENDOR_ALREADY_SUSPENDED: "هذا المتجر معلَّق بالفعل.",
  VENDOR_NOT_ACTIVE: "لا يمكن تعليق إلا متجر نشط.",
  VENDOR_NOT_SUSPENDED: "هذا المتجر ليس معلَّقاً.",
  FORBIDDEN: "لا تملكين صلاحية لهذا الإجراء.",
  // Sprint 17b: catalog admin (categories/brands/canonical products).
  CATEGORY_NOT_FOUND: "التصنيف غير موجود.",
  PARENT_CATEGORY_NOT_FOUND: "التصنيف الأب غير موجود.",
  CATEGORY_CYCLE: "لا يمكن اختيار هذا التصنيف الأب (يسبب حلقة في شجرة التصنيفات).",
  CATEGORY_IN_USE: "لا يمكن حذف هذا التصنيف لوجود منتجات مرجعية تابعة له.",
  BRAND_NOT_FOUND: "العلامة التجارية غير موجودة.",
  BRAND_ALREADY_EXISTS: "توجد علامة تجارية بهذا الاسم.",
  BRAND_SENTINEL_IMMUTABLE: "لا يمكن حذف هذه العلامة التجارية (سجلّ أساسي في النظام).",
  BRAND_IN_USE: "لا يمكن حذف هذه العلامة التجارية لوجود منتجات مرتبطة بها.",
  CANONICAL_PRODUCT_NOT_FOUND: "المنتج المرجعي غير موجود.",
  CATEGORY_RESTRICTED: "هذا التصنيف مقيَّد، ولا يمكن إنشاء منتج مرجعي تحته.",
  VARIANT_IDENTIFIER_ALREADY_EXISTS: "يوجد متغيّر آخر بنفس المعرّف (MPN/GTIN).",
  INVALID_STATUS_TRANSITION: "لا يمكن الانتقال إلى هذه الحالة من حالة المنتج الحالية.",
  MERGE_VARIANT_UNMATCHED: "تعذّر الدمج: بعض متغيّرات هذا المنتج لا تقابلها متغيّرات في المنتج الناجي.",
  SPLIT_WOULD_SPAN_VENDOR_OFFER: "تعذّر التقسيم: أحد عروض المتاجر مرتبط بمتغيّرات ستُقسَّم بين منتجين مختلفين.",
  SPLIT_REQUIRES_AT_LEAST_ONE_VARIANT: "اختاري متغيّراً واحداً على الأقل للتقسيم.",
  SPLIT_CANNOT_MOVE_ALL_VARIANTS: "لا يمكن نقل كل المتغيّرات؛ يجب أن يبقى للمنتج الأصلي متغيّر واحد على الأقل.",
  // Sprint 20a: platform-admin branch-order overrides.
  BRANCH_ORDER_NOT_FOUND: "لم يُعثر على طلب بهذا المعرّف.",
  BRANCH_ORDER_ALREADY_TERMINAL: "هذا الطلب وصل بالفعل إلى حالة نهائية.",
  REFUND_NOT_APPLICABLE_FOR_COD: "الطلب دفع عند الاستلام - لا يوجد مبلغ إلكتروني لاسترداده.",
  NOTHING_LEFT_TO_REFUND: "تم استرداد كامل مبلغ هذا الطلب مسبقاً.",
};

/** Turns an API failure into the Arabic message shown to the user. */
export function adminErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    return ERROR_MESSAGES[err.code] ?? err.message;
  }
  return "تعذّر الاتصال بالخادم";
}

/** True for the API failures that mean "you may not use this page". */
export function isForbidden(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 403 &&
    err.code !== "PLATFORM_VENDOR_CONFLICT_OF_INTEREST"
  );
}
