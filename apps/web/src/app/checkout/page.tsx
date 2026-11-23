"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import AddressForm, { SavedAddress } from "@/components/AddressForm";
import SandboxCardForm from "@/components/SandboxCardForm";
import { apiFetch, ApiError, newIdempotencyKey } from "@/lib/api";
import { formatDelta, hasChanges, parsePriceChange, PriceChangeSummary } from "@/lib/price-change";
import { CardResult, declineMessage, SandboxCardToken } from "@/lib/sandbox-card";
import { allGroupsFulfillable, availableMethods, coerceMethod, defaultMethod, FulfilmentMethod } from "@/lib/fulfilment";
import { clearSession, getSessionToken } from "@/lib/session";
import { cartQuantityErrorMessage, expiredReservationMessage, replacedReservationNotice, reservationMessage, unitsLimitMessage } from "@/lib/cart";
import { useLang } from "@/lib/useLang";
import type { OpeningState } from "@/lib/branchHours";
import { openingLine, pickupPreparedLine } from "@/lib/branchOpeningText";
import { registerTranslations, translate } from "@/lib/i18n";
import { apiErrorMessage } from "@/lib/apiErrors";
import { pickText } from "@/lib/localized";
import { fmt } from "@/lib/shopText";
import { type UiMsg, uiMsgText } from "@/lib/storeText";
import { loginRedirectHref } from "@/lib/loginRedirect";

// TB-25: the checkout's own words (Arabic unchanged). Branch names are
// data; the server's own blocker sentences stay as they are in Arabic and
// are worded by their code and figures in English.
registerTranslations({
  ar: {
    "co.day.0": "الأحد", "co.day.1": "الاثنين", "co.day.2": "الثلاثاء", "co.day.3": "الأربعاء",
    "co.day.4": "الخميس", "co.day.5": "الجمعة", "co.day.6": "السبت",
    "co.err.quote": "تعذّر تحميل ملخص الطلب",
    "co.err.no_method": "لا توجد طريقة استلام أو توصيل متاحة لأحد الفروع - اختاري فرعاً آخر.",
    "co.err.address_slot": "اختاري عنوان التوصيل والموعد قبل المتابعة.",
    "co.err.terms": "يجب الموافقة على شروط الاستخدام قبل المتابعة.",
    "co.slot.SLOT_NO_LONGER_AVAILABLE": "موعد التوصيل الذي اخترتِه بدأ أو أصبح قريباً جداً على التجهيز - اختاري موعداً لاحقاً.",
    "co.slot.SLOT_CAPACITY_EXCEEDED": "اكتمل حجز موعد التوصيل الذي اخترتِه - اختاري موعداً آخر.",
    "co.slot.SLOT_CLOSED": "الفرع مغلق في هذا اليوم - اختاري موعداً آخر.",
    "co.slot.INVALID_SLOT_DATE": "هذا الموعد لم يعد ضمن الأيام الثلاثة المتاحة - اختاري موعداً آخر.",
    "co.err.reserve": "تعذّر حجز الطلب",
    "co.err.confirm": "تعذّر تأكيد الطلب",
    "co.created": "تم إنشاء الطلب",
    "co.order_n": "طلب #{id}",
    "co.pickup": "استلام من المحل",
    "co.delivery": "توصيل",
    "co.pickup_code": "رمز الاستلام: {code}",
    "co.keep_shopping": "متابعة التسوق",
    "co.loading": "جارٍ التحميل...",
    "co.confirm_title": "تأكيد الطلب",
    "co.prices_changed": "تغيّرت الأسعار منذ حجزك",
    "co.prices_changed_hint": "لم يتم خصم أي مبلغ ولم يُنشأ أي طلب. راجعي الأسعار الجديدة ثم أكملي.",
    "co.product": "منتج",
    "co.delivery_fee": "رسوم التوصيل",
    "co.not_available": "غير متاح",
    "co.review_new_prices": "مراجعة بالأسعار الجديدة",
    "co.cancel_back": "إلغاء والعودة",
    "co.hold_valid": "الحجز صالح لمدة {n} دقيقة تقريباً - أكملي الدفع قبل انتهاء الوقت.",
    "co.total": "الإجمالي: {total} ₪",
    "co.confirm": "تأكيد الطلب",
    "co.title": "إتمام الطلب",
    "co.unavailable_items": "بعض العناصر لم تعد متوفرة بالكمية المطلوبة ولن تُشترى الآن.",
    "co.subtotal": "المجموع الفرعي: {n} ₪",
    "co.fragmented": "تعذّر تغطية كل العناصر من فرع واحد - قُسّمت تلقائياً على أقرب فرع مؤهل.",
    "co.branch": "الفرع",
    "co.method": "طريقة الاستلام",
    "co.no_method_branch": "لا توجد طريقة استلام أو توصيل متاحة لهذا الفرع حالياً - اختاري فرعاً آخر.",
    "co.address": "العنوان",
    "co.pick_address": "اختاري عنواناً",
    "co.no_addresses": "لا توجد عناوين محفوظة بعد.",
    "co.new_address": "+ عنوان جديد",
    "co.slot": "الموعد (خلال الأيام السبعة القادمة)",
    "co.pick_slot": "اختاري موعداً",
    "co.payment": "طريقة الدفع",
    "co.cod": "الدفع عند الاستلام",
    "co.online": "دفع إلكتروني (تجريبي)",
    "co.note": "ملاحظة للمتجر (اختياري)",
    "co.note_placeholder": "مثال: الرجاء الاتصال قبل التوصيل",
    "co.agree": "أوافق على ",
    "co.terms": "شروط الاستخدام",
    "co.continue": "متابعة",
    "co.nothing": "لا توجد عناصر متاحة للمتابعة حالياً.",
    "co.list_sep": "، ",
  },
  en: {
    "co.day.0": "Sunday", "co.day.1": "Monday", "co.day.2": "Tuesday", "co.day.3": "Wednesday",
    "co.day.4": "Thursday", "co.day.5": "Friday", "co.day.6": "Saturday",
    "co.err.quote": "Couldn't load the order summary",
    "co.err.no_method": "One of the branches has no pickup or delivery available - choose another branch.",
    "co.err.address_slot": "Choose the delivery address and time before you continue.",
    "co.err.terms": "You need to accept the terms of use before you continue.",
    "co.slot.SLOT_NO_LONGER_AVAILABLE": "The delivery time you chose has started or is now too close to prepare - choose a later time.",
    "co.slot.SLOT_CAPACITY_EXCEEDED": "The delivery time you chose is fully booked - choose another time.",
    "co.slot.SLOT_CLOSED": "The branch is closed on that day - choose another time.",
    "co.slot.INVALID_SLOT_DATE": "This time is no longer within the three available days - choose another time.",
    "co.err.reserve": "Couldn't hold the order",
    "co.err.confirm": "Couldn't confirm the order",
    "co.created": "Order placed",
    "co.order_n": "Order #{id}",
    "co.pickup": "Pickup from the shop",
    "co.delivery": "Delivery",
    "co.pickup_code": "Pickup code: {code}",
    "co.keep_shopping": "Continue shopping",
    "co.loading": "Loading...",
    "co.confirm_title": "Confirm the order",
    "co.prices_changed": "Prices have changed since your hold",
    "co.prices_changed_hint": "Nothing was charged and no order was created. Review the new prices, then continue.",
    "co.product": "Product",
    "co.delivery_fee": "Delivery fee",
    "co.not_available": "Not available",
    "co.review_new_prices": "Review the new prices",
    "co.cancel_back": "Cancel and go back",
    "co.hold_valid": "The hold is valid for about {n} minutes - complete payment before it runs out.",
    "co.total": "Total: ₪{total}",
    "co.confirm": "Confirm the order",
    "co.title": "Checkout",
    "co.unavailable_items": "Some items are no longer available in the quantity asked for and won't be bought now.",
    "co.subtotal": "Subtotal: ₪{n}",
    "co.fragmented": "Not every item could come from one branch - they were split automatically to the nearest eligible branch.",
    "co.branch": "Branch",
    "co.method": "How you receive it",
    "co.no_method_branch": "This branch has no pickup or delivery available right now - choose another branch.",
    "co.address": "Address",
    "co.pick_address": "Choose an address",
    "co.no_addresses": "No saved addresses yet.",
    "co.new_address": "+ New address",
    "co.slot": "Time (within the next seven days)",
    "co.pick_slot": "Choose a time",
    "co.payment": "Payment method",
    "co.cod": "Pay on delivery",
    "co.online": "Online payment (test)",
    "co.note": "Note for the store (optional)",
    "co.note_placeholder": "For example: please call before delivery",
    "co.agree": "I accept the ",
    "co.terms": "terms of use",
    "co.continue": "Continue",
    "co.nothing": "No items available to continue right now.",
    "co.list_sep": ", ",
    "co.blocker.min": "The minimum order for {method} at this branch is ₪{required} (this order: ₪{current}).",
    "co.blocker.zone": "This branch doesn't deliver to your address's area.",
  },
});

interface QuoteItem {
  cart_item_id: string;
  offer_variant_id: string;
  title_ar: string;
  title_en: string;
  quantity: number;
  unit_price: number;
}
interface SlotOption {
  delivery_window_id: string;
  date: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  remaining_capacity: number;
}
interface MinimumOrderBlocker {
  code: "BELOW_MINIMUM_ORDER_VALUE";
  fulfilment_method: "PICKUP" | "DELIVERY";
  required: number;
  current: number;
  message: string;
}
// Sprint 20b review-round fix (FR-CART-015): a branch whose vendor
// doesn't deliver to the customer's selected zone at all - previously
// only an implicit null on delivery_fee/minimum_order_value.delivery,
// now a real structured blocker rendered the same way as the
// minimum-order one below (generic `fulfilment_method`/`message`
// rendering - see this file's blockers.filter(...).map(...) below).
interface DeliveryNotAvailableBlocker {
  code: "DELIVERY_NOT_AVAILABLE_IN_ZONE";
  fulfilment_method: "DELIVERY";
  message: string;
}
type QuoteBlocker = MinimumOrderBlocker | DeliveryNotAvailableBlocker;
interface EligibleBranch {
  branch_id: string;
  branch_name: string;
  is_physical: boolean;
  /** «ساعات العمل والإغلاقات v1»: open now / next opening (null = no hours set) - never blocks pickup */
  opening?: OpeningState | null;
  delivery_fee: number | null;
  minimum_order_value: { pickup: number | null; delivery: number | null };
  blockers: QuoteBlocker[];
  available_slots: SlotOption[];
}
interface QuoteGroup {
  vendor_id: string;
  cart_item_ids: string[];
  items: QuoteItem[];
  subtotal: number;
  fragmented: boolean;
  eligible_branches: EligibleBranch[];
  suggested_branch_id: string | null;
}
interface QuoteResponse {
  groups: QuoteGroup[];
  unavailable_items: { cart_item_id: string; reason: string }[];
  /** TB-5: the most items one order may hold (reserve() decides). */
  units_limit?: number;
}

interface AddressDto {
  id: string;
  label: string | null;
  landmark_note: string | null;
  zone: string | null;
}

interface GroupChoice {
  branchId: string;
  fulfilmentMethod: FulfilmentMethod | null;
  paymentMethod: "ONLINE" | "COD";
  addressId: string;
  deliveryWindowId: string;
  scheduledDate: string;
  customerNote: string;
}

// Sprint 20b (FR-CART-012, platform terms only): must match the
// backend's own CheckoutService.CURRENT_PLATFORM_TERMS_VERSION
// exactly - reserve() rejects a mismatch outright.
const CURRENT_PLATFORM_TERMS_VERSION = "2026-10-v1";

interface ReserveResponse {
  reservation_id: string;
  expires_at: string;
  items: {
    offer_variant_id: string;
    unit_price: number;
    quantity: number;
    payment_method: "ONLINE" | "COD";
  }[];
  slots: { delivery_fee: number; scheduled_date: string }[];
  /** TB-5: an earlier live hold of this account was released for this one. */
  replaced_previous?: boolean;
}

interface ConfirmedBranchOrder {
  id: string;
  pickup_code: string | null;
  fulfilment_method: string;
  total: number;
}

// TB-25: day names are co.day.<0-6>.

// Sprint 10 (RB-ORD-002): quote (read-only preview) -> the customer
// configures branch/fulfilment/slot/payment per group -> reserve (the
// real 10-minute hold) -> confirm (creates the actual order(s)).
// Deliberately NOT a full Orders UI afterward - just the immediate
// confirmation with pickup codes, per this sprint's own scope note.
export default function CheckoutPage({ embedded = false }: { embedded?: boolean }) {
  const router = useRouter();
  // TB-5: the new hold messages follow the shopper's language.
  const lang = useLang();
  const t = (key: string) => translate(lang, key);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [addresses, setAddresses] = useState<AddressDto[] | null>(null);
  const [choices, setChoices] = useState<Record<string, GroupChoice>>({});
  const [error, setError] = useState<UiMsg | null>(null);
  /** TB-25: a failure worded at render (slot, hold, stock refusals by code; never the server's text in English). */
  const errorText = (m: UiMsg) => {
    if (!("api" in m) || !(m.api instanceof ApiError)) return uiMsgText(m, lang);
    const err = m.api;
    const slotKey = `co.slot.${err.code}`;
    if (t(slotKey) !== slotKey) return t(slotKey);
    return reservationMessage(err.code, err.details, lang) ?? cartQuantityErrorMessage(err.code, err.details, lang) ?? (lang === "ar" ? err.message : apiErrorMessage(err, lang));
  };
  /** A branch blocker: the server's Arabic sentence as before; English worded by its code and figures. */
  const blockerText = (b: QuoteBlocker) => {
    if (lang === "ar") return b.message;
    if (b.code === "BELOW_MINIMUM_ORDER_VALUE") {
      return fmt(t("co.blocker.min"), { method: b.fulfilment_method === "PICKUP" ? "pickup" : "delivery", required: b.required, current: b.current });
    }
    return t("co.blocker.zone");
  };
  const [busy, setBusy] = useState(false);
  const [reservation, setReservation] = useState<ReserveResponse | null>(null);
  const [expiresInMinutes, setExpiresInMinutes] = useState(0);
  // Generated once per reservation, not per confirm() call - a
  // double-click or network retry of the SAME confirm attempt must
  // reuse the same key so the backend's IdempotencyInterceptor can
  // recognize and safely replay it, rather than treating each retry
  // as a brand-new request.
  const [confirmIdempotencyKey, setConfirmIdempotencyKey] = useState("");
  const [confirmed, setConfirmed] = useState<ConfirmedBranchOrder[] | null>(null);
  // Sprint 14: which group is adding a new address inline, the sandbox
  // payment outcome, and the price/fee diff when CHECKOUT_PRICE_CHANGED.
  const [addingAddressFor, setAddingAddressFor] = useState<string | null>(null);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [priceChange, setPriceChange] = useState<PriceChangeSummary | null>(null);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const pageClass = embedded ? "checkout-embedded" : "page-shell";

  function groupKey(g: QuoteGroup): string {
    return `${g.vendor_id}:${g.cart_item_ids.join(",")}`;
  }

  useEffect(() => {
    if (!getSessionToken()) {
      router.replace(loginRedirectHref());
      return;
    }
    const raw = sessionStorage.getItem("checkout_cart_item_ids");
    if (!raw) {
      router.replace("/cart");
      return;
    }
    const cartItemIds: string[] = JSON.parse(raw);

    Promise.all([
      apiFetch<QuoteResponse>("/checkout/quote", {
        method: "POST",
        body: { cart_item_ids: cartItemIds },
      }),
      apiFetch<AddressDto[]>("/customers/me/addresses").catch(() => []),
    ])
      .then(([quoteRes, addressList]) => {
        setQuote(quoteRes);
        setAddresses(addressList);
        const initial: Record<string, GroupChoice> = {};
        for (const g of quoteRes.groups) {
          const branchId = g.suggested_branch_id ?? g.eligible_branches[0]?.branch_id ?? "";
          initial[groupKey(g)] = {
            branchId,
            // A valid default for THIS branch: pick-up if it is physical,
            // otherwise delivery if it has slots, otherwise none.
            fulfilmentMethod: defaultMethod(
              g.eligible_branches.find((b) => b.branch_id === branchId),
            ),
            paymentMethod: "COD",
            addressId: "",
            deliveryWindowId: "",
            scheduledDate: "",
            customerNote: "",
          };
        }
        setChoices(initial);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          router.replace(loginRedirectHref());
          return;
        }
        setError({ api: err, key: "co.err.quote" });
      });
  }, [router]);

  function updateChoice(key: string, patch: Partial<GroupChoice>) {
    setChoices((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  function branchFor(g: QuoteGroup, branchId: string): EligibleBranch | undefined {
    return g.eligible_branches.find((b) => b.branch_id === branchId);
  }

  async function reserve() {
    if (!quote) return;
    if (!allGroupsFulfillable(quote.groups.map((g) => choices[groupKey(g)]?.fulfilmentMethod ?? null))) {
      setError({ key: "co.err.no_method" });
      return;
    }
    for (const g of quote.groups) {
      const choice = choices[groupKey(g)];
      if (
        choice?.fulfilmentMethod === "DELIVERY" &&
        (!choice.addressId || !choice.deliveryWindowId || !choice.scheduledDate)
      ) {
        setError({ key: "co.err.address_slot" });
        return;
      }
    }
    if (!termsAccepted) {
      setError({ key: "co.err.terms" });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const groups = quote.groups.map((g) => {
        const choice = choices[groupKey(g)];
        return {
          cart_item_ids: g.cart_item_ids,
          branch_id: choice.branchId,
          fulfilment_method: choice.fulfilmentMethod as FulfilmentMethod,
          payment_method: choice.paymentMethod,
          ...(choice.customerNote.trim() ? { customer_note: choice.customerNote.trim() } : {}),
          ...(choice.fulfilmentMethod === "DELIVERY"
            ? {
                address_id: choice.addressId,
                delivery_window_id: choice.deliveryWindowId,
                scheduled_date: choice.scheduledDate,
              }
            : {}),
        };
      });
      const res = await apiFetch<ReserveResponse>("/checkout/reserve", {
        method: "POST",
        body: {
          groups,
          terms_accepted: true,
          terms_version: CURRENT_PLATFORM_TERMS_VERSION,
        },
        idempotencyKey: newIdempotencyKey("checkout-reserve"),
      });
      setReservation(res);
      setExpiresInMinutes(
        Math.max(0, Math.round((new Date(res.expires_at).getTime() - Date.now()) / 60000)),
      );
      setConfirmIdempotencyKey(newIdempotencyKey("checkout-confirm"));
    } catch (err) {
      // PD-5.1: the slot rule is the server's - say why a window was refused
      // (co.slot.<code>; worded at render by errorText).
      setError({ api: err, key: "co.err.reserve" });
    } finally {
      setBusy(false);
    }
  }

  async function confirm(card?: CardResult) {
    if (!reservation) return;
    setError(null);
    setPaymentError(null);
    if (card && !card.ok) {
      // Not a sandbox test card / bad expiry / bad CVC: nothing is sent.
      setPaymentError(card.error);
      return;
    }
    const token: SandboxCardToken | undefined = card?.ok ? card.token : undefined;
    setBusy(true);
    try {
      const res = await apiFetch<{ branch_orders: ConfirmedBranchOrder[] }>(
        "/checkout/confirm",
        {
          method: "POST",
          body: {
            reservation_id: reservation.reservation_id,
            ...(token ? { sandbox_card_token: token } : {}),
          },
          idempotencyKey: confirmIdempotencyKey,
        },
      );
      setConfirmed(res.branch_orders);
      sessionStorage.removeItem("checkout_cart_item_ids");
    } catch (err) {
      if (err instanceof ApiError && err.code === "PAYMENT_FAILED") {
        // Nothing was created and the reservation is still held: show
        // why, and use a FRESH idempotency key so the next card is a new
        // attempt rather than a replay of this decline.
        const detail = err.details[0] as { decline_code?: string } | undefined;
        setPaymentError(declineMessage(detail?.decline_code, lang));
        setConfirmIdempotencyKey(newIdempotencyKey("checkout-confirm"));
      } else if (err instanceof ApiError && err.code === "CHECKOUT_PRICE_CHANGED") {
        const summary = parsePriceChange(err.details);
        if (hasChanges(summary)) setPriceChange(summary);
        else setError({ api: err, key: "co.err.confirm" });
      } else if (err instanceof ApiError && err.code === "RESERVATION_EXPIRED") {
        setError({ text: expiredReservationMessage(lang) });
        setReservation(null);
      } else if (err instanceof ApiError && err.code === "RESERVATION_NOT_FOUND") {
        // TB-8: a hold whose known expiry has passed was removed by the
        // expiry sweep - say it expired. Otherwise the server's reason
        // (TB-5: replaced by a newer checkout of this account) decides.
        const expired = new Date(reservation.expires_at).getTime() <= Date.now();
        setError({ text: expired ? expiredReservationMessage(lang) : (reservationMessage(err.code, err.details, lang) ?? t("co.err.confirm")) });
        setReservation(null);
      } else {
        setError({ api: err, key: "co.err.confirm" });
      }
    } finally {
      setBusy(false);
    }
  }

  async function cancelReservationAndRestart() {
    if (reservation) {
      await apiFetch(`/checkout/reservations/${reservation.reservation_id}/cancel`, {
        method: "POST",
      }).catch(() => {});
    }
    setReservation(null);
    setPriceChange(null);
    setPaymentError(null);
  }

  // Sprint 14: after CHECKOUT_PRICE_CHANGED the customer reviews the new
  // prices by releasing the hold and re-quoting the same cart selection.
  async function reviewNewPrices() {
    await cancelReservationAndRestart();
    window.location.reload();
  }

  if (error && !quote) {
    return (
      <div className={pageClass}>
        <div className="error-banner" style={{ maxWidth: 560 }}>{errorText(error)}</div>
      </div>
    );
  }

  if (confirmed) {
    return (
      <div className={pageClass}>
        <div className="top-bar">
          <div className="brand" style={{ margin: 0 }}>{t("co.created")}</div>
        </div>
        <div style={{ maxWidth: 560, width: "100%", display: "flex", flexDirection: "column", gap: 12 }}>
          {confirmed.map((o) => (
            <div key={o.id} className="card">
              <div>{fmt(t("co.order_n"), { id: o.id.slice(0, 8) })}</div>
              <div className="muted">{o.fulfilment_method === "PICKUP" ? t("co.pickup") : t("co.delivery")}</div>
              <div className="product-card-price">{o.total} ₪</div>
              {o.pickup_code && (
                <div style={{ marginTop: 8, fontWeight: 600 }}>
                  {fmt(t("co.pickup_code"), { code: o.pickup_code })}
                </div>
              )}
            </div>
          ))}
          <a href="/discovery" className="button-link">
            {t("co.keep_shopping")}
          </a>
        </div>
      </div>
    );
  }

  if (!quote || !addresses) {
    return (
      <div className={pageClass}>
        <p className="muted">{t("co.loading")}</p>
      </div>
    );
  }

  if (reservation) {
    const expiresIn = expiresInMinutes;
    const total =
      reservation.items.reduce((s, i) => s + i.unit_price * i.quantity, 0) +
      reservation.slots.reduce((s, sl) => s + sl.delivery_fee, 0);
    const hasOnline = reservation.items.some((i) => i.payment_method === "ONLINE");
    const titleByVariant = new Map<string, string>();
    for (const g of quote.groups) {
      for (const it of g.items) titleByVariant.set(it.offer_variant_id, pickText(lang, it.title_en, it.title_ar));
    }
    return (
      <div className={pageClass}>
        <div className="top-bar">
          <div className="brand" style={{ margin: 0 }}>{t("co.confirm_title")}</div>
        </div>
        {error && <div className="error-banner" style={{ maxWidth: 560 }}>{errorText(error)}</div>}
        {reservation.replaced_previous && (
          <p className="muted checkout-hold-note" role="status" style={{ maxWidth: 560, margin: "0 0 8px" }}>
            {replacedReservationNotice(lang)}
          </p>
        )}

        {priceChange && (
          <div className="card price-diff" style={{ maxWidth: 560 }} role="alert">
            <strong>{t("co.prices_changed")}</strong>
            <p className="muted" style={{ margin: "6px 0 10px" }}>
              {t("co.prices_changed_hint")}
            </p>
            <ul>
              {priceChange.prices.map((c) => (
                <li key={c.offerVariantId}>
                  <span>{titleByVariant.get(c.offerVariantId) ?? t("co.product")}</span>
                  <span>
                    <s>{c.oldPrice} ₪</s> ← <strong>{c.newPrice} ₪</strong> (<bdi dir="ltr">{formatDelta(c.oldPrice, c.newPrice)}</bdi>)
                  </span>
                </li>
              ))}
              {priceChange.fees.map((c) => (
                <li key={c.deliveryWindowId}>
                  <span>{t("co.delivery_fee")}</span>
                  <span>
                    <s>{c.oldFee} ₪</s> ←{" "}
                    <strong>{c.newFee === null ? t("co.not_available") : `${c.newFee} ₪`}</strong>
                  </span>
                </li>
              ))}
            </ul>
            <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
              <button className="button" onClick={reviewNewPrices} disabled={busy}>
                {t("co.review_new_prices")}
              </button>
              <button className="button-link" onClick={cancelReservationAndRestart} disabled={busy}>
                {t("co.cancel_back")}
              </button>
            </div>
          </div>
        )}

        {!priceChange && (
          <div className="card" style={{ maxWidth: 560 }}>
            <p className="muted">
              {fmt(t("co.hold_valid"), { n: expiresIn })}
            </p>
            <div className="product-card-price" style={{ marginTop: 8 }}>
              {fmt(t("co.total"), { total })}
            </div>

            {hasOnline ? (
              <>
                {paymentError && (
                  <div className="error-banner" role="alert" style={{ marginTop: 12 }}>
                    {paymentError}
                  </div>
                )}
                <div style={{ marginTop: 12 }}>
                  <SandboxCardForm busy={busy} onPay={(r) => void confirm(r)} />
                </div>
                <div style={{ marginTop: 10 }}>
                  <button className="button-link" onClick={cancelReservationAndRestart} disabled={busy}>
                    {t("co.cancel_back")}
                  </button>
                </div>
              </>
            ) : (
              <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                <button className="button" onClick={() => void confirm()} disabled={busy}>
                  {t("co.confirm")}
                </button>
                <button className="button-link" onClick={cancelReservationAndRestart} disabled={busy}>
                  {t("co.cancel_back")}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={pageClass}>
      <div className="top-bar">
        <div className="brand" style={{ margin: 0 }}>{t("co.title")}</div>
      </div>

      {error && <div className="error-banner" style={{ maxWidth: 640 }}>{errorText(error)}</div>}
      {quote.unavailable_items.length > 0 && (
        <div className="error-banner" style={{ maxWidth: 640 }}>
          {t("co.unavailable_items")}
        </div>
      )}
      {quote.units_limit !== undefined &&
        quote.groups.reduce((n, g) => n + g.items.reduce((m, i) => m + i.quantity, 0), 0) > quote.units_limit && (
          <div className="error-banner checkout-units-limit" role="alert" style={{ maxWidth: 640 }}>
            {unitsLimitMessage(quote.units_limit, lang)}
          </div>
        )}

      <div style={{ maxWidth: 640, width: "100%", display: "flex", flexDirection: "column", gap: 16 }}>
        {quote.groups.map((g) => {
          const key = groupKey(g);
          const choice = choices[key];
          if (!choice) return null;
          const branch = branchFor(g, choice.branchId);
          return (
            <div key={key} className="card">
              <div style={{ fontWeight: 600, marginBottom: 6 }}>
                {g.items.map((i) => pickText(lang, i.title_en, i.title_ar)).join(t("co.list_sep"))}
              </div>
              <div className="muted">{fmt(t("co.subtotal"), { n: g.subtotal })}</div>
              {g.fragmented && (
                <p className="muted">
                  {t("co.fragmented")}
                </p>
              )}

              <div className="field">
                <label>{t("co.branch")}</label>
                <select
                  value={choice.branchId}
                  onChange={(e) =>
                    updateChoice(key, {
                      branchId: e.target.value,
                      // Switching branch must never leave an invalid method.
                      fulfilmentMethod: coerceMethod(
                        branchFor(g, e.target.value),
                        choice.fulfilmentMethod,
                      ),
                      addressId: "",
                      deliveryWindowId: "",
                      scheduledDate: "",
                    })
                  }
                >
                  {g.eligible_branches.map((b) => (
                    <option key={b.branch_id} value={b.branch_id}>
                      {b.branch_name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label>{t("co.method")}</label>
                <select
                  value={choice.fulfilmentMethod ?? ""}
                  disabled={choice.fulfilmentMethod === null}
                  onChange={(e) =>
                    updateChoice(key, {
                      fulfilmentMethod: e.target.value as FulfilmentMethod,
                    })
                  }
                >
                  {availableMethods(branch).includes("PICKUP") && (
                    <option value="PICKUP">{t("co.pickup")}</option>
                  )}
                  {availableMethods(branch).includes("DELIVERY") && (
                    <option value="DELIVERY">{t("co.delivery")}</option>
                  )}
                  {choice.fulfilmentMethod === null && <option value="">{t("co.not_available")}</option>}
                </select>
                {choice.fulfilmentMethod === null && (
                  <p className="cart-line-note" role="alert" style={{ margin: "6px 0 0" }}>
                    {t("co.no_method_branch")}
                  </p>
                )}
                {/* «ساعات العمل والإغلاقات v1»: pickup outside the branch's hours is
                    still allowed - the order is prepared at the next opening */}
                {choice.fulfilmentMethod === "PICKUP" && branch?.opening && (
                  <p className="muted" data-testid="co-pickup-opening" style={{ margin: "6px 0 0" }}>
                    {pickupPreparedLine(branch.opening, lang) ?? openingLine(branch.opening, lang)}
                  </p>
                )}
              </div>

              {/* Sprint 20b (FR-CART-015): shown per-group, for the
                  CURRENTLY selected branch/fulfilment method only -
                  quote() previews both methods independently, but only
                  the one actually chosen here is relevant to the
                  customer right now. reserve() still rejects this with
                  the same code/details if ignored - this is a preview,
                  not the real gate. */}
              {branch?.blockers
                .filter((b) => b.fulfilment_method === choice.fulfilmentMethod)
                .map((b, i) => (
                  <div
                    key={i}
                    className="error-banner"
                    role="alert"
                    style={{ margin: "6px 0 0" }}
                  >
                    {blockerText(b)}
                  </div>
                ))}

              {choice.fulfilmentMethod === "DELIVERY" && branch && (
                <>
                  <div className="field">
                    <label>{t("co.address")}</label>
                    <select
                      value={choice.addressId}
                      onChange={(e) => updateChoice(key, { addressId: e.target.value })}
                    >
                      <option value="">{t("co.pick_address")}</option>
                      {addresses.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.label ?? a.landmark_note ?? a.id.slice(0, 8)}
                        </option>
                      ))}
                    </select>
                    {addresses.length === 0 && addingAddressFor !== key && (
                      <p className="muted">{t("co.no_addresses")}</p>
                    )}
                    {addingAddressFor !== key && (
                      <button
                        type="button"
                        className="button-link"
                        style={{ alignSelf: "flex-start" }}
                        onClick={() => setAddingAddressFor(key)}
                      >
                        {t("co.new_address")}
                      </button>
                    )}
                  </div>
                  {addingAddressFor === key && (
                    <div className="card" style={{ maxWidth: "none", marginBottom: 16 }}>
                      <AddressForm
                        onCancel={() => setAddingAddressFor(null)}
                        onCreated={(created: SavedAddress) => {
                          setAddresses((prev) => [created, ...(prev ?? [])]);
                          updateChoice(key, { addressId: created.id });
                          setAddingAddressFor(null);
                        }}
                      />
                    </div>
                  )}
                  <div className="field">
                    <label>{t("co.slot")}</label>
                    <select
                      value={`${choice.deliveryWindowId}|${choice.scheduledDate}`}
                      onChange={(e) => {
                        const [windowId, date] = e.target.value.split("|");
                        updateChoice(key, { deliveryWindowId: windowId, scheduledDate: date });
                      }}
                    >
                      <option value="|">{t("co.pick_slot")}</option>
                      {branch.available_slots.map((s) => (
                        <option
                          key={`${s.delivery_window_id}-${s.date}`}
                          value={`${s.delivery_window_id}|${s.date}`}
                        >
                          {t(`co.day.${s.day_of_week}`)} {s.date} ({s.start_time}-{s.end_time})
                        </option>
                      ))}
                    </select>
                  </div>
                </>
              )}

              <div className="field">
                <label>{t("co.payment")}</label>
                <select
                  value={choice.paymentMethod}
                  onChange={(e) =>
                    updateChoice(key, { paymentMethod: e.target.value as "ONLINE" | "COD" })
                  }
                >
                  <option value="COD">
                    {t("co.cod")}
                  </option>
                  <option value="ONLINE">{t("co.online")}</option>
                </select>
              </div>

              <div className="field">
                <label>{t("co.note")}</label>
                <textarea
                  rows={2}
                  maxLength={500}
                  placeholder={t("co.note_placeholder")}
                  value={choice.customerNote}
                  onChange={(e) => updateChoice(key, { customerNote: e.target.value })}
                />
              </div>
            </div>
          );
        })}

        {quote.groups.length > 0 && (
          <div className="field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              id="terms-accepted"
              checked={termsAccepted}
              onChange={(e) => setTermsAccepted(e.target.checked)}
            />
            <label htmlFor="terms-accepted" style={{ margin: 0 }}>
              {t("co.agree")}<a href="/terms" target="_blank" rel="noreferrer">{t("co.terms")}</a>
            </label>
          </div>
        )}

        {quote.groups.length > 0 && (
          <button
            className="button"
            onClick={reserve}
            disabled={
              busy ||
              !termsAccepted ||
              !allGroupsFulfillable(quote.groups.map((g) => choices[groupKey(g)]?.fulfilmentMethod ?? null))
            }
          >
            {t("co.continue")}
          </button>
        )}
        {quote.groups.length === 0 && (
          <p className="muted">{t("co.nothing")}</p>
        )}
      </div>
    </div>
  );
}
