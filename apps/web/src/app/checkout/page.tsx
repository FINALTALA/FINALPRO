"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch, ApiError, newIdempotencyKey } from "@/lib/api";
import { clearSession, getSessionToken } from "@/lib/session";

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
interface EligibleBranch {
  branch_id: string;
  branch_name: string;
  is_physical: boolean;
  delivery_fee: number | null;
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
}

interface AddressDto {
  id: string;
  label: string | null;
  landmark_note: string | null;
  zone: string | null;
}

interface GroupChoice {
  branchId: string;
  fulfilmentMethod: "PICKUP" | "DELIVERY";
  paymentMethod: "ONLINE" | "COD";
  addressId: string;
  deliveryWindowId: string;
  scheduledDate: string;
}

interface ReserveResponse {
  reservation_id: string;
  expires_at: string;
  items: { unit_price: number; quantity: number }[];
  slots: { delivery_fee: number; scheduled_date: string }[];
}

interface ConfirmedBranchOrder {
  id: string;
  pickup_code: string | null;
  fulfilment_method: string;
  total: number;
}

const DAY_LABELS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

// Sprint 10 (RB-ORD-002): quote (read-only preview) -> the customer
// configures branch/fulfilment/slot/payment per group -> reserve (the
// real 10-minute hold) -> confirm (creates the actual order(s)).
// Deliberately NOT a full Orders UI afterward - just the immediate
// confirmation with pickup codes, per this sprint's own scope note.
export default function CheckoutPage() {
  const router = useRouter();
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [addresses, setAddresses] = useState<AddressDto[] | null>(null);
  const [choices, setChoices] = useState<Record<string, GroupChoice>>({});
  const [error, setError] = useState<string | null>(null);
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

  function groupKey(g: QuoteGroup): string {
    return `${g.vendor_id}:${g.cart_item_ids.join(",")}`;
  }

  useEffect(() => {
    if (!getSessionToken()) {
      router.replace("/login");
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
            fulfilmentMethod: "PICKUP",
            paymentMethod: "COD",
            addressId: "",
            deliveryWindowId: "",
            scheduledDate: "",
          };
        }
        setChoices(initial);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          router.replace("/login");
          return;
        }
        setError(err instanceof ApiError ? err.message : "تعذّر تحميل ملخص الطلب");
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
    setBusy(true);
    setError(null);
    try {
      const groups = quote.groups.map((g) => {
        const choice = choices[groupKey(g)];
        return {
          cart_item_ids: g.cart_item_ids,
          branch_id: choice.branchId,
          fulfilment_method: choice.fulfilmentMethod,
          payment_method: choice.paymentMethod,
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
        body: { groups },
        idempotencyKey: newIdempotencyKey("checkout-reserve"),
      });
      setReservation(res);
      setExpiresInMinutes(
        Math.max(0, Math.round((new Date(res.expires_at).getTime() - Date.now()) / 60000)),
      );
      setConfirmIdempotencyKey(newIdempotencyKey("checkout-confirm"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر حجز الطلب");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!reservation) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ branch_orders: ConfirmedBranchOrder[] }>(
        "/checkout/confirm",
        {
          method: "POST",
          body: { reservation_id: reservation.reservation_id },
          idempotencyKey: confirmIdempotencyKey,
        },
      );
      setConfirmed(res.branch_orders);
      sessionStorage.removeItem("checkout_cart_item_ids");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر تأكيد الطلب");
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
  }

  if (error && !quote) {
    return (
      <div className="page-shell">
        <div className="error-banner" style={{ maxWidth: 560 }}>{error}</div>
      </div>
    );
  }

  if (confirmed) {
    return (
      <div className="page-shell">
        <div className="top-bar">
          <div className="brand" style={{ margin: 0 }}>تم إنشاء الطلب</div>
        </div>
        <div style={{ maxWidth: 560, width: "100%", display: "flex", flexDirection: "column", gap: 12 }}>
          {confirmed.map((o) => (
            <div key={o.id} className="card">
              <div>طلب #{o.id.slice(0, 8)}</div>
              <div className="muted">{o.fulfilment_method === "PICKUP" ? "استلام من المحل" : "توصيل"}</div>
              <div className="product-card-price">{o.total} ₪</div>
              {o.pickup_code && (
                <div style={{ marginTop: 8, fontWeight: 600 }}>
                  رمز الاستلام: {o.pickup_code}
                </div>
              )}
            </div>
          ))}
          <a href="/discovery" className="button-link">
            متابعة التسوق
          </a>
        </div>
      </div>
    );
  }

  if (!quote || !addresses) {
    return (
      <div className="page-shell">
        <p className="muted">جارٍ التحميل...</p>
      </div>
    );
  }

  if (reservation) {
    const expiresIn = expiresInMinutes;
    const total =
      reservation.items.reduce((s, i) => s + i.unit_price * i.quantity, 0) +
      reservation.slots.reduce((s, sl) => s + sl.delivery_fee, 0);
    return (
      <div className="page-shell">
        <div className="top-bar">
          <div className="brand" style={{ margin: 0 }}>تأكيد الطلب</div>
        </div>
        {error && <div className="error-banner" style={{ maxWidth: 560 }}>{error}</div>}
        <div className="card" style={{ maxWidth: 560 }}>
          <p className="muted">
            الحجز صالح لمدة {expiresIn} دقيقة تقريباً - أكملي الدفع قبل انتهاء الوقت.
          </p>
          <div className="product-card-price" style={{ marginTop: 8 }}>
            الإجمالي: {total} ₪
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button className="button" onClick={confirm} disabled={busy}>
              تأكيد الدفع
            </button>
            <button className="button-link" onClick={cancelReservationAndRestart} disabled={busy}>
              إلغاء والعودة
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="top-bar">
        <div className="brand" style={{ margin: 0 }}>إتمام الطلب</div>
      </div>

      {error && <div className="error-banner" style={{ maxWidth: 640 }}>{error}</div>}
      {quote.unavailable_items.length > 0 && (
        <div className="error-banner" style={{ maxWidth: 640 }}>
          بعض العناصر لم تعد متوفرة بالكمية المطلوبة ولن تُشترى الآن.
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
                {g.items.map((i) => i.title_ar).join("، ")}
              </div>
              <div className="muted">المجموع الفرعي: {g.subtotal} ₪</div>
              {g.fragmented && (
                <p className="muted">
                  تعذّر تغطية كل العناصر من فرع واحد - قُسّمت تلقائياً على أقرب فرع مؤهل.
                </p>
              )}

              <div className="field">
                <label>الفرع</label>
                <select
                  value={choice.branchId}
                  onChange={(e) => updateChoice(key, { branchId: e.target.value })}
                >
                  {g.eligible_branches.map((b) => (
                    <option key={b.branch_id} value={b.branch_id}>
                      {b.branch_name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label>طريقة الاستلام</label>
                <select
                  value={choice.fulfilmentMethod}
                  onChange={(e) =>
                    updateChoice(key, {
                      fulfilmentMethod: e.target.value as "PICKUP" | "DELIVERY",
                    })
                  }
                >
                  {branch?.is_physical && <option value="PICKUP">استلام من المحل</option>}
                  {branch && branch.available_slots.length > 0 && (
                    <option value="DELIVERY">توصيل</option>
                  )}
                </select>
              </div>

              {choice.fulfilmentMethod === "DELIVERY" && branch && (
                <>
                  <div className="field">
                    <label>العنوان</label>
                    <select
                      value={choice.addressId}
                      onChange={(e) => updateChoice(key, { addressId: e.target.value })}
                    >
                      <option value="">اختاري عنواناً</option>
                      {addresses.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.label ?? a.landmark_note ?? a.id.slice(0, 8)}
                        </option>
                      ))}
                    </select>
                    {addresses.length === 0 && (
                      <p className="muted">
                        لا توجد عناوين محفوظة - <a href="#" onClick={(e) => { e.preventDefault(); router.push("/cart"); }}>أضيفي عنواناً أولاً</a>.
                      </p>
                    )}
                  </div>
                  <div className="field">
                    <label>الموعد (خلال الأيام الثلاثة القادمة)</label>
                    <select
                      value={`${choice.deliveryWindowId}|${choice.scheduledDate}`}
                      onChange={(e) => {
                        const [windowId, date] = e.target.value.split("|");
                        updateChoice(key, { deliveryWindowId: windowId, scheduledDate: date });
                      }}
                    >
                      <option value="|">اختاري موعداً</option>
                      {branch.available_slots.map((s) => (
                        <option
                          key={`${s.delivery_window_id}-${s.date}`}
                          value={`${s.delivery_window_id}|${s.date}`}
                        >
                          {DAY_LABELS[s.day_of_week]} {s.date} ({s.start_time}-{s.end_time})
                        </option>
                      ))}
                    </select>
                  </div>
                </>
              )}

              <div className="field">
                <label>طريقة الدفع</label>
                <select
                  value={choice.paymentMethod}
                  onChange={(e) =>
                    updateChoice(key, { paymentMethod: e.target.value as "ONLINE" | "COD" })
                  }
                >
                  <option value="COD">
                    {choice.fulfilmentMethod === "DELIVERY" ? "الدفع عند الاستلام" : "الدفع عند الاستلام"}
                  </option>
                  <option value="ONLINE">دفع إلكتروني (تجريبي)</option>
                </select>
              </div>
            </div>
          );
        })}

        {quote.groups.length > 0 && (
          <button className="button" onClick={reserve} disabled={busy}>
            متابعة
          </button>
        )}
        {quote.groups.length === 0 && (
          <p className="muted">لا توجد عناصر متاحة للمتابعة حالياً.</p>
        )}
      </div>
    </div>
  );
}
