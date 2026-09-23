"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { EmptyState } from "@/components/States";
import { apiFetch, ApiError } from "@/lib/api";
import {
  CartLineState,
  canSelect,
  checkoutBlock,
  lineMessage,
  lineState,
} from "@/lib/cart";
import { clearSession, getSessionToken } from "@/lib/session";

interface CartItemDto extends CartLineState {
  vendor_id: string;
  offer_variant_id: string;
  title_ar: string;
  title_en: string;
  unit_price: number;
}

// Sprint 10 (PDR-002/003): the server-side cart. Fulfilment is never
// chosen here - only WHICH lines to buy; that selection goes to
// /checkout. Sprint 14 (PDR-017, baseline 3.4): every line shows its
// availability. A sold-out / no-longer-purchasable line is dimmed with a
// remove control and cannot be selected; a quantity above what is
// available shows the maximum and must be adjusted before checkout.
export default function CartPage() {
  const router = useRouter();
  const [items, setItems] = useState<CartItemDto[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selectable = useRef<Map<string, boolean>>(new Map());

  function load() {
    apiFetch<CartItemDto[]>("/cart")
      .then((res) => {
        setItems(res);
        // Snapshot the previous per-line "could be selected" state BEFORE
        // updating the ref, so the state updater below stays pure (React
        // may run it twice in development).
        const before = selectable.current;
        selectable.current = new Map(res.map((i) => [i.id, canSelect(i)]));
        setSelected((prev) => {
          const next = new Set<string>();
          for (const item of res) {
            if (!canSelect(item)) continue; // never selected while it cannot be bought
            // Selected when: first time seen, or it just became valid again
            // (the customer adjusted it), or the customer already had it
            // selected.
            const wasSelectable = before.get(item.id);
            if (wasSelectable === undefined || wasSelectable === false || prev.has(item.id)) {
              next.add(item.id);
            }
          }
          return next;
        });
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          router.replace("/login?next=/cart");
          return;
        }
        setError(err instanceof ApiError ? err.message : "تعذّر تحميل السلة");
      });
  }

  useEffect(() => {
    if (!getSessionToken()) {
      router.replace("/login?next=/cart");
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  function toggle(item: CartItemDto) {
    if (!canSelect(item)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  }

  async function updateQuantity(item: CartItemDto, quantity: number) {
    if (!Number.isFinite(quantity) || quantity < 1) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/cart/items/${item.id}`, { method: "PUT", body: { quantity } });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر تحديث الكمية");
    } finally {
      setBusy(false);
    }
  }

  async function removeItem(id: string) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/cart/items/${id}`, { method: "DELETE" });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر حذف العنصر");
    } finally {
      setBusy(false);
    }
  }

  function proceedToCheckout() {
    if (!items) return;
    const block = checkoutBlock(items, selected);
    if (block === "NOTHING_SELECTED") {
      setError("اختاري عنصراً واحداً على الأقل للمتابعة");
      return;
    }
    if (block === "SELECTION_NEEDS_ADJUSTMENT") {
      setError("بعض العناصر المختارة تحتاج تعديلاً (الكمية أو التوفر) قبل المتابعة.");
      return;
    }
    sessionStorage.setItem("checkout_cart_item_ids", JSON.stringify([...selected]));
    router.push("/checkout");
  }

  if (error && !items) {
    return (
      <div className="page-shell">
        <div className="error-banner" style={{ maxWidth: 560 }}>{error}</div>
      </div>
    );
  }

  if (!items) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 560 }} />
      </div>
    );
  }

  const selectedTotal = items
    .filter((i) => selected.has(i.id))
    .reduce((sum, i) => sum + i.unit_price * i.quantity, 0);
  const blocked = checkoutBlock(items, selected) === "SELECTION_NEEDS_ADJUSTMENT";

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 640 }}>
        <h1 className="page-title">سلتي</h1>

        {error && <div className="error-banner" role="alert">{error}</div>}
        {notice && <div className="notice-banner" role="status">{notice}</div>}

        {items.length === 0 && (
          <EmptyState
            title="سلتك فارغة"
            message="أضيفي منتجات من صفحات المتاجر ثم عودي لإتمام الشراء."
            actionHref="/discovery"
            actionLabel="اكتشفي المنتجات"
          />
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {items.map((item) => {
            const state = lineState(item);
            const message = lineMessage(item);
            const dimmed = state === "sold_out" || state === "unavailable";
            return (
              <div
                key={item.id}
                className={`card cart-line${dimmed ? " cart-line-dim" : ""}`}
                data-line-state={state}
                style={{ maxWidth: "none" }}
              >
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    aria-label={`اختيار ${item.title_ar}`}
                    checked={selected.has(item.id)}
                    disabled={!canSelect(item)}
                    onChange={() => toggle(item)}
                  />
                  <div style={{ flex: 1 }}>
                    <div>{item.title_ar}</div>
                    <div className="muted">
                      {item.unit_price} ₪ × {item.quantity} = {item.unit_price * item.quantity} ₪
                    </div>
                  </div>
                  {dimmed && <span className="availability-badge availability-sold_out">غير متوفر</span>}
                  {!dimmed && item.availability === "low_stock" && (
                    <span className="availability-badge availability-low_stock">كمية محدودة</span>
                  )}
                </div>

                <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
                  {!dimmed && (
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span className="muted">الكمية</span>
                      <input
                        type="number"
                        min={1}
                        max={item.max_quantity > 0 ? item.max_quantity : undefined}
                        value={item.quantity}
                        disabled={busy}
                        style={{ width: 72 }}
                        onChange={(e) => updateQuantity(item, Number(e.target.value))}
                      />
                    </label>
                  )}
                  <button className="button-link" disabled={busy} onClick={() => removeItem(item.id)}>
                    حذف
                  </button>
                </div>

                {message && (
                  <p
                    className={state === "ok" ? "muted" : "cart-line-note"}
                    role={state === "ok" ? undefined : "alert"}
                    style={{ margin: "8px 0 0" }}
                  >
                    {message}
                  </p>
                )}
                {state === "exceeds_max" && (
                  <button
                    className="button-link"
                    style={{ marginTop: 8 }}
                    disabled={busy}
                    onClick={() => updateQuantity(item, item.max_quantity)}
                  >
                    اضبطي الكمية على {item.max_quantity}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {items.length > 0 && (
          <div className="card" style={{ maxWidth: "none", marginTop: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
              <span>المجموع (العناصر المختارة)</span>
              <span className="product-card-price">{selectedTotal} ₪</span>
            </div>
            <button className="button button-block" onClick={proceedToCheckout} disabled={busy || blocked}>
              متابعة للدفع
            </button>
            {blocked && (
              <p className="cart-line-note" role="alert" style={{ marginBottom: 0 }}>
                عدّلي العناصر المختارة أولاً.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
