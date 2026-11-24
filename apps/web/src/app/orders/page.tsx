"use client";

import ColorDot from "@/components/ColorDot";
import { colorDisplayName } from "@/lib/colorName";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch, ApiError, newIdempotencyKey } from "@/lib/api";
import { orderListLoadError } from "@/lib/orders";
import { clearSession, getSessionToken } from "@/lib/session";
import ChangeAddressPanel from "@/components/ChangeAddressPanel";
import ReviewComposer, { type ComposerTarget } from "@/components/ReviewComposer";
import ReturnsListPage from "@/app/returns/page";
import { useT } from "@/lib/useLang";
import { MenuIcon } from "@/components/Icons";
import SizeGuideSnapshotNote from "@/components/SizeGuideSnapshotNote";
import type { SizeGuideSnapshot } from "@/lib/sizeGuides";
import { registerTranslations } from "@/lib/i18n";
import { useLang } from "@/lib/useLang";
import { useTaxonomy } from "@/lib/taxonomy";
import { colorName, pickText, sizeName } from "@/lib/localized";
import { fmt } from "@/lib/shopText";
import { type UiMsg, uiMsgText } from "@/lib/storeText";

import { loginHref } from "@/lib/loginRedirect";

// TB-25: the orders page's own words (Arabic unchanged). Store, branch and
// address names, the cancellation reason and the customer's own notes are
// data and are shown as written.
registerTranslations({
  ar: {
    "ord.status.PLACED": "قيد الانتظار",
    "ord.status.PREPARING": "قيد التجهيز",
    // «إدارة طلبات الفرع v2» phase 2: her pickup order is ready at the branch
    "ord.ready_for_pickup": "جاهز للاستلام",
    "ord.ready_for_pickup_hint": "طلبكِ جاهز في الفرع - اعرضي رمز الاستلام عند الوصول.",
    "ord.status.SENT": "أُرسل",
    "ord.status.DELIVERED": "تم التوصيل - بانتظار تأكيدك",
    "ord.status.PICKED_UP": "تم الاستلام",
    "ord.status.COMPLETED": "مكتمل",
    "ord.status.CANCELLED": "ملغى",
    "ord.status.REFUNDED": "مسترد",
    "ord.status.DELIVERY_FAILED": "تعذّر التوصيل",
    "ord.status.REFUND_REQUESTED": "طلب استرداد - بانتظار المتجر",
    "ord.day.0": "الأحد", "ord.day.1": "الاثنين", "ord.day.2": "الثلاثاء", "ord.day.3": "الأربعاء",
    "ord.day.4": "الخميس", "ord.day.5": "الجمعة", "ord.day.6": "السبت",
    "ord.err.confirm": "تعذّر تأكيد الاستلام",
    "ord.err.reason_required": "يرجى كتابة سبب عدم الاستلام",
    "ord.err.report": "تعذّر إرسال البلاغ",
    "ord.err.cancel": "تعذّر إلغاء الطلب",
    "ord.err.cancel_item": "تعذّر إلغاء هذا المنتج",
    "ord.err.reschedule_required": "يرجى إدخال رقم نافذة التوصيل والتاريخ الجديدين",
    "ord.err.reschedule": "تعذّر تحديد موعد جديد",
    "ord.err.refund": "تعذّر إرسال طلب الاسترداد",
    "ord.loading": "جارٍ التحميل...",
    "ord.title": "طلباتي",
    "ord.subtitle": "كل طلباتك ومتابعة حالتها من المتاجر.",
    "ord.none": "لا توجد طلبات بعد.",
    "ord.branch": "فرع: {name}",
    "ord.cancelled_tag": " (أُلغي)",
    "ord.cancel_item": "إلغاء هذا المنتج",
    "ord.noun.PRODUCT": "المنتج",
    "ord.noun.STORE": "المتجر",
    "ord.review.PRODUCT": "قيّمي المنتج",
    "ord.review.STORE": "قيّمي المتجر",
    "ord.review_deleted": "حذفتِ تقييم {noun}",
    "ord.review_hidden": "أخفت الإدارة تقييمك لـ{noun}",
    "ord.review_edit": "تعديل تقييم {noun} (حتى {date})",
    "ord.review_yours": "تقييمك لـ{noun} ✓",
    "ord.color": "اللون: {v}",
    "ord.size": "المقاس: {v}",
    "ord.pickup": "استلام من المحل",
    "ord.delivery": "توصيل",
    "ord.pay_online": "دفع إلكتروني",
    "ord.pay_cod": "دفع عند الاستلام",
    "ord.slot": "موعد التوصيل: {day} {date} من {from} إلى {to}",
    "ord.address": "عنوان التوصيل: {label}",
    "ord.no_label": "بدون تسمية",
    "ord.pickup_code": "رمز الاستلام: {code}",
    "ord.subtotal": "المجموع الفرعي {n} ₪",
    "ord.plus_fee": " + رسوم توصيل {n} ₪",
    "ord.amount_due": "المبلغ المطلوب تحصيله عند الاستلام: {n} ₪",
    "ord.refunded": "تم استرداد {n} ₪",
    "ord.remaining": " — المتبقي {n} ₪",
    "ord.cancel_reason": "سبب الإلغاء: {r}",
    "ord.your_note": "ملاحظتك للمتجر: {n}",
    "ord.failed": "تعذّر توصيل الطلب (محاولة {n}).",
    "ord.failed_reschedule": " يمكنك تحديد موعد جديد خلال 48 ساعة، وإلا سيُلغى/يُسترد تلقائياً.",
    "ord.failed_refund": " يمكنك الآن طلب استرداد المبلغ.",
    "ord.cancel_order": "إلغاء الطلب",
    "ord.new_slot": "تحديد موعد توصيل جديد:",
    "ord.window_id": "رقم نافذة التوصيل",
    "ord.confirm_slot": "تأكيد الموعد الجديد",
    "ord.request_refund": "طلب استرداد المبلغ",
    "ord.refund_sent": "تم إرسال طلب الاسترداد، بانتظار موافقة المتجر.",
    "ord.confirm_received": "تأكيد استلام الطلب",
    "ord.not_received_reason": "سبب عدم الاستلام",
    "ord.not_received": "لم يصلني الطلب",
    "ord.reported": "تم إبلاغ المتجر بعدم استلام الطلب («{reason}»). لا يوجد نظام شكاوى داخل المنصة - يرجى التواصل مع المتجر مباشرة لحل المشكلة.",
    "ord.open_store": "فتح صفحة المتجر والتواصل",
    "ord.close": "إغلاق",
  },
  en: {
    "ord.status.PLACED": "Placed",
    "ord.status.PREPARING": "Being prepared",
    "ord.ready_for_pickup": "Ready for pickup",
    "ord.ready_for_pickup_hint": "Your order is ready at the branch - show your pickup code when you arrive.",
    "ord.status.SENT": "Sent",
    "ord.status.DELIVERED": "Delivered - awaiting your confirmation",
    "ord.status.PICKED_UP": "Picked up",
    "ord.status.COMPLETED": "Completed",
    "ord.status.CANCELLED": "Cancelled",
    "ord.status.REFUNDED": "Refunded",
    "ord.status.DELIVERY_FAILED": "Delivery failed",
    "ord.status.REFUND_REQUESTED": "Refund requested - awaiting the store",
    "ord.day.0": "Sunday", "ord.day.1": "Monday", "ord.day.2": "Tuesday", "ord.day.3": "Wednesday",
    "ord.day.4": "Thursday", "ord.day.5": "Friday", "ord.day.6": "Saturday",
    "ord.err.confirm": "Couldn't confirm receipt",
    "ord.err.reason_required": "Please write why you didn't receive it",
    "ord.err.report": "Couldn't send the report",
    "ord.err.cancel": "Couldn't cancel the order",
    "ord.err.cancel_item": "Couldn't cancel this product",
    "ord.err.reschedule_required": "Please enter the new delivery window number and date",
    "ord.err.reschedule": "Couldn't set a new time",
    "ord.err.refund": "Couldn't send the refund request",
    "ord.loading": "Loading...",
    "ord.title": "My orders",
    "ord.subtitle": "All your orders and their status from the stores.",
    "ord.none": "No orders yet.",
    "ord.branch": "Branch: {name}",
    "ord.cancelled_tag": " (cancelled)",
    "ord.cancel_item": "Cancel this product",
    "ord.noun.PRODUCT": "the product",
    "ord.noun.STORE": "the store",
    "ord.review.PRODUCT": "Review the product",
    "ord.review.STORE": "Review the store",
    "ord.review_deleted": "You deleted your review of {noun}",
    "ord.review_hidden": "The platform hid your review of {noun}",
    "ord.review_edit": "Edit your review of {noun} (until {date})",
    "ord.review_yours": "Your review of {noun} ✓",
    "ord.color": "Colour: {v}",
    "ord.size": "Size: {v}",
    "ord.pickup": "Pickup from the shop",
    "ord.delivery": "Delivery",
    "ord.pay_online": "Online payment",
    "ord.pay_cod": "Pay on delivery",
    "ord.slot": "Delivery time: {day} {date} from {from} to {to}",
    "ord.address": "Delivery address: {label}",
    "ord.no_label": "Unnamed",
    "ord.pickup_code": "Pickup code: {code}",
    "ord.subtotal": "Subtotal ₪{n}",
    "ord.plus_fee": " + delivery fee ₪{n}",
    "ord.amount_due": "Amount to pay on delivery: ₪{n}",
    "ord.refunded": "₪{n} refunded",
    "ord.remaining": " — ₪{n} remaining",
    "ord.cancel_reason": "Cancellation reason: {r}",
    "ord.your_note": "Your note to the store: {n}",
    "ord.failed": "The order couldn't be delivered (attempt {n}).",
    "ord.failed_reschedule": " You can set a new time within 48 hours, otherwise it's cancelled/refunded automatically.",
    "ord.failed_refund": " You can now request a refund.",
    "ord.cancel_order": "Cancel order",
    "ord.new_slot": "Set a new delivery time:",
    "ord.window_id": "Delivery window number",
    "ord.confirm_slot": "Confirm the new time",
    "ord.request_refund": "Request a refund",
    "ord.refund_sent": "Refund request sent, awaiting the store's approval.",
    "ord.confirm_received": "Confirm I received the order",
    "ord.not_received_reason": "Why you didn't receive it",
    "ord.not_received": "I didn't receive the order",
    "ord.reported": "The store was told you didn't receive the order («{reason}»). There's no complaints system on the platform - please contact the store directly to resolve it.",
    "ord.open_store": "Open the store page to get in touch",
    "ord.close": "Close",
  },
});

interface OrderItem {
  id: string;
  offer_variant_id: string;
  title_ar: string;
  title_en: string;
  quantity: number;
  unit_price: number;
  cancelled_at: string | null;
  // PD-3: the purchase snapshot (null on older orders) and review state.
  color_label?: string | null;
  size_label?: string | null;
  // TB-25.2: the snapshot's taxonomy codes (named by language on the web).
  color_code?: string | null;
  size_code?: string | null;
  /** Product colours: the colour as bought (older lines: the label above, no swatch). */
  color_name_ar?: string | null;
  color_name_en?: string | null;
  color_hex?: string | null;
  color_swatch_url?: string | null;
  // PD-4: the size-guide version this line was bought under.
  size_guide?: SizeGuideSnapshot | null;
  review?: {
    eligible: boolean;
    product_reviewable: boolean;
    product: ReviewSlot | null;
    store: ReviewSlot | null;
  };
}

interface ReviewSlot {
  id: string;
  deleted: boolean;
  hidden: boolean;
  editable_until: string;
  can_edit: boolean;
}

interface DeliveryWindowInfo {
  day_of_week: number;
  start_time: string;
  end_time: string;
}

interface AddressInfo {
  label: string | null;
  lat: number;
  lng: number;
  landmark_note: string | null;
  phone_number_1: string;
  phone_number_2: string | null;
  zone: string | null;
}

interface OrderDto {
  id: string;
  vendor_id: string;
  vendor_display_name: string;
  vendor_slug: string;
  branch_id: string;
  branch_name: string;
  status: string;
  /** phase 2: her PICKUP order is ready at the branch (a flag only) */
  ready_for_pickup?: boolean;
  fulfilment_method: string;
  payment_method: string;
  delivery_attempt_count: number;
  items: OrderItem[];
  subtotal: number;
  delivery_fee: number | null;
  total: number;
  amount_due: number | null;
  amount_refunded: number | null;
  amount_refundable_remaining: number | null;
  cancellation_reason: string | null;
  delivery_failed_at: string | null;
  slot_missed_at: string | null;
  cod_collected_amount: number | null;
  cod_collected_at: string | null;
  scheduled_date: string | null;
  delivery_window: DeliveryWindowInfo | null;
  address: AddressInfo | null;
  pickup_code: string | null;
  delivered_at: string | null;
  not_received_reported_at: string | null;
  not_received_reason: string | null;
  // Sprint 20b (FR-CART-014): read-only - the note the customer
  // themselves entered at checkout. Never internal_store_note, which
  // this DTO never carries at all.
  customer_note: string | null;
  confirm_reminder_sent_at: string | null;
  created_at: string;
}

// TB-25: status and day names are ord.status.<STATUS> and ord.day.<0-6>.

// Sprint 11 (RB-ORD-005, PDR-026, §3.4): the customer's own cross-store
// Orders experience - one card per BranchOrder, never merging two
// branches of the same store, exactly matching the API's own grouping
// (each row IS one BranchOrder already).
// The same customer-order experience is also mounted in the private
// shopping profile. `embedded` changes only the surrounding chrome: all
// order data and every customer action remain exactly the same.
export default function OrdersPage({ embedded = false, context = "profile" }: { embedded?: boolean; context?: "profile" | "cart" }) {
  const t = useT();
  const lang = useLang();
  const taxonomy = useTaxonomy().data;
  const router = useRouter();
  /** TB-25: an order line's colour and size in the interface language (the snapshot label as the fallback). */
  // Product colours: the name as bought (English empty -> the Arabic one); older lines: the family's, by language.
  const lineColor = (it: OrderItem) =>
    it.color_name_en || (it.color_name_ar && it.color_name_ar !== it.color_label)
      ? colorDisplayName({ name_ar: it.color_name_ar ?? it.color_label ?? "", name_en: it.color_name_en }, lang)
      : colorName(taxonomy, it.color_code, lang, it.color_label ?? null);
  const lineSize = (it: OrderItem) => (it.size_code ? sizeName(it.size_code, it.size_label, lang) : it.size_label ?? null);
  const embeddedInCart = embedded && context === "cart";
  const embeddedClass = embeddedInCart ? "cart-orders" : "shopping-profile-orders";
  const loginNext = embeddedInCart ? "/cart?tab=orders" : embedded ? "/profile?tab=favorites" : "/orders";
  const [orders, setOrders] = useState<OrderDto[] | null>(null);
  const [error, setError] = useState<UiMsg | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reportDrafts, setReportDrafts] = useState<Record<string, string>>({});
  const [rescheduleDrafts, setRescheduleDrafts] = useState<
    Record<string, { windowId: string; date: string }>
  >({});
  const [returnsOpen, setReturnsOpen] = useState(false);
  // PD-3: the write/edit review panel, opened over this page.
  const [composer, setComposer] = useState<ComposerTarget | null>(null);

  useEffect(() => {
    if (!returnsOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setReturnsOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [returnsOpen]);

  function load() {
    apiFetch<OrderDto[]>("/customers/me/orders")
      .then(setOrders)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          router.replace(loginHref(loginNext));
          return;
        }
        setError({ text: orderListLoadError(err, lang) });
      });
  }

  useEffect(() => {
    if (!embedded) {
      router.replace("/cart?tab=orders");
      return;
    }
    if (!getSessionToken()) {
      router.replace(loginHref(loginNext));
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, embedded]);

  async function confirmReceived(orderId: string) {
    setBusyId(orderId);
    setError(null);
    try {
      await apiFetch(`/customers/me/orders/${orderId}/confirm-received`, {
        method: "POST",
      });
      load();
    } catch (err) {
      setError({ api: err, key: "ord.err.confirm" });
    } finally {
      setBusyId(null);
    }
  }

  async function reportNotReceived(orderId: string) {
    const reason = (reportDrafts[orderId] ?? "").trim();
    if (!reason) {
      setError({ key: "ord.err.reason_required" });
      return;
    }
    setBusyId(orderId);
    setError(null);
    try {
      await apiFetch(`/customers/me/orders/${orderId}/report-not-received`, {
        method: "POST",
        body: { reason },
      });
      load();
    } catch (err) {
      setError({ api: err, key: "ord.err.report" });
    } finally {
      setBusyId(null);
    }
  }

  // Sprint 20a (PDR-028/025/027): cancel/cancel-item/reschedule/
  // request-refund all require an Idempotency-Key (financial/capacity-
  // locking writes) - every call below sends a fresh one.
  async function cancelWholeOrder(orderId: string) {
    setBusyId(orderId);
    setError(null);
    try {
      await apiFetch(`/customers/me/orders/${orderId}/cancel`, {
        method: "POST",
        idempotencyKey: newIdempotencyKey("customer-cancel"),
      });
      load();
    } catch (err) {
      setError({ api: err, key: "ord.err.cancel" });
    } finally {
      setBusyId(null);
    }
  }

  async function cancelItem(orderId: string, itemId: string) {
    setBusyId(orderId);
    setError(null);
    try {
      await apiFetch(`/customers/me/orders/${orderId}/items/${itemId}/cancel`, {
        method: "POST",
        idempotencyKey: newIdempotencyKey("customer-cancel-item"),
      });
      load();
    } catch (err) {
      setError({ api: err, key: "ord.err.cancel_item" });
    } finally {
      setBusyId(null);
    }
  }

  async function rescheduleOrder(orderId: string) {
    const draft = rescheduleDrafts[orderId];
    if (!draft?.windowId.trim() || !draft?.date.trim()) {
      setError({ key: "ord.err.reschedule_required" });
      return;
    }
    setBusyId(orderId);
    setError(null);
    try {
      await apiFetch(`/customers/me/orders/${orderId}/reschedule`, {
        method: "POST",
        body: {
          delivery_window_id: draft.windowId.trim(),
          scheduled_date: draft.date.trim(),
        },
        idempotencyKey: newIdempotencyKey("customer-reschedule"),
      });
      load();
    } catch (err) {
      setError({ api: err, key: "ord.err.reschedule" });
    } finally {
      setBusyId(null);
    }
  }

  async function requestRefund(orderId: string) {
    setBusyId(orderId);
    setError(null);
    try {
      await apiFetch(`/customers/me/orders/${orderId}/request-refund`, {
        method: "POST",
        idempotencyKey: newIdempotencyKey("customer-request-refund"),
      });
      load();
    } catch (err) {
      setError({ api: err, key: "ord.err.refund" });
    } finally {
      setBusyId(null);
    }
  }

  if (!embedded) {
    return <main className="cart-page page-shell"><div className="skeleton" style={{ height: 180, width: "100%", maxWidth: 720 }} /></main>;
  }

  if (error && !orders) {
    return (
      <div className={embedded ? embeddedClass : "page-shell"}>
        <div className="error-banner" style={{ maxWidth: 720 }}>{uiMsgText(error, lang)}</div>
      </div>
    );
  }

  if (!orders) {
    return (
      <div className={embedded ? embeddedClass : "page-shell"}>
        <p className="muted">{t("ord.loading")}</p>
      </div>
    );
  }

  return (
    <div className={embedded ? embeddedClass : "page-shell"}>
      {!embedded && (
        <div className="top-bar">
          <div className="brand" style={{ margin: 0 }}>{t("ord.title")}</div>
          {/* TB-16.2: only the two return entry points of this page are bilingual. */}
          <Link href="/returns" className="button-link">{t("ret.my_returns")}</Link>
        </div>
      )}
      {embedded && (
        <div className={embeddedInCart ? "cart-orders-head" : "shopping-profile-orders-head"}>
          <button type="button" className="shopping-profile-returns-trigger" onClick={() => setReturnsOpen(true)} aria-label={t("ret.entry.open_my_returns")} aria-haspopup="dialog">
            <MenuIcon />
          </button>
          {!embeddedInCart && <span>{t("ord.subtitle")}</span>}
        </div>
      )}

      {error && <div className="error-banner" style={{ maxWidth: 720 }}>{uiMsgText(error, lang)}</div>}
      {orders.length === 0 && <p className="muted">{t("ord.none")}</p>}

      <div className="customer-orders-list" style={{ maxWidth: 720, width: "100%", display: "flex", flexDirection: "column", gap: 14 }}>
        {orders.map((o) => {
          const awaitingConfirm =
            o.status === "DELIVERED" && o.fulfilment_method === "DELIVERY";
          const hasOpenReport = !!o.not_received_reported_at;
          return (
            <div key={o.id} className="card customer-order-card" data-order-id={o.id}>
              <div className="customer-order-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div className="customer-order-vendor">
                  <div style={{ fontWeight: 600 }}>{o.vendor_display_name}</div>
                  <div className="muted">{fmt(t("ord.branch"), { name: o.branch_name })}</div>
                </div>
                {o.ready_for_pickup ? (
                  <span className="badge badge-active customer-order-ready" data-testid="customer-order-ready">{t("ord.ready_for_pickup")}</span>
                ) : (
                  <span className="badge badge-active">{t(`ord.status.${o.status}`) === `ord.status.${o.status}` ? o.status : t(`ord.status.${o.status}`)}</span>
                )}
              </div>
              {o.ready_for_pickup && <p className="customer-order-ready-hint" role="note">{t("ord.ready_for_pickup_hint")}</p>}

              <div className="customer-order-overview">
              <div className="customer-order-items" style={{ marginTop: 10 }}>
                {o.items.map((it) => (
                  <div
                    key={it.id}
                    className="muted customer-order-item"
                    style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}
                  >
                    <span style={{ textDecoration: it.cancelled_at ? "line-through" : "none" }}>
                      {pickText(lang, it.title_en, it.title_ar)} × {it.quantity} — {it.unit_price} ₪
                      {(lineColor(it) || lineSize(it)) && (
                        <small className="customer-order-variant">
                          {" · "}
                          {lineColor(it) && (
                            <ColorDot
                              swatchUrl={it.color_swatch_url}
                              hex={it.color_hex}
                              familyHex={taxonomy?.colors.find((c) => c.code === it.color_code)?.hex}
                            />
                          )}
                          {[lineColor(it), lineSize(it)].filter(Boolean).join(" / ")}
                        </small>
                      )}
                      {it.cancelled_at ? t("ord.cancelled_tag") : ""}
                      <SizeGuideSnapshotNote snapshot={it.size_guide} />
                    </span>
                    {o.status === "PLACED" && !it.cancelled_at && o.items.length > 1 && (
                      <button
                        className="button-link"
                        disabled={busyId === o.id}
                        onClick={() => cancelItem(o.id, it.id)}
                      >
                        {t("ord.cancel_item")}
                      </button>
                    )}
                    {!it.cancelled_at &&
                      ["DELIVERED", "PICKED_UP", "COMPLETED"].includes(o.status) && (
                        <Link
                          href={`/orders/${o.id}/items/${it.id}/return`}
                          className="button-link"
                        >
                          {t("ret.entry.request")}
                        </Link>
                      )}
                    {it.review?.eligible && (
                      <span className="customer-order-reviews">
                        {(["PRODUCT", "STORE"] as const).map((target) => {
                          if (target === "PRODUCT" && !it.review!.product_reviewable) return null;
                          const slot = target === "PRODUCT" ? it.review!.product : it.review!.store;
                          const noun = t(`ord.noun.${target}`);
                          if (!slot) {
                            return (
                              <button
                                key={target}
                                type="button"
                                className="customer-order-review-cta"
                                onClick={() =>
                                  setComposer({
                                    mode: "create",
                                    itemId: it.id,
                                    target,
                                    title: target === "PRODUCT" ? pickText(lang, it.title_en, it.title_ar) : o.vendor_display_name,
                                    purchased: [lineColor(it) && fmt(t("ord.color"), { v: lineColor(it)! }), lineSize(it) && fmt(t("ord.size"), { v: lineSize(it)! })].filter(Boolean).join(" · ") || null,
                                  })
                                }
                              >
                                {t(`ord.review.${target}`)}
                              </button>
                            );
                          }
                          if (slot.deleted) return <span key={target} className="customer-order-review-state">{fmt(t("ord.review_deleted"), { noun })}</span>;
                          if (slot.hidden) return <span key={target} className="customer-order-review-state">{fmt(t("ord.review_hidden"), { noun })}</span>;
                          return (
                            <button key={target} type="button" className="button-link" onClick={() => setComposer({ mode: "edit", reviewId: slot.id })}>
                              {slot.can_edit
                                ? fmt(t("ord.review_edit"), { noun, date: new Date(slot.editable_until).toLocaleDateString(lang === "en" ? "en-GB" : "ar-EG", { day: "numeric", month: "short" }) })
                                : fmt(t("ord.review_yours"), { noun })}
                            </button>
                          );
                        })}
                      </span>
                    )}
                  </div>
                ))}
              </div>

              <div className="muted customer-order-fulfilment" style={{ marginTop: 8 }}>
                {o.fulfilment_method === "PICKUP" ? t("ord.pickup") : t("ord.delivery")}
                {" · "}
                {o.payment_method === "ONLINE" ? t("ord.pay_online") : t("ord.pay_cod")}
              </div>

              {o.delivery_window && o.scheduled_date && (
                <div className="muted customer-order-detail">
                  {fmt(t("ord.slot"), { day: t(`ord.day.${o.delivery_window.day_of_week}`), date: o.scheduled_date, from: o.delivery_window.start_time, to: o.delivery_window.end_time })}
                </div>
              )}

              {o.address && (
                <div className="muted customer-order-detail">
                  {fmt(t("ord.address"), { label: o.address.label ?? t("ord.no_label") })}
                  {o.address.landmark_note ? ` — ${o.address.landmark_note}` : ""}
                </div>
              )}

              {o.pickup_code && (
                <div className="customer-order-pickup-code" style={{ fontWeight: 600, marginTop: 6 }}>{fmt(t("ord.pickup_code"), { code: o.pickup_code })}</div>
              )}

              <div className="customer-order-total" style={{ display: "flex", justifyContent: "space-between", marginTop: 10 }}>
                <span className="muted">
                  {fmt(t("ord.subtotal"), { n: o.subtotal })}
                  {o.delivery_fee !== null ? fmt(t("ord.plus_fee"), { n: o.delivery_fee }) : ""}
                </span>
                <span className="product-card-price">{o.total} ₪</span>
              </div>
              {o.payment_method === "COD" && o.amount_due !== null && (
                <div className="muted customer-order-detail">{fmt(t("ord.amount_due"), { n: o.amount_due })}</div>
              )}
              {o.payment_method === "ONLINE" && (o.amount_refunded ?? 0) > 0 && (
                <div className="muted customer-order-detail">
                  {fmt(t("ord.refunded"), { n: o.amount_refunded ?? 0 })}
                  {o.amount_refundable_remaining ? fmt(t("ord.remaining"), { n: o.amount_refundable_remaining }) : ""}
                </div>
              )}
              {o.cancellation_reason && (
                <div className="muted customer-order-detail">{fmt(t("ord.cancel_reason"), { r: o.cancellation_reason })}</div>
              )}
              {o.customer_note && (
                <div className="muted customer-order-detail">{fmt(t("ord.your_note"), { n: o.customer_note })}</div>
              )}
              </div>

              {o.status === "DELIVERY_FAILED" && (
                <div className="error-banner" style={{ marginTop: 10 }}>
                  {fmt(t("ord.failed"), { n: o.delivery_attempt_count })}
                  {o.delivery_attempt_count < 2
                    ? t("ord.failed_reschedule")
                    : o.payment_method === "ONLINE"
                      ? t("ord.failed_refund")
                      : ""}
                </div>
              )}

              {o.status === "PLACED" && (
                <div className="customer-order-actions" style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                  <button
                    className="button button-secondary"
                    disabled={busyId === o.id}
                    onClick={() => cancelWholeOrder(o.id)}
                  >
                    {t("ord.cancel_order")}
                  </button>
                  {/* Sprint 22 (PDR-029): new feature on this existing
                      page - its own UI text is bilingual, the
                      surrounding page stays as-is. */}
                  {o.fulfilment_method === "DELIVERY" && (
                    <ChangeAddressPanel
                      branchOrderId={o.id}
                      onCancelOrder={() => cancelWholeOrder(o.id)}
                      onChanged={load}
                    />
                  )}
                </div>
              )}

              {((o.slot_missed_at && (o.status === "PLACED" || o.status === "PREPARING")) ||
                (o.status === "DELIVERY_FAILED" && o.delivery_attempt_count < 2)) && (
                <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                  <div className="muted">{t("ord.new_slot")}</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      placeholder={t("ord.window_id")}
                      style={{ flex: 1 }}
                      value={rescheduleDrafts[o.id]?.windowId ?? ""}
                      onChange={(e) =>
                        setRescheduleDrafts((prev) => ({
                          ...prev,
                          [o.id]: { ...(prev[o.id] ?? { windowId: "", date: "" }), windowId: e.target.value },
                        }))
                      }
                    />
                    <input
                      placeholder="YYYY-MM-DD"
                      style={{ flex: 1 }}
                      value={rescheduleDrafts[o.id]?.date ?? ""}
                      onChange={(e) =>
                        setRescheduleDrafts((prev) => ({
                          ...prev,
                          [o.id]: { ...(prev[o.id] ?? { windowId: "", date: "" }), date: e.target.value },
                        }))
                      }
                    />
                    <button
                      className="button"
                      disabled={busyId === o.id}
                      onClick={() => rescheduleOrder(o.id)}
                    >
                      {t("ord.confirm_slot")}
                    </button>
                  </div>
                </div>
              )}

              {o.status === "DELIVERY_FAILED" &&
                o.delivery_attempt_count >= 2 &&
                o.payment_method === "ONLINE" && (
                  <div style={{ marginTop: 12 }}>
                    <button
                      className="button"
                      disabled={busyId === o.id}
                      onClick={() => requestRefund(o.id)}
                    >
                      {t("ord.request_refund")}
                    </button>
                  </div>
                )}

              {o.status === "REFUND_REQUESTED" && (
                <div className="muted" style={{ marginTop: 10 }}>
                  {t("ord.refund_sent")}
                </div>
              )}

              {awaitingConfirm && !hasOpenReport && (
                <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                  <button
                    className="button"
                    disabled={busyId === o.id}
                    onClick={() => confirmReceived(o.id)}
                  >
                    {t("ord.confirm_received")}
                  </button>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      placeholder={t("ord.not_received_reason")}
                      style={{ flex: 1 }}
                      value={reportDrafts[o.id] ?? ""}
                      onChange={(e) =>
                        setReportDrafts((prev) => ({ ...prev, [o.id]: e.target.value }))
                      }
                    />
                    <button
                      className="button-link"
                      disabled={busyId === o.id}
                      onClick={() => reportNotReceived(o.id)}
                    >
                      {t("ord.not_received")}
                    </button>
                  </div>
                </div>
              )}

              {hasOpenReport && (
                <div className="error-banner" style={{ marginTop: 12 }}>
                  <div>
                    {fmt(t("ord.reported"), { reason: o.not_received_reason ?? "" })}
                  </div>
                  <Link
                    href={`/store/${o.vendor_slug}`}
                    className="button"
                    style={{ display: "inline-block", marginTop: 8 }}
                  >
                    {t("ord.open_store")}
                  </Link>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {composer && (
        <ReviewComposer target={composer} onClose={() => setComposer(null)} onSaved={() => load()} />
      )}
      {embedded && returnsOpen && (
        <div className="shopping-profile-returns-overlay" role="presentation" onMouseDown={() => setReturnsOpen(false)}>
          <section className="shopping-profile-returns-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-returns-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="shopping-profile-returns-dialog-head">
              <h2 id="profile-returns-title">{t("ret.my_returns")}</h2>
              <button type="button" onClick={() => setReturnsOpen(false)} aria-label={t("ord.close")}>×</button>
            </div>
            <ReturnsListPage embedded />
          </section>
        </div>
      )}
    </div>
  );
}
