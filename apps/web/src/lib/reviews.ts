import { ApiError } from "./api";

// Sprint 23 (EPIC-REV): mirrors the established lib/returns.ts
// convention (plain lookup tables, pure functions, no browser APIs so
// they stay unit-testable without a DOM).

export const REVIEW_TARGET_LABEL: Record<string, string> = {
  PRODUCT: "المنتج",
  STORE: "المتجر",
};

const ERROR_MESSAGES: Record<string, string> = {
  BRANCH_ORDER_ITEM_NOT_FOUND: "لم يُعثر على هذا المنتج ضمن طلباتك.",
  ITEM_CANCELLED_NOT_REVIEWABLE: "هذا المنتج أُلغي قبل التوصيل، ولا يمكن مراجعته.",
  NOT_ELIGIBLE_FOR_REVIEW: "لا يمكن مراجعة هذا الطلب قبل اكتماله فعلياً (توصيل أو استلام).",
  PRODUCT_NOT_ELIGIBLE_FOR_REVIEW:
    "هذا المنتج غير مرتبط بمنتج أساسي على المنصة، فلا يمكن مراجعته - يمكنكِ مراجعة المتجر بدلاً من ذلك.",
  REVIEW_ALREADY_SUBMITTED: "سبق أن قدّمتِ مراجعة من هذا النوع لهذا الطلب.",
  REVIEW_NOT_FOUND: "لم يُعثر على هذه المراجعة.",
  REVIEW_ALREADY_HIDDEN: "هذه المراجعة مخفية بالفعل.",
  REVIEW_ALREADY_REPORTED: "سبق أن بلّغتِ عن هذه المراجعة.",
  NO_PENDING_REPORTS: "لا يوجد بلاغ معلَّق على هذه المراجعة ليُحسَم.",
  CANONICAL_PRODUCT_NOT_FOUND: "لم يُعثر على هذا المنتج.",
  VENDOR_NOT_FOUND: "لم يُعثر على هذا المتجر.",
  STOREFRONT_NOT_FOUND: "لم يُعثر على متجر بهذا الرابط.",
};

/** Turns an API failure into the Arabic message shown to the user. */
export function reviewErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    return ERROR_MESSAGES[err.code] ?? err.message;
  }
  return "تعذّر الاتصال بالخادم";
}
