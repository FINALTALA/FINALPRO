import { apiErrorMessage } from "./apiErrors";
import { type Lang, registerTranslations, translate } from "./i18n";

// Sprint 21 (EPIC-RET): labels and words shared by every returns page
// (customer / owner / staff / admin). TB-16.2: all of it in Arabic and
// English through the shared translation table (the Arabic is unchanged).
// Free text written by a customer, a store or the platform (notes,
// rejection reasons), product titles and branch names are never
// translated here - pages show them as written.

registerTranslations({
  ar: {
    // Statuses
    "ret.status.REQUESTED": "قيد مراجعة المتجر",
    "ret.status.APPROVED_AWAITING_DROPOFF": "معتمد - بانتظار تسليم المنتج",
    "ret.status.RECEIVED": "تم استلام المنتج",
    "ret.status.REFUND_PROCESSING": "جارٍ معالجة الاسترداد",
    "ret.status.REFUNDED": "تم الاسترداد",
    "ret.status.REJECTED": "مرفوض من المتجر",
    "ret.status.REJECTED_CLOSED": "مرفوض (أُغلق باب الاعتراض)",
    "ret.status.ESCALATED": "معلَّق - قيد مراجعة إدارة المنصة",
    "ret.status.ADMIN_REJECTED": "مرفوض نهائياً من إدارة المنصة",
    "ret.status.EXPIRED": "انتهت صلاحية الكود",
    "ret.status.CANCELLED_BY_CUSTOMER": "ألغاه العميل",
    "ret.status.EXCHANGED": "تم التبديل",
    // Reasons and item condition
    "ret.reason.DAMAGED": "تالف",
    "ret.reason.WRONG_ITEM": "منتج خاطئ",
    "ret.reason.COUNTERFEIT_CLAIM": "ادّعاء تقليد",
    "ret.reason.WARRANTY_CLAIM": "مطالبة ضمان",
    "ret.reason.CHANGE_OF_MIND": "تغيير رأي",
    "ret.condition.RESELLABLE": "قابل لإعادة البيع",
    "ret.condition.DAMAGED": "تالف",
    // Shared
    "ret.my_returns": "إرجاعاتي",
    "ret.my_orders": "طلباتي",
    "ret.my_account": "حسابي",
    "ret.store_dashboard": "لوحة المتجر",
    "ret.loading": "جارٍ التحميل",
    "ret.exchange_tag": "(تبديل)",
    "ret.exchange_request_tag": "(طلب تبديل)",
    "ret.code.RETURN": "كود الإرجاع",
    "ret.code.EXCHANGE": "كود التبديل",
    "ret.submitted_at": "قُدِّم في {date}",
    "ret.photos": "{n} صورة مرفقة",
    "ret.back": "تراجع",
    "ret.no_difference": "لا فرق مستحق.",
    "ret.reject_too_short": "سبب الرفض يجب أن يكون 10 أحرف على الأقل",
    // Orders page entry points
    "ret.entry.request": "طلب إرجاع",
    "ret.entry.open_my_returns": "فتح إرجاعاتي",
    // My returns
    "ret.list.empty_title": "لا توجد طلبات إرجاع",
    "ret.list.empty_message": "يمكنك طلب إرجاع منتج من صفحة طلباتي بعد استلامه.",
    // A return (customer)
    "ret.detail.title": "طلب إرجاع",
    "ret.detail.not_found": "لم يُعثر على طلب الإرجاع",
    "ret.detail.load_failed": "تعذّر تحميل طلب الإرجاع",
    "ret.detail.your_note": "ملاحظتك:",
    "ret.detail.code_hint.EXCHANGE":
      "- احضري بالمنتج القديم إلى الفرع المحدَّد لاستلام البديل. صالح حتى {date} (24 ساعة من الاعتماد).",
    "ret.detail.code_hint.RETURN": "- سلّمي المنتج لأي فرع من فروع المتجر وأعطيه هذا الكود. صالح حتى {date}.",
    "ret.detail.rejection_reason": "سبب الرفض:",
    "ret.detail.dispute_until": "يمكنك الاعتراض حتى {date}.",
    "ret.detail.admin_rejected": "قررت إدارة المنصة رفض هذا الطلب نهائياً:",
    "ret.detail.escalated": "اعترضتِ على رفض المتجر، وطلب الإرجاع الآن بانتظار قرار إدارة المنصة.",
    "ret.detail.received": "تم استلام المنتج في {date}، وجارٍ معالجة الاسترداد.",
    "ret.detail.refunded": "تم استرداد المبلغ.",
    "ret.detail.exchanged": "تم التبديل بنجاح في {date}.",
    "ret.detail.paid": "دفعتِ {amount} نقداً في الفرع.",
    "ret.detail.refunded_cash": "استُردّ لك {amount} نقداً في الفرع.",
    "ret.detail.expired.EXCHANGE":
      "لم يُسلَّم المنتج خلال 24 ساعة من اعتماد الطلب، فانتهت صلاحية الكود وتحرَّر حجز البديل.",
    "ret.detail.expired.RETURN": "لم يُسلَّم المنتج خلال 7 أيام من اعتماد الطلب، فانتهت صلاحية الكود.",
    "ret.detail.cancel": "إلغاء طلب الإرجاع",
    "ret.detail.dispute": "الاعتراض على الرفض",
    // Request a return / exchange
    "ret.request.title": "طلب إرجاع أو تبديل",
    "ret.request.what": "المطلوب",
    "ret.request.outcome.RETURN": "استرداد المبلغ",
    "ret.request.outcome.EXCHANGE": "تبديل بمقاس/لون آخر",
    "ret.request.reason": "السبب",
    "ret.request.replacement": "البديل",
    "ret.request.loading_options": "جارٍ تحميل الخيارات...",
    "ret.request.no_options": "لا تتوفر بدائل أخرى لهذا المنتج حالياً.",
    "ret.request.option_fallback": "بديل",
    "ret.request.note": "ملاحظة (اختياري)",
    "ret.request.photos": "روابط صور (اختياري، مفصولة بفاصلة)",
    "ret.request.choose_replacement": "يرجى اختيار البديل والفرع",
    "ret.request.sending": "جارٍ الإرسال...",
    "ret.request.send.RETURN": "إرسال طلب الإرجاع",
    "ret.request.send.EXCHANGE": "إرسال طلب التبديل",
    "ret.request.sent.RETURN": "تم إرسال طلب الإرجاع. سيراجعه المتجر خلال 48 ساعة.",
    "ret.request.sent.EXCHANGE": "تم إرسال طلب التبديل. سيراجعه المتجر خلال 48 ساعة.",
    "ret.request.track.RETURN": "تتبّع طلب الإرجاع",
    "ret.request.track.EXCHANGE": "تتبّع طلب التبديل",
    // Branch returns
    "ret.branch.title": "طلبات الإرجاع",
    "ret.branch.workspace": "مساحة الفرع",
    "ret.branch.orders": "طلبات الفرع",
    "ret.branch.stock": "المخزون",
    "ret.branch.notifications": "التنبيهات",
    "ret.branch.empty": "لا توجد طلبات إرجاع لهذا الفرع",
    "ret.branch.approve": "اعتماد",
    "ret.branch.reject": "رفض",
    "ret.branch.reject_placeholder": "سبب الرفض (10 أحرف على الأقل)",
    "ret.branch.confirm_reject": "تأكيد الرفض",
    // Redeem
    "ret.redeem.title": "استبدال كود إرجاع",
    "ret.redeem.hint": "يمكن استلام إرجاع في أي فرع من فروع متجركم، بغض النظر عن الفرع الذي اعتمد الطلب أصلاً.",
    "ret.redeem.code_label": "كود الإرجاع (6 أرقام)",
    "ret.redeem.code_invalid": "الكود مكوَّن من 6 أرقام",
    "ret.redeem.branch_label": "الفرع المستلِم",
    "ret.redeem.branch_required": "اختاري الفرع المستلِم",
    "ret.redeem.condition_label": "حالة المنتج",
    "ret.redeem.submit": "استبدال",
    "ret.redeem.submitting": "جارٍ الاستبدال...",
    "ret.redeem.done.EXCHANGE": "تم تسليم البديل بنجاح.",
    "ret.redeem.done.RETURN": "تم استلام المنتج بنجاح.",
    "ret.redeem.summary": "الحالة: {status}، وقت الاستلام: {date}.",
    "ret.redeem.collect": "يُحصَّل من العميل {amount} نقداً.",
    "ret.redeem.refund": "يُردّ للعميل {amount} نقداً.",
    // Admin escalations
    "ret.admin.title": "الإرجاعات المتصاعدة",
    "ret.admin.dashboard": "لوحة الإدارة",
    "ret.admin.forbidden": "هذه الصفحة لمدير المنصة فقط",
    "ret.admin.empty": "لا توجد إرجاعات معلَّقة لمراجعتك حالياً",
    "ret.admin.escalated_at": "تصاعد في {date}",
    "ret.admin.customer_note": "ملاحظة العميل:",
    "ret.admin.store_reason": "سبب رفض المتجر:",
    "ret.admin.approve.RETURN": "اعتماد الإرجاع",
    "ret.admin.approve.EXCHANGE": "اعتماد التبديل",
    "ret.admin.final_reject": "رفض نهائي",
    "ret.admin.final_placeholder": "سبب الرفض النهائي (10 أحرف على الأقل)",
    "ret.admin.confirm_final": "تأكيد الرفض النهائي",
    // Return policy
    "ret.policy.title": "سياسة الإرجاع والتبديل",
    "ret.policy.hint":
      "يمكن تعديل السياسة مرة واحدة كل ستة أشهر فقط. سياسة الطلب تُثبَّت وقت الشراء، فأي تعديل هنا لا يغيّر حقوق طلب سابق. التبديل يتم داخل فروعكم الفعلية فقط.",
    "ret.policy.label": "السياسة",
    "ret.policy.mode.NO_RETURN": "لا يوجد إرجاع ولا تبديل",
    "ret.policy.mode.REFUND_ONLY": "إرجاع مقابل استرداد المبلغ فقط",
    "ret.policy.mode.EXCHANGE_ONLY": "تبديل فقط",
    "ret.policy.mode.BOTH": "إرجاع أو تبديل (العميل يختار)",
    "ret.policy.window": "مهلة الإرجاع/التبديل (أيام)",
    "ret.policy.fee": "رسوم الإرجاع (₪)",
    "ret.policy.exchange_fee": "رسوم التبديل (₪) - تُطبَّق دائماً، رداً أو تحصيلاً",
    "ret.policy.need_window": "حدّدي عدد أيام مهلة الإرجاع/التبديل",
    "ret.policy.need_fee": "حدّدي رسوم الإرجاع",
    "ret.policy.need_exchange_fee": "حدّدي رسوم التبديل",
    "ret.policy.saved": "تم الحفظ",
    "ret.policy.last_changed": "آخر تعديل: {date}",
  },
  en: {
    "ret.status.REQUESTED": "Awaiting the store's review",
    "ret.status.APPROVED_AWAITING_DROPOFF": "Approved - awaiting drop-off",
    "ret.status.RECEIVED": "Item received",
    "ret.status.REFUND_PROCESSING": "Refund in progress",
    "ret.status.REFUNDED": "Refunded",
    "ret.status.REJECTED": "Rejected by the store",
    "ret.status.REJECTED_CLOSED": "Rejected (dispute window closed)",
    "ret.status.ESCALATED": "On hold - under platform review",
    "ret.status.ADMIN_REJECTED": "Finally rejected by the platform",
    "ret.status.EXPIRED": "Code expired",
    "ret.status.CANCELLED_BY_CUSTOMER": "Cancelled by the customer",
    "ret.status.EXCHANGED": "Exchanged",
    "ret.reason.DAMAGED": "Damaged",
    "ret.reason.WRONG_ITEM": "Wrong item",
    "ret.reason.COUNTERFEIT_CLAIM": "Counterfeit claim",
    "ret.reason.WARRANTY_CLAIM": "Warranty claim",
    "ret.reason.CHANGE_OF_MIND": "Change of mind",
    "ret.condition.RESELLABLE": "Resellable",
    "ret.condition.DAMAGED": "Damaged",
    "ret.my_returns": "My returns",
    "ret.my_orders": "My orders",
    "ret.my_account": "My account",
    "ret.store_dashboard": "Store dashboard",
    "ret.loading": "Loading",
    "ret.exchange_tag": "(exchange)",
    "ret.exchange_request_tag": "(exchange request)",
    "ret.code.RETURN": "Return code",
    "ret.code.EXCHANGE": "Exchange code",
    "ret.submitted_at": "Submitted {date}",
    "ret.photos": "{n} photo(s) attached",
    "ret.back": "Back",
    "ret.no_difference": "No difference due.",
    "ret.reject_too_short": "The reason must be at least 10 characters",
    "ret.entry.request": "Request a return",
    "ret.entry.open_my_returns": "Open my returns",
    "ret.list.empty_title": "No return requests",
    "ret.list.empty_message": "You can request a return from My orders once you've received the item.",
    "ret.detail.title": "Return request",
    "ret.detail.not_found": "Return request not found",
    "ret.detail.load_failed": "Couldn't load the return request",
    "ret.detail.your_note": "Your note:",
    "ret.detail.code_hint.EXCHANGE":
      "- bring the original item to the assigned branch to collect the replacement. Valid until {date} (24 hours after approval).",
    "ret.detail.code_hint.RETURN": "- hand the item to any of the store's branches with this code. Valid until {date}.",
    "ret.detail.rejection_reason": "Rejection reason:",
    "ret.detail.dispute_until": "You can dispute until {date}.",
    "ret.detail.admin_rejected": "The platform made a final decision to reject this request:",
    "ret.detail.escalated": "You disputed the store's rejection; the request now awaits the platform's decision.",
    "ret.detail.received": "Item received {date}; the refund is in progress.",
    "ret.detail.refunded": "Refunded.",
    "ret.detail.exchanged": "Exchanged on {date}.",
    "ret.detail.paid": "You paid {amount} in cash at the branch.",
    "ret.detail.refunded_cash": "You were refunded {amount} in cash at the branch.",
    "ret.detail.expired.EXCHANGE":
      "The item wasn't dropped off within 24 hours of approval, so the code expired and the replacement hold was released.",
    "ret.detail.expired.RETURN": "The item wasn't dropped off within 7 days of approval, so the code expired.",
    "ret.detail.cancel": "Cancel return request",
    "ret.detail.dispute": "Dispute the rejection",
    "ret.request.title": "Return or exchange request",
    "ret.request.what": "What would you like?",
    "ret.request.outcome.RETURN": "Refund",
    "ret.request.outcome.EXCHANGE": "Exchange for another size/colour",
    "ret.request.reason": "Reason",
    "ret.request.replacement": "Replacement",
    "ret.request.loading_options": "Loading options...",
    "ret.request.no_options": "No other options are available for this item right now.",
    "ret.request.option_fallback": "Option",
    "ret.request.note": "Note (optional)",
    "ret.request.photos": "Photo links (optional, comma-separated)",
    "ret.request.choose_replacement": "Please choose the replacement and the branch",
    "ret.request.sending": "Sending...",
    "ret.request.send.RETURN": "Send return request",
    "ret.request.send.EXCHANGE": "Send exchange request",
    "ret.request.sent.RETURN": "Your return request was sent. The store will review it within 48 hours.",
    "ret.request.sent.EXCHANGE": "Your exchange request was sent. The store will review it within 48 hours.",
    "ret.request.track.RETURN": "Track your return",
    "ret.request.track.EXCHANGE": "Track your exchange",
    "ret.branch.title": "Return requests",
    "ret.branch.workspace": "Branch workspace",
    "ret.branch.orders": "Branch orders",
    "ret.branch.stock": "Stock",
    "ret.branch.notifications": "Notifications",
    "ret.branch.empty": "No return requests for this branch",
    "ret.branch.approve": "Approve",
    "ret.branch.reject": "Reject",
    "ret.branch.reject_placeholder": "Rejection reason (at least 10 characters)",
    "ret.branch.confirm_reject": "Confirm rejection",
    "ret.redeem.title": "Redeem a return code",
    "ret.redeem.hint": "A return can be received at any of your branches, whichever branch approved it.",
    "ret.redeem.code_label": "Return code (6 digits)",
    "ret.redeem.code_invalid": "The code has 6 digits",
    "ret.redeem.branch_label": "Receiving branch",
    "ret.redeem.branch_required": "Choose the receiving branch",
    "ret.redeem.condition_label": "Item condition",
    "ret.redeem.submit": "Redeem",
    "ret.redeem.submitting": "Redeeming...",
    "ret.redeem.done.EXCHANGE": "Replacement handed over.",
    "ret.redeem.done.RETURN": "Item received.",
    "ret.redeem.summary": "Status: {status}. Received: {date}.",
    "ret.redeem.collect": "Collect {amount} in cash from the customer.",
    "ret.redeem.refund": "Refund {amount} in cash to the customer.",
    "ret.admin.title": "Escalated returns",
    "ret.admin.dashboard": "Admin dashboard",
    "ret.admin.forbidden": "This page is for platform administrators only",
    "ret.admin.empty": "No returns are awaiting your review",
    "ret.admin.escalated_at": "Escalated {date}",
    "ret.admin.customer_note": "Customer note:",
    "ret.admin.store_reason": "Store's rejection reason:",
    "ret.admin.approve.RETURN": "Approve return",
    "ret.admin.approve.EXCHANGE": "Approve exchange",
    "ret.admin.final_reject": "Final rejection",
    "ret.admin.final_placeholder": "Final rejection reason (at least 10 characters)",
    "ret.admin.confirm_final": "Confirm final rejection",
    "ret.policy.title": "Return and exchange policy",
    "ret.policy.hint":
      "The policy can be changed once every six months. An order keeps the policy in force when it was placed, so changes here don't affect earlier orders. Exchanges happen in your physical branches only.",
    "ret.policy.label": "Policy",
    "ret.policy.mode.NO_RETURN": "No returns or exchanges",
    "ret.policy.mode.REFUND_ONLY": "Returns for a refund only",
    "ret.policy.mode.EXCHANGE_ONLY": "Exchanges only",
    "ret.policy.mode.BOTH": "Returns or exchanges (the customer chooses)",
    "ret.policy.window": "Return/exchange period (days)",
    "ret.policy.fee": "Return fee (₪)",
    "ret.policy.exchange_fee": "Exchange fee (₪) - always applied, as a refund or a charge",
    "ret.policy.need_window": "Set the return/exchange period in days",
    "ret.policy.need_fee": "Set the return fee",
    "ret.policy.need_exchange_fee": "Set the exchange fee",
    "ret.policy.saved": "Saved",
    "ret.policy.last_changed": "Last changed: {date}",
  },
});

export const RETURN_REASONS = ["DAMAGED", "WRONG_ITEM", "COUNTERFEIT_CLAIM", "WARRANTY_CLAIM", "CHANGE_OF_MIND"] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];
export const ITEM_CONDITIONS = ["RESELLABLE", "DAMAGED"] as const;

/** A coded value's words; an unknown code is shown as itself. */
function coded(prefix: string, value: string, lang: Lang): string {
  const key = `${prefix}.${value}`;
  const words = translate(lang, key);
  return words === key ? value : words;
}
export const returnStatusLabel = (status: string, lang: Lang) => coded("ret.status", status, lang);
export const returnReasonLabel = (reason: string, lang: Lang) => coded("ret.reason", reason, lang);
export const itemConditionLabel = (condition: string, lang: Lang) => coded("ret.condition", condition, lang);

/** Fills `{name}` placeholders. */
export function fmt(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (all, name: string) => (name in values ? String(values[name]) : all));
}

/** A date and time in the interface language. */
export function formatDateTime(iso: string | null, lang: Lang = "ar"): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString(lang === "en" ? "en" : "ar", { dateStyle: "medium", timeStyle: "short" });
}

/** A shekel amount: "{n} ₪" in Arabic, "₪{n}" in English. */
export function formatMoney(amount: number | string, lang: Lang): string {
  return lang === "en" ? `₪${amount}` : `${amount} ₪`;
}

/** TB-16.2: what a page keeps for an error - the failure itself or the key
 * of its own check's words, never words already chosen - so the text
 * follows a language switch at once. */
export type UiError = { api: unknown } | { key: string };
export function uiErrorText(error: UiError, lang: Lang): string {
  return "api" in error ? apiErrorMessage(error.api, lang) : translate(lang, error.key);
}

/** TB-16.1: kept for its callers - the words now come from lib/apiErrors
 * (the error's own code first, then its HTTP status; never the API's
 * own message). */
export function returnErrorMessage(err: unknown, lang: Lang = "ar"): string {
  return apiErrorMessage(err, lang);
}
