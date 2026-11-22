import { ApiError } from "./api";
import type { Lang } from "./i18n";
import { safeNextPath } from "./loginRedirect";

// TB-16.1: the one place that turns an API failure into words for the
// returns and notification screens. Order, always: (1) the error's own
// code, (2) a generic message for its HTTP status, (3) "could not reach
// the server" for anything that is not an API answer. The API's own
// `message` is NEVER shown - not for an unknown code, not for a 5xx (it
// can carry internal error text, see TB-21). Pure: no browser APIs, so
// it is testable without a page.

type Text = { ar: string; en: string };

/** Specific codes - always win over the HTTP status. */
export const API_ERROR_TEXT: Record<string, Text> = {
  // Returns (Sprint 21 / 21b) - the Arabic is unchanged from lib/returns.ts.
  BRANCH_ORDER_ITEM_NOT_FOUND: {
    ar: "لم يُعثر على هذا المنتج ضمن طلباتك.",
    en: "This item wasn't found in your orders.",
  },
  ITEM_CANCELLED_NOT_RETURNABLE: {
    ar: "هذا المنتج أُلغي قبل التوصيل، ولا يمكن إرجاعه.",
    en: "This item was cancelled before delivery and can't be returned.",
  },
  RETURN_ALREADY_EXISTS: {
    ar: "يوجد طلب إرجاع سابق لهذا المنتج بالفعل.",
    en: "A return request already exists for this item.",
  },
  RETURN_NOT_FOUND: { ar: "لم يُعثر على طلب الإرجاع.", en: "Return request not found." },
  RETURN_NOT_CANCELLABLE: {
    ar: "لا يمكن إلغاء طلب الإرجاع إلا وهو بانتظار قرار المتجر.",
    en: "A return can only be cancelled while it awaits the store's decision.",
  },
  RETURN_NOT_DISPUTABLE: {
    ar: "لا يمكن الاعتراض إلا على طلب مرفوض من المتجر.",
    en: "Only a request rejected by the store can be disputed.",
  },
  DISPUTE_WINDOW_EXPIRED: {
    ar: "انتهت مهلة الاعتراض على هذا الرفض (7 أيام).",
    en: "The 7-day window to dispute this rejection has ended.",
  },
  RETURN_NOT_DECIDABLE: { ar: "تم البتّ في هذا الطلب بالفعل.", en: "This request has already been decided." },
  RETURN_NOT_ESCALATED: {
    ar: "هذا الطلب لم يعد معلَّقاً لمراجعة إدارة المنصة.",
    en: "This request is no longer awaiting a platform decision.",
  },
  RETURN_POLICY_CHANGE_TOO_SOON: {
    ar: "يمكن تعديل سياسة الإرجاع مرة واحدة كل ستة أشهر فقط - لم تحن المدة بعد.",
    en: "The return policy can be changed once every six months - not yet.",
  },
  INVALID_RETURN_CODE: {
    ar: "هذا الكود غير صالح، أو مستخدم من قبل، أو منتهي.",
    en: "This code is invalid, already used, or expired.",
  },
  RETURN_CODE_EXPIRED: {
    ar: "انتهت صلاحية هذا الكود (7 أيام من الاعتماد).",
    en: "This code has expired (7 days after approval).",
  },
  RECEIVING_BRANCH_NOT_IN_VENDOR: {
    ar: "الفرع المحدَّد لا يتبع متجركم.",
    en: "The selected branch doesn't belong to your store.",
  },
  FORBIDDEN: { ar: "لا تملك صلاحية لهذا الإجراء.", en: "You don't have permission for this action." },
  OUTCOME_NOT_ALLOWED_BY_POLICY: {
    ar: "سياسة هذا المتجر وقت الشراء لا تسمح بهذا الخيار (إرجاع/تبديل).",
    en: "The store's policy at purchase time doesn't allow this option (return/exchange).",
  },
  REPLACEMENT_REQUIRED: { ar: "يرجى اختيار البديل والفرع.", en: "Please choose the replacement and the branch." },
  REPLACEMENT_SAME_AS_ORIGINAL: {
    ar: "يجب أن يكون البديل مختلفاً عن المنتج الأصلي.",
    en: "The replacement must differ from the original item.",
  },
  REPLACEMENT_VARIANT_NOT_FOUND: {
    ar: "البديل يجب أن يكون متغيّراً آخر من نفس المنتج.",
    en: "The replacement must be another variant of the same product.",
  },
  REPLACEMENT_NOT_AVAILABLE: {
    ar: "البديل غير متوفر حالياً بالكمية المطلوبة.",
    en: "The replacement isn't available in the required quantity right now.",
  },
  REPLACEMENT_BRANCH_NOT_FOUND: {
    ar: "الفرع المحدَّد لا يتبع متجركم.",
    en: "The selected branch doesn't belong to your store.",
  },
  REPLACEMENT_BRANCH_NOT_AVAILABLE: {
    ar: "الفرع المحدَّد غير نشط حالياً.",
    en: "The selected branch isn't active right now.",
  },
  WRONG_BRANCH_FOR_EXCHANGE: {
    ar: "هذا التبديل يُستلَم فقط في الفرع المحدَّد له.",
    en: "This exchange can only be collected at its assigned branch.",
  },
  BRANCH_HAS_ACTIVE_EXCHANGE_RESERVATION: {
    ar: "هذا الفرع لديه حجز تبديل نشط، لا يمكن أرشفته الآن.",
    en: "This branch has an active exchange hold and can't be archived now.",
  },
  // TB-16.1: codes that had no words and fell through to the API's English.
  UNAUTHENTICATED: {
    ar: "انتهت جلستك، سجّلي الدخول من جديد.",
    en: "Your session has ended - please sign in again.",
  },
  SESSION_INVALID: {
    ar: "انتهت جلستك، سجّلي الدخول من جديد.",
    en: "Your session has ended - please sign in again.",
  },
  NOT_VENDOR_MEMBER: {
    ar: "لا تملكين صلاحية الوصول إلى هذا المتجر.",
    en: "You don't have access to this store.",
  },
  STAFF_SUSPENDED: {
    ar: "عضويتك في هذا المتجر موقوفة حالياً.",
    en: "Your membership in this store is suspended.",
  },
  BRANCH_ACCESS_DENIED: {
    ar: "لا تملكين صلاحية الوصول إلى مرتجعات هذا الفرع.",
    en: "You don't have access to this branch's returns.",
  },
  VENDOR_ROLE_FORBIDDEN: {
    ar: "دورك في المتجر لا يسمح بهذا الإجراء.",
    en: "Your role in this store can't do this.",
  },
  VENDOR_SUSPENDED: {
    ar: "المتجر موقوف حالياً، فلا يمكن تنفيذ هذا التغيير.",
    en: "This store is suspended, so this change can't be made.",
  },
  BRANCH_ARCHIVED: {
    ar: "هذا الفرع مؤرشف، فلا يمكن تنفيذ هذا التغيير.",
    en: "This branch is archived, so this change can't be made.",
  },
  CUSTOMER_PROFILE_NOT_FOUND: {
    ar: "تعذّر العثور على حسابك كعميل.",
    en: "Your customer account couldn't be found.",
  },
  // A repeated Idempotency-Key with another body, or one still running.
  // Phase A++ (item 8): sign-in, registration, OTP, password reset,
  // reactivation, phone change and addresses - every code these screens get.
  DRAFT_REVISION_CONFLICT: {
    ar: "حُفظت نسخة أحدث من هذه المسودة في نافذة أخرى. لم يتغيّر شيء هنا.",
    en: "A newer version of this draft was saved in another window. Nothing changed here.",
  },
  DRAFT_NOT_SAVED: {
    ar: "لم تُحفظ آخر التعديلات بعد. أعيدي المحاولة بعد الحفظ.",
    en: "The latest changes are not saved yet. Try again once they are.",
  },
  SAME_BRANCH: {
    ar: "اختاري فرعين مختلفين.",
    en: "Choose two different branches.",
  },
  BRANCH_NOT_FOUND: {
    ar: "أحد الفرعين ليس من فروع متجركم النشطة.",
    en: "One of the branches is not an active branch of your store.",
  },
  EDIT_VIA_DRAFT: {
    ar: "محتوى المنتج المنشور يُعدَّل من «تعديل المنتج».",
    en: "A published product's content is changed with «Edit product».",
  },
  OFFER_NOT_CLASSIFIED_FOR_EDIT: {
    ar: "صنّفي المنتج أولاً لاستخدام معالج التعديل.",
    en: "Classify the product first to use the edit wizard.",
  },
  OFFER_NOT_EDITABLE_BY_DRAFT: {
    ar: "هذا المنتج لا يُعدَّل بمسودة تعديل (لم يُنشر بعد أو مؤرشف).",
    en: "This product isn't edited with an edit draft (never published, or archived).",
  },
  EDIT_LOCKED_FIELD: {
    ar: "هذا الحقل لا يتغيّر في منتج منشور. انسخيه كمنتج جديد.",
    en: "This field doesn't change on a published product. Copy it as a new product.",
  },
  EDIT_REMOVE_NOT_ALLOWED: {
    ar: "لا يُحذف لون أو مقاس موجود من منتج منشور.",
    en: "An existing colour or size is never removed from a published product.",
  },
  EDIT_STOCK_EXISTING: {
    ar: "كميات النسخ الموجودة تُدار من شاشة المخزون.",
    en: "Stock of existing versions is managed on the stock screen.",
  },
  COLOR_NAME_TAKEN: {
    ar: "اسم اللون مكرر في هذا المنتج. لم يُحفظ التعديل، والمسودة كما كانت.",
    en: "This colour name is already used in this product. The change was not saved; the draft is as it was.",
  },
  COLOR_AMBIGUOUS: {
    ar: "لهذا المنتج أكثر من لون من العائلة نفسها. اختاري اللون بالاسم.",
    en: "This product has more than one colour of this family. Choose the colour by its name.",
  },
  COLOR_NOT_FOUND: { ar: "هذا اللون ليس من ألوان هذا المنتج.", en: "This colour is not one of this product's colours." },
  AVAILABILITY_TARGET_NOT_FOUND: {
    ar: "هذا اللون أو المقاس لم يعد متاحاً لطلب التنبيه.",
    en: "This colour or size can no longer receive a restock alert.",
  },
  VARIANT_AVAILABLE: {
    ar: "هذا اللون والمقاس متوفران الآن بالفعل.",
    en: "This colour and size are already available.",
  },
  TOO_MANY_COLORS: { ar: "الحد الأقصى 30 لوناً للمنتج.", en: "A product has at most 30 colours." },
  MODEL_INCOMPLETE: {
    ar: "أكملي طول العارضة والمقاس الذي ترتديه، أو أزيلي معلومات العارضة.",
    en: "Give the model's height and the size she wears, or remove the model information.",
  },
  MODEL_HEIGHT_RANGE: {
    ar: "طول العارضة يجب أن يكون بين 100 و220 سم.",
    en: "The model's height must be between 100 and 220 cm.",
  },
  MODEL_SIZE_NOT_IN_PRODUCT: {
    ar: "مقاس العارضة يجب أن يكون من مقاسات هذا المنتج.",
    en: "The model's size must be one of this product's sizes.",
  },
  UPLOAD_NOT_USABLE: {
    ar: "لا يمكن استخدام هذه الصورة. ارفعيها من جديد لهذا المتجر.",
    en: "This image cannot be used. Upload it again to this store.",
  },
  PHONE_INVALID: {
    ar: "رقم الهاتف غير صحيح، اكتبيه بصيغة \u200E+970…",
    en: "The phone number isn't valid - write it as +970…",
  },
  INVALID_CREDENTIALS: { ar: "رقم الهاتف أو كلمة المرور غير صحيحة.", en: "The phone number or password is incorrect." },
  ACCOUNT_DEACTIVATED: {
    ar: "هذا الحساب معطّل. يمكنك استعادته خلال 30 يوماً من تعطيله.",
    en: "This account is deactivated. You can recover it within 30 days of deactivation.",
  },
  ACCOUNT_NOT_DEACTIVATED: { ar: "هذا الحساب غير معطّل.", en: "This account isn't deactivated." },
  ACCOUNT_REACTIVATION_WRONG_ENDPOINT: {
    ar: "هذا الحساب معطّل؛ استعيديه من صفحة «استعادة الحساب».",
    en: "This account is deactivated - recover it from the account recovery page.",
  },
  RECOVERY_WINDOW_EXPIRED: {
    ar: "انتهت مهلة استعادة هذا الحساب (30 يوماً).",
    en: "The 30-day window to recover this account has ended.",
  },
  OTP_INVALID: { ar: "رمز التحقق غير صحيح.", en: "The verification code is incorrect." },
  OTP_EXPIRED: { ar: "انتهت صلاحية رمز التحقق، اطلبي رمزاً جديداً.", en: "The verification code has expired - request a new one." },
  OTP_SUPERSEDED: { ar: "أُرسل رمز أحدث، استخدم آخر رمز وصلك.", en: "A newer code was sent. Use the latest code you received." },
  TOO_MANY_ATTEMPTS: {
    ar: "محاولات كثيرة لهذا الرمز، اطلبي رمزاً جديداً.",
    en: "Too many attempts for this code - request a new one.",
  },
  PHONE_ALREADY_REGISTERED: {
    ar: "هذا الرقم مسجّل من قبل؛ سجّلي الدخول به.",
    en: "This number is already registered - sign in with it.",
  },
  PHONE_NOT_VERIFIED: { ar: "لم يتم التحقق من رقم الهاتف بعد.", en: "The phone number hasn't been verified yet." },
  PASSWORD_REQUIRED: { ar: "اكتبي كلمة المرور.", en: "Enter the password." },
  ADDRESS_NOT_FOUND: { ar: "لم يُعثر على هذا العنوان.", en: "This address wasn't found." },
  ADDRESS_IN_USE_BY_ACTIVE_ORDER: {
    ar: "هذا العنوان مستخدم في طلب قائم، ولا يمكن تعديله أو حذفه الآن.",
    en: "This address is used by an active order and can't be changed or removed now.",
  },
  // Phase A++ (item 7): the price rules (resolveUnifiedPrice) - the same words everywhere.
  INVALID_BASE_PRICE: { ar: "سعر المنتج يجب أن يكون أكبر من صفر.", en: "The product price must be above zero." },
  INVALID_SALE_PRICE: {
    ar: "السعر بعد الخصم يجب أن يكون أقل من سعر المنتج وأكبر من صفر.",
    en: "The price after the discount must be below the product price and above zero.",
  },
  INCOMPLETE_DISCOUNT_WINDOW: { ar: "أكملي نسبة الخصم وتاريخي البداية والنهاية.", en: "Complete the percentage and both dates." },
  DISCOUNT_PERCENT_OUT_OF_RANGE: { ar: "نسبة الخصم يجب أن تكون بين 1 و99.", en: "The percentage must be between 1 and 99." },
  INVALID_DISCOUNT_WINDOW: { ar: "تاريخ بداية الخصم يجب أن يسبق تاريخ نهايته.", en: "The start date must come before the end date." },
  DISCOUNT_RESULTS_IN_ZERO_PRICE: { ar: "هذا الخصم يجعل السعر صفراً أو أقل.", en: "This discount makes the price zero or less." },
  SALE_AND_DISCOUNT_EXCLUSIVE: {
    ar: "اختاري نوع خصم واحداً: سعراً بعد الخصم أو نسبة لفترة.",
    en: "Choose one kind of discount: a price after the discount or a percentage for a period.",
  },
  PRICE_IS_OFFER_LEVEL: {
    ar: "سعر هذا المنتج واحد لكل ألوانه ومقاساته، ويُعدَّل من صفحة المنتج.",
    en: "This product has one price for all its colours and sizes - change it on the product page.",
  },
  CONFLICT: {
    ar: "هذا الطلب قيد التنفيذ أو أُرسل للتو، حدّثي الصفحة.",
    en: "This request is already in progress or was just sent - refresh the page.",
  },
};

/** NOT_ELIGIBLE_FOR_RETURN's details[0].reason_code. */
export const ELIGIBILITY_TEXT: Record<string, Text> = {
  NO_POLICY_SNAPSHOT: {
    ar: "هذا الطلب أُنشئ قبل تفعيل سياسة الإرجاع، فلا يحق له إرجاع.",
    en: "This order was placed before a return policy existed, so it can't be returned.",
  },
  RETURNS_DISABLED: { ar: "هذا المتجر لا يقبل إرجاع المنتجات.", en: "This store doesn't accept returns." },
  NOT_YET_ARRIVED: {
    ar: "لا يمكن طلب إرجاع قبل استلام المنتج فعلياً.",
    en: "You can't request a return before you receive the item.",
  },
  COD_NOT_COLLECTED: {
    ar: "لم يتم تحصيل المبلغ عند الاستلام لهذا الطلب بعد.",
    en: "Cash on delivery hasn't been collected for this order yet.",
  },
  WINDOW_EXPIRED: {
    ar: "انتهت مهلة الإرجاع المسموحة لهذا المنتج.",
    en: "The return period for this item has ended.",
  },
};
const NOT_ELIGIBLE: Text = { ar: "هذا المنتج غير مؤهل للإرجاع.", en: "This item isn't eligible for return." };

/** When the code is not known: by HTTP status. */
export function statusText(status: number): Text {
  if (status === 400) {
    return {
      ar: "بعض البيانات المدخلة غير صحيحة، راجعيها وحاولي مجدداً.",
      en: "Some of the details aren't valid - please check and try again.",
    };
  }
  if (status === 401) return API_ERROR_TEXT.SESSION_INVALID;
  if (status === 403) return { ar: "لا تملكين صلاحية لهذا الإجراء.", en: "You don't have permission for this action." };
  if (status === 404) return { ar: "لم يُعثر على المطلوب.", en: "Not found." };
  if (status === 409) {
    return {
      ar: "تعذّر التنفيذ لأن الحالة تغيّرت، حدّثي الصفحة وحاولي مجدداً.",
      en: "This couldn't be done because things have changed - refresh the page and try again.",
    };
  }
  if (status === 422) return { ar: "تعذّر إرسال الطلب، حاولي مجدداً.", en: "The request couldn't be sent - please try again." };
  if (status === 429) {
    return { ar: "محاولات كثيرة، انتظري قليلاً ثم حاولي مجدداً.", en: "Too many attempts - wait a moment and try again." };
  }
  if (status >= 500) return { ar: "حدث خطأ غير متوقع، حاولي لاحقاً.", en: "Something went wrong - please try again later." };
  return { ar: "تعذّر إكمال الطلب، حاولي مجدداً.", en: "This couldn't be completed - please try again." };
}

export const NETWORK_TEXT: Text = { ar: "تعذّر الاتصال بالخادم", en: "Couldn't reach the server." };

/** The words for any failure - never the API's own message. */
export function apiErrorMessage(err: unknown, lang: Lang = "ar"): string {
  if (!(err instanceof ApiError)) return NETWORK_TEXT[lang];
  if (err.code === "NOT_ELIGIBLE_FOR_RETURN") {
    const detail = err.details[0] as { reason_code?: unknown } | undefined;
    const reason = typeof detail?.reason_code === "string" ? ELIGIBILITY_TEXT[detail.reason_code] : undefined;
    return (reason ?? NOT_ELIGIBLE)[lang];
  }
  const known = Object.prototype.hasOwnProperty.call(API_ERROR_TEXT, err.code) ? API_ERROR_TEXT[err.code] : undefined;
  return (known ?? statusText(err.status))[lang];
}

/** A 401: the session is gone - the page sends the user to sign in. */
export function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

/** `/login?next=<this page>` - only ever a same-site path: anything that is
 * not one ("//host", "/\host", a scheme, a control character) becomes "/". */
export function loginPathFor(currentPath: string): string {
  // TB-34: the one rule for `next` (lib/loginRedirect.ts).
  return `/login?next=${encodeURIComponent(safeNextPath(currentPath) ?? "/")}`;
}
