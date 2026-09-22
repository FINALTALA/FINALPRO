"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { clearSession, getSessionToken } from "@/lib/session";

interface CartItemDto {
  id: string;
  vendor_id: string;
  offer_variant_id: string;
  quantity: number;
  title_ar: string;
  title_en: string;
  unit_price: number;
}

// Sprint 10 (PDR-002/003): the server-side cart's own page. Fulfilment
// is never chosen here - only WHICH lines to buy, via the checkboxes
// below; that selection is handed to /checkout, which is where branch/
// pickup/delivery/slot choices actually happen (RB-ORD-002). A line
// left unchecked simply stays in the cart untouched.
export default function CartPage() {
  const router = useRouter();
  const [items, setItems] = useState<CartItemDto[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function load() {
    apiFetch<CartItemDto[]>("/cart")
      .then((res) => {
        setItems(res);
        setSelected((prev) => {
          const next = new Set(prev);
          for (const item of res) next.add(item.id);
          return next;
        });
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          router.replace("/login");
          return;
        }
        setError(err instanceof ApiError ? err.message : "تعذّر تحميل السلة");
      });
  }

  useEffect(() => {
    if (!getSessionToken()) {
      router.replace("/login");
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function updateQuantity(id: string, quantity: number) {
    if (quantity < 1) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/cart/items/${id}`, { method: "PUT", body: { quantity } });
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
    const ids = [...selected];
    if (ids.length === 0) {
      setError("اختاري عنصراً واحداً على الأقل للمتابعة");
      return;
    }
    sessionStorage.setItem("checkout_cart_item_ids", JSON.stringify(ids));
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
        <p className="muted">جارٍ التحميل...</p>
      </div>
    );
  }

  const selectedTotal = items
    .filter((i) => selected.has(i.id))
    .reduce((sum, i) => sum + i.unit_price * i.quantity, 0);

  return (
    <div className="page-shell">
      <div className="top-bar">
        <div className="brand" style={{ margin: 0 }}>سلتي</div>
      </div>

      {error && <div className="error-banner" style={{ maxWidth: 560 }}>{error}</div>}

      {items.length === 0 && <p className="muted">سلتك فارغة.</p>}

      <div style={{ maxWidth: 560, width: "100%", display: "flex", flexDirection: "column", gap: 12 }}>
        {items.map((item) => (
          <div key={item.id} className="card" style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={selected.has(item.id)}
              onChange={() => toggle(item.id)}
            />
            <div style={{ flex: 1 }}>
              <div>{item.title_ar}</div>
              <div className="muted">{item.unit_price} ₪ × {item.quantity} = {item.unit_price * item.quantity} ₪</div>
            </div>
            <input
              type="number"
              min={1}
              value={item.quantity}
              disabled={busy}
              style={{ width: 60 }}
              onChange={(e) => updateQuantity(item.id, Number(e.target.value))}
            />
            <button className="button-link" disabled={busy} onClick={() => removeItem(item.id)}>
              حذف
            </button>
          </div>
        ))}
      </div>

      {items.length > 0 && (
        <div className="card" style={{ maxWidth: 560, marginTop: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
            <span>المجموع (العناصر المختارة)</span>
            <span className="product-card-price">{selectedTotal} ₪</span>
          </div>
          <button className="button" onClick={proceedToCheckout} disabled={busy}>
            متابعة للدفع
          </button>
        </div>
      )}
    </div>
  );
}
