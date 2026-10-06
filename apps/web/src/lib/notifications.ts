import { SUSPENSION_REASON_LABEL } from "./admin";

// Sprint 19 (§8/§9 plan): the customer-and-staff-shared notification
// inbox. One API (`/me/notifications`), every recipient role (customer,
// branch employee, owner) - the backend's own Notification row never
// carries presentation text (see NotificationChannelService's own
// comment), so this file is the one place that turns a `type` + safe
// `data` into Arabic copy and a destination link, matching this
// codebase's established VERIFICATION_LABEL-style convention.

export type NotificationTargetType = "BRANCH_ORDER" | "STOCK" | "VENDOR" | "OFFER";

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
  | "FOLLOWED_STORE_DISCOUNT";

export interface NotificationDto {
  id: string;
  type: NotificationType;
  data: Record<string, unknown>;
  target_type: NotificationTargetType;
  target_id: string;
  vendor_id: string | null;
  branch_id: string | null;
  read_at: string | null;
  created_at: string;
}

export interface NotificationPageDto {
  items: NotificationDto[];
  next_cursor: string | null;
}

export const NOTIFICATION_TYPE_LABEL: Record<NotificationType, string> = {
  STOCK_ADJUSTMENT: "تعديل على المخزون",
  DELIVERY_CONFIRM_REQUESTED: "يرجى تأكيد استلام طلبك",
  NOT_RECEIVED_REPORTED: "بلاغ عدم استلام على أحد الطلبات",
  ORDER_AUTO_CONFIRMED: "تم تأكيد استلام طلبك تلقائياً",
  DELIVERY_CONFIRM_REMINDER: "تذكير بتأكيد استلام طلبك",
  VENDOR_SUSPENDED: "تم تعليق متجرك",
  VENDOR_REACTIVATED: "تمت إعادة تفعيل متجرك",
  NEW_ORDER_FOR_EMPLOYEE: "طلب جديد في فرعك",
  LOW_STOCK_AFTER_RESERVE: "المخزون منخفض على أحد المنتجات",
  FOLLOWED_STORE_NEW_PRODUCT: "منتج جديد من متجر تتابعينه",
  FOLLOWED_STORE_DISCOUNT: "خصم جديد من متجر تتابعينه",
};

const STOCK_REASON_LABEL: Record<string, string> = {
  DAMAGE: "تلف",
  LOSS: "فقدان",
  COUNT_CORRECTION: "تصحيح جرد",
};

/** The one-line detail under the type label, built only from the
 * whitelisted `data` fields the relay's own buildSafeData() allows
 * through - never free text (see that function's comment). */
export function notificationDetail(n: NotificationDto): string | null {
  switch (n.type) {
    case "STOCK_ADJUSTMENT": {
      const reason = String(n.data.reason ?? "");
      return STOCK_REASON_LABEL[reason] ? `السبب: ${STOCK_REASON_LABEL[reason]}` : null;
    }
    case "VENDOR_SUSPENDED": {
      const code = String(n.data.reason_code ?? "");
      return SUSPENSION_REASON_LABEL[code] ? `السبب: ${SUSPENSION_REASON_LABEL[code]}` : null;
    }
    case "LOW_STOCK_AFTER_RESERVE": {
      const remaining = n.data.remaining_quantity;
      return typeof remaining === "number" ? `الكمية المتبقية: ${remaining}` : null;
    }
    default:
      return null;
  }
}

/** Where tapping a notification should go. A few types (the two
 * followed-store ones) only carry a vendor_id, not a slug, so they fall
 * back to "أتابعه" rather than guessing a broken store URL. */
export function notificationHref(n: NotificationDto): string {
  switch (n.type) {
    case "STOCK_ADJUSTMENT":
    case "LOW_STOCK_AFTER_RESERVE":
      return n.vendor_id && n.branch_id
        ? `/vendor/${n.vendor_id}/branches/${n.branch_id}/stock`
        : "/account";
    case "NOT_RECEIVED_REPORTED":
      return n.vendor_id ? `/vendor/${n.vendor_id}/orders` : "/orders";
    case "NEW_ORDER_FOR_EMPLOYEE":
      return n.vendor_id && n.branch_id
        ? `/vendor/${n.vendor_id}/branches/${n.branch_id}/orders`
        : "/account";
    case "VENDOR_SUSPENDED":
    case "VENDOR_REACTIVATED":
      return n.vendor_id ? `/vendor/${n.vendor_id}` : "/account";
    case "FOLLOWED_STORE_NEW_PRODUCT":
    case "FOLLOWED_STORE_DISCOUNT":
      return "/following";
    case "DELIVERY_CONFIRM_REQUESTED":
    case "ORDER_AUTO_CONFIRMED":
    case "DELIVERY_CONFIRM_REMINDER":
    default:
      return "/orders";
  }
}
