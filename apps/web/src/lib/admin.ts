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
