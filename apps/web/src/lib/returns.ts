import { ApiError } from "./api";

// Sprint 21 (EPIC-RET): labels and error-message mapping shared by every
// returns page (customer/owner/staff/admin) - mirrors the established
// lib/admin.ts convention (plain lookup tables, pure functions, no
// browser APIs so they stay unit-testable without a DOM).

export const RETURN_STATUS_LABEL: Record<string, string> = {
  REQUESTED: "قيد مراجعة المتجر",
  APPROVED_AWAITING_DROPOFF: "معتمد - بانتظار تسليم المنتج",
  RECEIVED: "تم استلام المنتج",
  REFUND_PROCESSING: "جارٍ معالجة الاسترداد",
  REFUNDED: "تم الاسترداد",
  REJECTED: "مرفوض من المتجر",
  REJECTED_CLOSED: "مرفوض (أُغلق باب الاعتراض)",
  ESCALATED: "معلَّق - قيد مراجعة إدارة المنصة",
  ADMIN_REJECTED: "مرفوض نهائياً من إدارة المنصة",
  EXPIRED: "انتهت صلاحية كود الإرجاع",
  CANCELLED_BY_CUSTOMER: "ألغاه العميل",
};

export const RETURN_REASON_LABEL: Record<string, string> = {
  DAMAGED: "تالف",
  WRONG_ITEM: "منتج خاطئ",
  COUNTERFEIT_CLAIM: "ادّعاء تقليد",
  WARRANTY_CLAIM: "مطالبة ضمان",
  CHANGE_OF_MIND: "تغيير رأي",
};

export const RETURN_ITEM_CONDITION_LABEL: Record<string, string> = {
  RESELLABLE: "قابل لإعادة البيع",
  DAMAGED: "تالف",
};

const ELIGIBILITY_REASON_LABEL: Record<string, string> = {
  NO_POLICY_SNAPSHOT: "هذا الطلب أُنشئ قبل تفعيل سياسة الإرجاع، فلا يحق له إرجاع.",
  RETURNS_DISABLED: "هذا المتجر لا يقبل إرجاع المنتجات.",
  NOT_YET_ARRIVED: "لا يمكن طلب إرجاع قبل استلام المنتج فعلياً.",
  COD_NOT_COLLECTED: "لم يتم تحصيل المبلغ عند الاستلام لهذا الطلب بعد.",
  WINDOW_EXPIRED: "انتهت مهلة الإرجاع المسموحة لهذا المنتج.",
};

const ERROR_MESSAGES: Record<string, string> = {
  BRANCH_ORDER_ITEM_NOT_FOUND: "لم يُعثر على هذا المنتج ضمن طلباتك.",
  ITEM_CANCELLED_NOT_RETURNABLE: "هذا المنتج أُلغي قبل التوصيل، ولا يمكن إرجاعه.",
  RETURN_ALREADY_EXISTS: "يوجد طلب إرجاع سابق لهذا المنتج بالفعل.",
  RETURN_NOT_FOUND: "لم يُعثر على طلب الإرجاع.",
  RETURN_NOT_CANCELLABLE: "لا يمكن إلغاء طلب الإرجاع إلا وهو بانتظار قرار المتجر.",
  RETURN_NOT_DISPUTABLE: "لا يمكن الاعتراض إلا على طلب مرفوض من المتجر.",
  DISPUTE_WINDOW_EXPIRED: "انتهت مهلة الاعتراض على هذا الرفض (7 أيام).",
  RETURN_NOT_DECIDABLE: "تم البتّ في هذا الطلب بالفعل.",
  RETURN_NOT_ESCALATED: "هذا الطلب لم يعد معلَّقاً لمراجعة إدارة المنصة.",
  RETURN_POLICY_CHANGE_TOO_SOON:
    "يمكن تعديل سياسة الإرجاع مرة واحدة كل ستة أشهر فقط - لم تحن المدة بعد.",
  INVALID_RETURN_CODE: "هذا الكود غير صالح، أو مستخدم من قبل، أو منتهي.",
  RETURN_CODE_EXPIRED: "انتهت صلاحية هذا الكود (7 أيام من الاعتماد).",
  RECEIVING_BRANCH_NOT_IN_VENDOR: "الفرع المحدَّد لا يتبع متجركم.",
  FORBIDDEN: "لا تملك صلاحية لهذا الإجراء.",
};

/** Turns an API failure (including the eligibility 409's reason_code
 * detail) into the Arabic message shown to the user. */
export function returnErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "NOT_ELIGIBLE_FOR_RETURN") {
      const detail = err.details[0] as { reason_code?: string } | undefined;
      const reasonCode = detail?.reason_code;
      return (
        (reasonCode && ELIGIBILITY_REASON_LABEL[reasonCode]) ??
        "هذا المنتج غير مؤهل للإرجاع."
      );
    }
    return ERROR_MESSAGES[err.code] ?? err.message;
  }
  return "تعذّر الاتصال بالخادم";
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("ar", { dateStyle: "medium", timeStyle: "short" });
}
