import { Lang, registerTranslations, translate } from "./i18n";

// Sprint 19 (§8/§9 plan): the customer-and-staff-shared notification
// inbox. One API (`/me/notifications`), every recipient role (customer,
// branch employee, owner, platform administrator) - the backend's own
// Notification row never carries presentation text (see
// NotificationChannelService's own comment), so this file is the one place
// that turns a `type` + safe `data` into words and a destination link.
// TB-16.3: every type, title and detail line in Arabic and English (the
// Arabic unchanged).

export type NotificationTargetType =
  | "BRANCH_ORDER"
  | "STOCK"
  | "VENDOR"
  | "OFFER"
  | "CANONICAL_PRODUCT"
  // TB-14
  | "RETURN";

/** Every value of the API's NotificationType enum (apps/api/prisma/schema.prisma). */
export type NotificationType =
  | "STOCK_ADJUSTMENT"
  | "DELIVERY_CONFIRM_REQUESTED"
  | "NOT_RECEIVED_REPORTED"
  | "ORDER_AUTO_CONFIRMED"
  | "DELIVERY_CONFIRM_REMINDER"
  | "VENDOR_SUSPENDED"
  | "VENDOR_REACTIVATED"
  | "NEW_ORDER_FOR_EMPLOYEE"
  | "LOW_STOCK_AFTER_RESERVE"
  | "FOLLOWED_STORE_NEW_PRODUCT"
  | "FOLLOWED_STORE_NEW_PRODUCTS"
  | "FOLLOWED_STORE_DISCOUNT"
  // Sprint 20a (PDR-025/027/028): order exceptions. TB-16.3: these had no
  // title on the web at all (their code was shown). Some reach the
  // customer and some the store (ORDER_CANCELLED both) - the titles are
  // worded for either reader.
  | "PREP_REMINDER"
  | "SLOT_MISSED"
  | "ORDER_CANCELLED"
  | "ORDER_RESCHEDULED"
  | "DELIVERY_FAILED"
  | "REFUND_REQUESTED"
  | "REFUND_APPROVED"
  | "REFUND_AUTOMATIC"
  | "FAVORITE_PRICE_DROP"
  | "FAVORITE_BACK_IN_STOCK"
  | "VARIANT_BACK_IN_STOCK"
  | "FAVORITE_NEW_OFFER"
  // PD-3
  | "REVIEW_INVITATION"
  | "REVIEW_HIDDEN"
  // TB-9: platform administrators only.
  | "ORDER_INTEGRITY_ALERT"
  // TB-14: the returns lifecycle (RETURN_ESCALATION_ALERT: platform
  // administrators only).
  | "RETURN_REQUESTED"
  | "RETURN_VENDOR_REMINDER"
  | "RETURN_APPROVED"
  | "RETURN_REJECTED"
  | "RETURN_ADMIN_REJECTED"
  | "RETURN_ESCALATED"
  | "RETURN_REFUNDED"
  | "RETURN_EXCHANGED"
  | "RETURN_CODE_EXPIRED"
  | "RETURN_ESCALATION_ALERT"
  // TB-15: to the store - the platform's final decision on an escalated
  // return, and a customer cancelling a return request.
  | "RETURN_PLATFORM_APPROVED"
  | "RETURN_PLATFORM_REJECTED"
  | "RETURN_CANCELLED_BY_CUSTOMER"
  // «إدارة طلبات الفرع v2» phase 2: to the customer - her pickup order is
  // ready / her delivery order was sent (the order id only, never a code).
  | "READY_FOR_PICKUP"
  | "ORDER_SENT";

type Words = { ar: string; en: string };

/** Every type's title in both languages - the compiler refuses a type
 * without one (and the Playwright suite checks this list against the
 * API's own enum). */
export const NOTIFICATION_TITLES: Record<NotificationType, Words> = {
  STOCK_ADJUSTMENT: { ar: "تعديل على المخزون", en: "Stock adjustment" },
  DELIVERY_CONFIRM_REQUESTED: { ar: "يرجى تأكيد استلام طلبك", en: "Please confirm you received your order" },
  NOT_RECEIVED_REPORTED: { ar: "بلاغ عدم استلام على أحد الطلبات", en: "A \"not received\" report on an order" },
  ORDER_AUTO_CONFIRMED: { ar: "تم تأكيد استلام طلبك تلقائياً", en: "Your order was confirmed as received automatically" },
  DELIVERY_CONFIRM_REMINDER: { ar: "تذكير بتأكيد استلام طلبك", en: "Reminder to confirm you received your order" },
  VENDOR_SUSPENDED: { ar: "تم تعليق متجرك", en: "Your store was suspended" },
  VENDOR_REACTIVATED: { ar: "تمت إعادة تفعيل متجرك", en: "Your store was reactivated" },
  NEW_ORDER_FOR_EMPLOYEE: { ar: "طلب جديد في فرعك", en: "New order at your branch" },
  LOW_STOCK_AFTER_RESERVE: { ar: "المخزون منخفض على أحد المنتجات", en: "Low stock on a product" },
  FOLLOWED_STORE_NEW_PRODUCT: { ar: "منتج جديد من متجر تتابعينه", en: "New product from a store you follow" },
  FOLLOWED_STORE_NEW_PRODUCTS: { ar: "منتجات جديدة من متجر تتابعينه", en: "New products from a store you follow" },
  FOLLOWED_STORE_DISCOUNT: { ar: "خصم جديد من متجر تتابعينه", en: "New discount from a store you follow" },
  PREP_REMINDER: { ar: "تذكير: طلب يجب تجهيزه قريباً", en: "Reminder: an order needs preparing soon" },
  SLOT_MISSED: { ar: "لم يُجهَّز الطلب في موعده", en: "An order wasn't ready on time" },
  ORDER_CANCELLED: { ar: "أُلغي طلب", en: "An order was cancelled" },
  ORDER_RESCHEDULED: { ar: "تم اختيار موعد توصيل جديد لطلب", en: "A new delivery time was chosen for an order" },
  DELIVERY_FAILED: { ar: "تعذّر توصيل الطلب", en: "An order couldn't be delivered" },
  REFUND_REQUESTED: { ar: "طلب استرداد على أحد الطلبات", en: "A refund was requested on an order" },
  REFUND_APPROVED: { ar: "تمت الموافقة على استرداد مبلغ الطلب", en: "The refund for an order was approved" },
  REFUND_AUTOMATIC: { ar: "تم استرداد مبلغ الطلب تلقائياً", en: "An order was refunded automatically" },
  FAVORITE_PRICE_DROP: { ar: "انخفض سعر أحد منتجاتك المفضلة", en: "A favourite dropped in price" },
  FAVORITE_BACK_IN_STOCK: { ar: "عاد أحد منتجاتك المفضلة للمخزون", en: "A favourite is back in stock" },
  VARIANT_BACK_IN_STOCK: { ar: "عاد اللون والمقاس اللذان طلبتِهما للمخزون", en: "The colour and size you requested are back in stock" },
  FAVORITE_NEW_OFFER: { ar: "عرض جديد لأحد منتجاتك المفضلة", en: "A new offer on a favourite" },
  REVIEW_INVITATION: { ar: "اكتمل طلبك - قيّمي ما اشتريتِه", en: "Your order is complete - review what you bought" },
  REVIEW_HIDDEN: { ar: "أخفت الإدارة أحد تقييماتك", en: "The platform hid one of your reviews" },
  ORDER_INTEGRITY_ALERT: { ar: "طلب بحالة غير سليمة يحتاج مراجعة", en: "An order in an invalid state needs review" },
  RETURN_REQUESTED: { ar: "طلب إرجاع جديد في فرعك", en: "New return request at your branch" },
  RETURN_VENDOR_REMINDER: {
    ar: "تذكير: طلب إرجاع ينتظر قرارك منذ 48 ساعة",
    en: "Reminder: a return request has awaited your decision for 48 hours",
  },
  RETURN_APPROVED: { ar: "تمت الموافقة على طلب الإرجاع", en: "Your return request was approved" },
  RETURN_REJECTED: { ar: "رُفض طلب الإرجاع", en: "Your return request was rejected" },
  RETURN_ADMIN_REJECTED: { ar: "رفضت إدارة المنصة طلب الإرجاع نهائياً", en: "The platform rejected your return request" },
  RETURN_ESCALATED: { ar: "أُحيل طلب الإرجاع إلى إدارة المنصة", en: "Your return request was referred to the platform" },
  RETURN_REFUNDED: { ar: "تم استرداد مبلغ الإرجاع", en: "Your return was refunded" },
  RETURN_EXCHANGED: { ar: "تم استبدال المنتج", en: "Your item was exchanged" },
  RETURN_CODE_EXPIRED: { ar: "انتهت صلاحية كود تسليم الإرجاع", en: "Your return drop-off code has expired" },
  RETURN_ESCALATION_ALERT: { ar: "إرجاع متصاعد ينتظر قرار المنصة", en: "Escalated return awaiting a platform decision" },
  RETURN_PLATFORM_APPROVED: { ar: "وافقت إدارة المنصة على طلب إرجاع في فرعك", en: "The platform approved a return at your branch" },
  RETURN_PLATFORM_REJECTED: {
    ar: "رفضت إدارة المنصة طلب إرجاع في فرعك نهائياً",
    en: "The platform made a final rejection of a return at your branch",
  },
  RETURN_CANCELLED_BY_CUSTOMER: { ar: "ألغى العميل طلب إرجاع في فرعك", en: "A customer cancelled a return request at your branch" },
  READY_FOR_PICKUP: { ar: "طلبكِ جاهز للاستلام من الفرع", en: "Your order is ready for pickup at the branch" },
  ORDER_SENT: { ar: "طلبكِ في الطريق إليكِ", en: "Your order is on its way" },
};

export const NOTIFICATION_TYPES = Object.keys(NOTIFICATION_TITLES) as NotificationType[];

registerTranslations({
  ar: {
    // The inbox page and the drawer.
    "notif.page.title": "الإشعارات",
    "notif.page.all": "الكل",
    "notif.page.unread_only": "غير المقروءة فقط",
    "notif.page.empty": "لا توجد إشعارات بعد",
    "notif.page.empty_unread": "لا توجد إشعارات غير مقروءة",
    "notif.page.new": "جديد",
    "notif.page.load_more": "تحميل المزيد",
    "notif.page.loading_more": "جارٍ التحميل...",
    "notif.page.loading": "جارٍ التحميل",
    "notif.page.sign_in_title": "سجّلي الدخول لرؤية إشعاراتك",
    "notif.page.sign_in": "تسجيل الدخول",
    "notif.page.load_failed": "تعذّر تحميل الإشعارات",
    "notif.page.load_more_failed": "تعذّر تحميل المزيد",
    "notif.page.account": "حسابي",
    "notif.page.close": "إغلاق الإشعارات",
    "notif.unknown": "إشعار",
    // Detail lines.
    "notif.detail.reason": "السبب: {reason}",
    "notif.detail.remaining": "الكمية المتبقية: {n}",
    "notif.detail.new_products": "أضاف المتجر {n} منتجات جديدة",
    "notif.detail.order": "الطلب {id}",
    "notif.stock_reason.DAMAGE": "تلف",
    "notif.stock_reason.LOSS": "فقدان",
    "notif.stock_reason.COUNT_CORRECTION": "تصحيح جرد",
    "notif.stock_reason.INTERNAL_USE": "إخراج غير بيع",
    "notif.suspension.POLICY_VIOLATION": "مخالفة السياسة",
    "notif.suspension.NON_PAYMENT": "عدم السداد",
    "notif.suspension.OTHER": "سبب آخر",
    "notif.integrity.PICKUP_IN_DELIVERY_STATUS": "طلب استلام من المحل بحالة خاصة بالتوصيل",
    "notif.integrity.DELIVERY_IN_PICKUP_STATUS": "طلب توصيل بحالة خاصة بالاستلام من المحل",
    "notif.integrity.DELIVERED_WITHOUT_DELIVERED_AT": "طلب «تم التسليم» بلا وقت تسليم",
    "notif.return_escalation.detail": "الإرجاع {id}",
    "notif.return_escalation.SLA_TIMEOUT": "لم يقرّر المتجر خلال 72 ساعة",
    "notif.return_escalation.CUSTOMER_DISPUTE": "اعترض العميل على رفض المتجر",
    "notif.return_store.RETURN": "إرجاع - بانتظار تسليم العميل للمنتج",
    "notif.return_store.EXCHANGE": "استبدال - حُجز البديل، بانتظار تسليم العميل للمنتج",
  },
  en: {
    "notif.page.title": "Notifications",
    "notif.page.all": "All",
    "notif.page.unread_only": "Unread only",
    "notif.page.empty": "No notifications yet",
    "notif.page.empty_unread": "No unread notifications",
    "notif.page.new": "New",
    "notif.page.load_more": "Load more",
    "notif.page.loading_more": "Loading...",
    "notif.page.loading": "Loading",
    "notif.page.sign_in_title": "Sign in to see your notifications",
    "notif.page.sign_in": "Sign in",
    "notif.page.load_failed": "Couldn't load notifications",
    "notif.page.load_more_failed": "Couldn't load more",
    "notif.page.account": "My account",
    "notif.page.close": "Close notifications",
    "notif.unknown": "Notification",
    "notif.detail.reason": "Reason: {reason}",
    "notif.detail.remaining": "Remaining quantity: {n}",
    "notif.detail.new_products": "The store added {n} new products",
    "notif.detail.order": "Order {id}",
    "notif.stock_reason.DAMAGE": "Damage",
    "notif.stock_reason.LOSS": "Loss",
    "notif.stock_reason.COUNT_CORRECTION": "Count correction",
    "notif.stock_reason.INTERNAL_USE": "Taken out (not a sale)",
    "notif.suspension.POLICY_VIOLATION": "Policy violation",
    "notif.suspension.NON_PAYMENT": "Non-payment",
    "notif.suspension.OTHER": "Another reason",
    "notif.integrity.PICKUP_IN_DELIVERY_STATUS": "A pickup order in a delivery status",
    "notif.integrity.DELIVERY_IN_PICKUP_STATUS": "A delivery order in a pickup status",
    "notif.integrity.DELIVERED_WITHOUT_DELIVERED_AT": "Marked delivered with no delivery time",
    "notif.return_escalation.detail": "Return {id}",
    "notif.return_escalation.SLA_TIMEOUT": "The store did not decide within 72 hours",
    "notif.return_escalation.CUSTOMER_DISPUTE": "The customer disputed the store's rejection",
    "notif.return_store.RETURN": "Return - awaiting the customer's drop-off",
    "notif.return_store.EXCHANGE": "Exchange - replacement reserved, awaiting the customer's drop-off",
  },
});

/** The notification's title in the current language. A type the web does
 * not know yet gets a plain "Notification" - never its raw code. */
export function notificationLabel(type: NotificationType | string, lang: Lang): string {
  const words = Object.prototype.hasOwnProperty.call(NOTIFICATION_TITLES, type)
    ? NOTIFICATION_TITLES[type as NotificationType]
    : null;
  return words ? words[lang] : translate(lang, "notif.unknown");
}

/** A notification's time, in the interface language. */
export function formatNotificationTime(iso: string, lang: Lang): string {
  return new Date(iso).toLocaleString(lang === "en" ? "en" : "ar", { dateStyle: "medium", timeStyle: "short" });
}

export interface NotificationDto {
  id: string;
  type: NotificationType;
  data: Record<string, unknown>;
  target_type: NotificationTargetType;
  target_id: string;
  vendor_id: string | null;
  branch_id: string | null;
  /** TB-26: whose notification this is - the shopping bell, a store
   * workspace or the platform workspace. */
  audience?: "CUSTOMER" | "STORE" | "PLATFORM";
  read_at: string | null;
  created_at: string;
}

export interface NotificationPageDto {
  items: NotificationDto[];
  next_cursor: string | null;
}

/** A fixed code's words, or null for a code this file does not know. */
function codeWords(prefix: string, code: unknown, lang: Lang): string | null {
  if (typeof code !== "string" || !code) return null;
  const key = `${prefix}.${code}`;
  const words = translate(lang, key);
  return words === key ? null : words;
}
const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (all, name: string) => (name in values ? String(values[name]) : all));

/** The one-line detail under the type label, built only from the
 * whitelisted `data` fields the relay's own buildSafeData() allows
 * through - fixed codes, a quantity for the store, ids. The one free text
 * is REVIEW_HIDDEN's reason: the administrator's own words to the
 * review's author, shown as written. */
export function notificationDetail(n: NotificationDto, lang: Lang = "ar"): string | null {
  switch (n.type) {
    // TB-14: which return, and why it was escalated (a fixed code).
    case "RETURN_ESCALATION_ALERT": {
      const line = fill(translate(lang, "notif.return_escalation.detail"), { id: n.target_id });
      const reason = String(n.data.reason ?? "");
      return reason === "SLA_TIMEOUT" || reason === "CUSTOMER_DISPUTE"
        ? `${line} - ${translate(lang, `notif.return_escalation.${reason}`)}`
        : line;
    }
    // TB-15: whether the platform approved a return or an exchange - a
    // fixed code, and the only thing these store notifications carry.
    case "RETURN_PLATFORM_APPROVED": {
      const outcome = String(n.data.outcome ?? "");
      return outcome === "RETURN" || outcome === "EXCHANGE"
        ? translate(lang, `notif.return_store.${outcome}`)
        : null;
    }
    // Bulk publishing: one notice for the run - how many products the store added.
    case "FOLLOWED_STORE_NEW_PRODUCTS": {
      const count = n.data.count;
      return typeof count === "number" ? fill(translate(lang, "notif.detail.new_products"), { n: count }) : null;
    }
    case "STOCK_ADJUSTMENT": {
      const reason = codeWords("notif.stock_reason", n.data.reason, lang);
      return reason ? fill(translate(lang, "notif.detail.reason"), { reason }) : null;
    }
    case "VENDOR_SUSPENDED": {
      const reason = codeWords("notif.suspension", n.data.reason_code, lang);
      return reason ? fill(translate(lang, "notif.detail.reason"), { reason }) : null;
    }
    // To the store's staff only (the relay sends it to the branch).
    case "LOW_STOCK_AFTER_RESERVE": {
      const remaining = n.data.remaining_quantity;
      return typeof remaining === "number" ? fill(translate(lang, "notif.detail.remaining"), { n: remaining }) : null;
    }
    // PD-3: the administrator's own decision reason, written for the
    // author (the relay never passes a reporter's text) - as written.
    case "REVIEW_HIDDEN": {
      const reason = typeof n.data.reason === "string" ? n.data.reason : "";
      return reason ? fill(translate(lang, "notif.detail.reason"), { reason }) : null;
    }
    // TB-9: which order and what is wrong - the order id is what the
    // audit-log search takes.
    case "ORDER_INTEGRITY_ALERT": {
      const issue = codeWords("notif.integrity", n.data.issue, lang);
      const line = fill(translate(lang, "notif.detail.order"), { id: n.target_id });
      return issue ? `${line} - ${issue}` : line;
    }
    default:
      return null;
  }
}

/** Where tapping a notification should go. A few types (the two
 * followed-store ones) only carry a vendor_id, not a slug, so they fall
 * back to "أتابعه" rather than guessing a broken store URL. */
export function notificationHref(
  n: NotificationDto,
  /** The reader's role in the notification's store (store notifications only). */
  ctx: { storeRole?: "OWNER" | "BRANCH_EMPLOYEE" | null } = {},
): string {
  // TB-26: a store notification about an order leads to that branch's
  // orders in the store workspace - never to the customer's own orders
  // (ORDER_CANCELLED is sent to both sides; its audience says which).
  // 2026-11-18: with ?order= so that page highlights the order it is about.
  const orderParam = n.target_type === "BRANCH_ORDER" && n.target_id ? `?order=${encodeURIComponent(n.target_id)}` : "";
  const branchOrders =
    n.vendor_id && n.branch_id ? `/vendor/${n.vendor_id}/branches/${n.branch_id}/orders${orderParam}` : null;
  if (
    n.audience === "STORE" &&
    (n.type === "ORDER_CANCELLED" ||
      n.type === "ORDER_RESCHEDULED" ||
      n.type === "REFUND_REQUESTED" ||
      n.type === "PREP_REMINDER")
  ) {
    return branchOrders ?? (n.vendor_id ? `/vendor/${n.vendor_id}/orders` : "/account");
  }
  switch (n.type) {
    // 2026-11-18: low stock names one version (target STOCK = the variant).
    // The owner opens «المنتجات والعروض» on that product, colour and size
    // (with the branch stock one tap away); an employee - who has no
    // products page - the branch stock with that line highlighted.
    case "LOW_STOCK_AFTER_RESERVE":
      if (!n.vendor_id || !n.branch_id) return "/account";
      if (ctx.storeRole === "OWNER" && n.target_type === "STOCK" && n.target_id) {
        return `/vendor/${n.vendor_id}/offers?stock_variant=${encodeURIComponent(n.target_id)}&branch=${encodeURIComponent(n.branch_id)}`;
      }
      return `/vendor/${n.vendor_id}/branches/${n.branch_id}/stock${n.target_type === "STOCK" && n.target_id ? `?variant=${encodeURIComponent(n.target_id)}` : ""}`;
    case "STOCK_ADJUSTMENT":
      return n.vendor_id && n.branch_id
        ? `/vendor/${n.vendor_id}/branches/${n.branch_id}/stock${n.target_type === "STOCK" && n.target_id ? `?variant=${encodeURIComponent(n.target_id)}` : ""}`
        : "/account";
    // 2026-11-22: the branch's order screen (where «إعادة طلب تأكيد الاستلام»
    // is), on that order - the store-wide list only if the branch is unknown.
    case "NOT_RECEIVED_REPORTED":
      return branchOrders ?? (n.vendor_id ? `/vendor/${n.vendor_id}/orders${orderParam}` : "/orders");
    case "NEW_ORDER_FOR_EMPLOYEE":
      return branchOrders ?? "/account";
    case "VENDOR_SUSPENDED":
    case "VENDOR_REACTIVATED":
      return n.vendor_id ? `/vendor/${n.vendor_id}` : "/account";
    case "FOLLOWED_STORE_NEW_PRODUCT":
    case "FOLLOWED_STORE_NEW_PRODUCTS":
    case "FOLLOWED_STORE_DISCOUNT":
      return "/following";
    // FAVORITE_PRICE_DROP/FAVORITE_BACK_IN_STOCK only carry an
    // offerVariantId, not a store slug/offer id - no buildable product
    // URL exists from that alone, so (same fallback shape as the
    // followed-store types above) this routes to the customer's own
    // favorites list rather than guessing a broken link.
    case "FAVORITE_PRICE_DROP":
    case "FAVORITE_BACK_IN_STOCK":
      return "/account/favorites";
    case "VARIANT_BACK_IN_STOCK":
      {
        const slug = typeof n.data.vendor_slug === "string" ? n.data.vendor_slug : null;
        const offerId = typeof n.data.offer_id === "string" ? n.data.offer_id : null;
        const colorId = typeof n.data.color_id === "string" ? n.data.color_id : null;
        const sizeCode = typeof n.data.size_code === "string" ? n.data.size_code : null;
        if (!slug || !offerId) return "/account/availability-alerts";
        const query = new URLSearchParams();
        if (colorId) query.set("color", colorId);
        if (sizeCode) query.set("size", sizeCode);
        return `/store/${encodeURIComponent(slug)}/products/${encodeURIComponent(offerId)}${query.size ? `?${query.toString()}` : ""}`;
      }
    case "FAVORITE_NEW_OFFER":
      return n.target_id ? `/compare/${n.target_id}` : "/account/favorites";
    // PD-3: both lead to «طلباتي», where each completed item offers its
    // review (or shows that it was hidden).
    case "REVIEW_INVITATION":
    case "REVIEW_HIDDEN":
      return "/cart?tab=orders";
    case "ORDER_INTEGRITY_ALERT":
      return "/admin/audit-logs";
    // TB-14: the branch's own returns queue; the customer's return; the
    // platform's escalated-returns queue.
    case "RETURN_REQUESTED":
    case "RETURN_VENDOR_REMINDER":
    // TB-15: the same branch returns page.
    case "RETURN_PLATFORM_APPROVED":
    case "RETURN_PLATFORM_REJECTED":
    case "RETURN_CANCELLED_BY_CUSTOMER":
      // IX-P2: straight to that return on the branch's returns board
      return n.vendor_id && n.branch_id
        ? `/vendor/${n.vendor_id}/branches/${n.branch_id}/returns${n.target_id ? `?return=${encodeURIComponent(n.target_id)}` : ""}`
        : "/account";
    case "RETURN_APPROVED":
    case "RETURN_REJECTED":
    case "RETURN_ADMIN_REJECTED":
    case "RETURN_ESCALATED":
    case "RETURN_REFUNDED":
    case "RETURN_EXCHANGED":
    case "RETURN_CODE_EXPIRED":
      return `/returns/${n.target_id}`;
    case "RETURN_ESCALATION_ALERT":
      return "/admin/returns";
    case "DELIVERY_CONFIRM_REQUESTED":
    case "ORDER_AUTO_CONFIRMED":
    case "DELIVERY_CONFIRM_REMINDER":
    // phase 2: her own orders (where «جاهز للاستلام» shows)
    case "READY_FOR_PICKUP":
    case "ORDER_SENT":
    default:
      return "/orders";
  }
}
