import { ApiError } from "./api";
import { registerTranslations } from "./i18n";

// TB-12.3: the PLATFORM_ADMIN's "platform alert recipients" page - who
// receives each category of platform alert. The API
// (GET/PUT/DELETE /admin/alert-recipients) decides everything; these
// are its shapes and the page's words.

export type AlertCategory = "ORDER_INTEGRITY" | "RETURN_ESCALATION";
export const ALERT_CATEGORIES: AlertCategory[] = ["ORDER_INTEGRITY", "RETURN_ESCALATION"];

export interface AlertRecipientsOverview {
  /** Active administrators only: id and the last three phone digits. */
  administrators: { user_id: string; phone_hint: string }[];
  categories: {
    category: AlertCategory;
    recipient_user_ids: string[];
    delivery: "SUBSCRIBED" | "FALLBACK_ALL_ACTIVE_ADMINS";
  }[];
}

export interface AlertRecipientChange {
  category: AlertCategory;
  user_id: string;
  subscribed: boolean;
  changed: boolean;
}

/** Enough of the id to tell administrators apart on screen. */
export function shortId(userId: string): string {
  return userId.slice(0, 8);
}

/** The translation key for an API failure on this page. */
export function alertRecipientsErrorKey(err: unknown): string {
  if (!(err instanceof ApiError)) return "alerts.error.network";
  if (err.code === "ALERT_RECIPIENT_NOT_ELIGIBLE") return "alerts.error.not_eligible";
  if (err.status === 404) return "alerts.error.unavailable";
  if (err.status === 401) return "alerts.error.signed_out";
  if (err.status >= 500) return "alerts.error.server";
  return "alerts.error.generic";
}

registerTranslations({
  ar: {
    "alerts.title": "مستلمو تنبيهات المنصة",
    "alerts.back": "إدارة المنصة",
    "alerts.intro":
      "اختاري من يستقبل كل فئة من تنبيهات المنصة. يصل التنبيه فقط لمن هو مدير منصة نشط لحظة الإرسال؛ سحب الدور أو تعطيل الحساب يُخرجه تلقائياً.",
    "alerts.forbidden": "هذه الصفحة لمدير المنصة فقط",
    "alerts.forbidden_action": "حسابي",
    "alerts.loading": "جارٍ تحميل المستلمين...",
    "alerts.retry": "إعادة المحاولة",
    "alerts.category.ORDER_INTEGRITY": "سلامة الطلبات",
    "alerts.category.ORDER_INTEGRITY.desc": "طلب فرع وُجدت بياناته في حالة غير سليمة وتحتاج مراجعة.",
    "alerts.category.RETURN_ESCALATION": "تصعيد الإرجاعات",
    "alerts.category.RETURN_ESCALATION.desc":
      "إرجاع وصل إلى التصعيد وينتظر قرار المنصة: لم يقرّر المتجر خلال 72 ساعة، أو اعترض العميل على رفض المتجر.",
    "alerts.status.subscribed": "مستلمون محدّدون: {n}",
    "alerts.status.fallback": "بلا مستلم محدّد",
    "alerts.fallback_warning":
      "لا يوجد مستلم محدّد لهذه الفئة، لذلك ستصل تنبيهاتها إلى كل مدراء المنصة النشطين ({n}).",
    "alerts.recipients_label": "المستلمون",
    "alerts.no_recipients": "لا أحد بعد.",
    "alerts.admin_label": "المدير {id}، هاتف ينتهي بـ {phone}",
    "alerts.remove": "إزالة",
    "alerts.removing": "جارٍ الإزالة...",
    "alerts.add_label": "إضافة مستلم",
    "alerts.add_placeholder": "اختاري مديراً",
    "alerts.add": "إضافة",
    "alerts.adding": "جارٍ الإضافة...",
    "alerts.all_subscribed": "كل المدراء النشطين مستلمون لهذه الفئة.",
    "alerts.confirm_last_remove":
      "هذا آخر مستلم محدّد لهذه الفئة. بعد إزالته ستصل تنبيهاتها إلى كل مدراء المنصة النشطين. متابعة؟",
    "alerts.done.added": "تمت إضافة المستلم.",
    "alerts.done.already_added": "هذا المدير مستلم بالفعل، لم يتغيّر شيء.",
    "alerts.done.removed": "تمت إزالة المستلم.",
    "alerts.done.already_removed": "هذا المدير لم يكن مستلماً، لم يتغيّر شيء.",
    "alerts.error.network": "تعذّر الاتصال بالخادم. لم يتأكد تنفيذ العملية؛ أعيدي المحاولة.",
    "alerts.error.server": "حدث خطأ في الخادم. لم يتأكد تنفيذ العملية؛ أعيدي المحاولة.",
    "alerts.error.not_eligible": "هذا الحساب لم يعد مدير منصة نشطاً. حدّثنا القائمة.",
    "alerts.error.unavailable": "إدارة مستلمي التنبيهات غير متاحة على هذا الخادم بعد.",
    "alerts.error.signed_out": "انتهت الجلسة. سجّلي الدخول من جديد.",
    "alerts.error.generic": "تعذّر تنفيذ العملية.",
  },
  en: {
    "alerts.title": "Platform alert recipients",
    "alerts.back": "Platform admin",
    "alerts.intro":
      "Choose who receives each category of platform alert. An alert only reaches someone who is an active platform administrator when it is sent; revoking the role or deactivating the account removes them automatically.",
    "alerts.forbidden": "This page is for platform administrators only",
    "alerts.forbidden_action": "My account",
    "alerts.loading": "Loading recipients...",
    "alerts.retry": "Try again",
    "alerts.category.ORDER_INTEGRITY": "Order integrity",
    "alerts.category.ORDER_INTEGRITY.desc": "A branch order whose data was found in an invalid state and needs review.",
    "alerts.category.RETURN_ESCALATION": "Return escalations",
    "alerts.category.RETURN_ESCALATION.desc":
      "A return escalated to the platform for a decision: the store did not decide within 72 hours, or the customer disputed its rejection.",
    "alerts.status.subscribed": "Chosen recipients: {n}",
    "alerts.status.fallback": "No chosen recipient",
    "alerts.fallback_warning":
      "No recipient is chosen for this category, so its alerts go to every active platform administrator ({n}).",
    "alerts.recipients_label": "Recipients",
    "alerts.no_recipients": "Nobody yet.",
    "alerts.admin_label": "Administrator {id}, phone ending {phone}",
    "alerts.remove": "Remove",
    "alerts.removing": "Removing...",
    "alerts.add_label": "Add a recipient",
    "alerts.add_placeholder": "Choose an administrator",
    "alerts.add": "Add",
    "alerts.adding": "Adding...",
    "alerts.all_subscribed": "Every active administrator already receives this category.",
    "alerts.confirm_last_remove":
      "This is the category's last chosen recipient. Once removed, its alerts go to every active platform administrator. Continue?",
    "alerts.done.added": "Recipient added.",
    "alerts.done.already_added": "This administrator already receives it; nothing changed.",
    "alerts.done.removed": "Recipient removed.",
    "alerts.done.already_removed": "This administrator was not a recipient; nothing changed.",
    "alerts.error.network": "Couldn't reach the server. The change isn't confirmed; please try again.",
    "alerts.error.server": "The server hit an error. The change isn't confirmed; please try again.",
    "alerts.error.not_eligible": "This account is no longer an active platform administrator. The list was refreshed.",
    "alerts.error.unavailable": "Alert-recipient management isn't available on this server yet.",
    "alerts.error.signed_out": "Your session ended. Please sign in again.",
    "alerts.error.generic": "Couldn't complete the action.",
  },
});
