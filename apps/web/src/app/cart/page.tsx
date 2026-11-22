"use client";

import ColorDot from "@/components/ColorDot";
import { colorDisplayName } from "@/lib/colorName";
import { useTaxonomy } from "@/lib/taxonomy";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { EmptyState } from "@/components/States";
import CheckoutPage from "@/app/checkout/page";
import OrdersPage from "@/app/orders/page";
import { CartIcon, ClipboardIcon } from "@/components/Icons";
import { apiFetch, ApiError } from "@/lib/api";
import {
  CartLineState,
  cartQuantityErrorMessage,
  canSelect,
  checkoutBlock,
  lineMessage,
  lineState,
} from "@/lib/cart";
import { clearSession, getSessionToken } from "@/lib/session";
import { registerTranslations, translate } from "@/lib/i18n";
import { useLang } from "@/lib/useLang";
import { apiErrorMessage } from "@/lib/apiErrors";
import { pickText } from "@/lib/localized";
import { fmt } from "@/lib/shopText";
import { type UiMsg, uiMsgText } from "@/lib/storeText";
import { loginRedirectHref } from "@/lib/loginRedirect";

// TB-25: the cart's own words (Arabic unchanged).
registerTranslations({
  ar: {
    "cart.err.load": "تعذّر تحميل السلة",
    "cart.err.quantity": "تعذّر تحديث الكمية",
    "cart.err.remove": "تعذّر حذف العنصر",
    "cart.pick_one": "اختاري عنصراً واحداً على الأقل للمتابعة",
    "cart.needs_adjustment": "بعض العناصر المختارة تحتاج تعديلاً (الكمية أو التوفر) قبل المتابعة.",
    "cart.tabs": "محتوى السلة والطلبات",
    "cart.my_cart_n": "سلتي، {n} عناصر",
    "cart.my_cart": "سلتي",
    "cart.my_orders": "طلباتي",
    "cart.empty": "سلتك فارغة",
    "cart.empty_hint": "أضيفي منتجات من صفحات المتاجر ثم عودي لإتمام الشراء.",
    "cart.discover": "اكتشفي المنتجات",
    "cart.select": "اختيار {title}",
    "cart.unavailable": "غير متوفر",
    "cart.limited": "كمية محدودة",
    "cart.quantity": "الكمية",
    "cart.remove": "حذف",
    "cart.set_quantity": "اضبطي الكمية على {n}",
    "cart.total": "المجموع (العناصر المختارة)",
    "cart.checkout": "متابعة للدفع",
    "cart.adjust_first": "عدّلي العناصر المختارة أولاً.",
    "cart.checkout_dialog": "إتمام الطلب",
    "cart.close_checkout": "إغلاق إتمام الطلب",
  },
  en: {
    "cart.err.load": "Couldn't load your cart",
    "cart.err.quantity": "Couldn't update the quantity",
    "cart.err.remove": "Couldn't remove the item",
    "cart.pick_one": "Choose at least one item to continue",
    "cart.needs_adjustment": "Some of the chosen items need a change (quantity or availability) before you continue.",
    "cart.tabs": "Cart and orders",
    "cart.my_cart_n": "My cart, {n} items",
    "cart.my_cart": "My cart",
    "cart.my_orders": "My orders",
    "cart.empty": "Your cart is empty",
    "cart.empty_hint": "Add products from the stores' pages, then come back to check out.",
    "cart.discover": "Discover products",
    "cart.select": "Select {title}",
    "cart.unavailable": "Out of stock",
    "cart.limited": "Limited stock",
    "cart.quantity": "Quantity",
    "cart.remove": "Remove",
    "cart.set_quantity": "Set the quantity to {n}",
    "cart.total": "Total (chosen items)",
    "cart.checkout": "Continue to payment",
    "cart.adjust_first": "Adjust the chosen items first.",
    "cart.checkout_dialog": "Checkout",
    "cart.close_checkout": "Close checkout",
  },
});

interface CartItemDto extends CartLineState {
  vendor_id: string;
  offer_variant_id: string;
  title_ar: string;
  title_en: string;
  unit_price: number;
  /** Product colours: the line's colour (name + swatch) and size. */
  color_code?: string | null;
  color_name_ar?: string | null;
  color_name_en?: string | null;
  color_hex?: string | null;
  color_swatch_url?: string | null;
  size_label?: string | null;
}

// Sprint 10 (PDR-002/003): the server-side cart. Fulfilment is never
// chosen here - only WHICH lines to buy; that selection goes to
// /checkout. Sprint 14 (PDR-017, baseline 3.4): every line shows its
// availability. A sold-out / no-longer-purchasable line is dimmed with a
// remove control and cannot be selected; a quantity above what is
// available shows the maximum and must be adjusted before checkout.
//
// The page follows ?tab=cart|orders («طلباتي» lives here), so its
// Suspense boundary sits at the page; the fallback is the cart's own
// first loading state, so the prerendered HTML matches it.
function CartSkeleton() {
  return (
    <div className="cart-page page-shell">
      <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 560 }} />
    </div>
  );
}

export default function CartPage() {
  return (
    <Suspense fallback={<CartSkeleton />}>
      <Cart />
    </Suspense>
  );
}

function Cart() {
  const lang = useLang();
  const t = (key: string) => translate(lang, key);
  // Product colours: a line's family colour, when it has no swatch or HEX of its own.
  const taxonomy = useTaxonomy();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [items, setItems] = useState<CartItemDto[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<UiMsg | null>(null);
  /** TB-25: errors worded at render, in the interface language (stock/limit refusals by their code). */
  const errorText = (m: UiMsg) =>
    "api" in m && m.api instanceof ApiError
      ? (cartQuantityErrorMessage(m.api.code, m.api.details, lang) ?? apiErrorMessage(m.api, lang))
      : uiMsgText(m, lang);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const checkoutScrollRef = useRef<HTMLDivElement>(null);
  const checkoutScrollbarDragging = useRef(false);
  const [checkoutScrollbar, setCheckoutScrollbar] = useState({ visible: false, thumb: 100, top: 0 });
  const selectable = useRef<Map<string, boolean>>(new Map());
  const activeTab = searchParams.get("tab") === "orders" ? "orders" : "cart";

  function setActiveTab(tab: "cart" | "orders") {
    router.replace(tab === "orders" ? "/cart?tab=orders" : "/cart", { scroll: false });
  }

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
          router.replace(loginRedirectHref());
          return;
        }
        setError({ api: err, key: "cart.err.load" });
      });
  }

  useEffect(() => {
    if (!getSessionToken()) {
      router.replace(loginRedirectHref());
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  // The checkout is a self-contained modal. Lock the page beneath it so the
  // only scrollbar the customer sees (and uses) belongs to the modal itself.
  useEffect(() => {
    if (!checkoutOpen) return;
    const bodyOverflow = document.body.style.overflow;
    const rootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = rootOverflow;
    };
  }, [checkoutOpen]);

  function syncCheckoutScrollbar() {
    const element = checkoutScrollRef.current;
    if (!element) return;
    const overflow = element.scrollHeight - element.clientHeight;
    if (overflow <= 1) {
      setCheckoutScrollbar({ visible: false, thumb: 100, top: 0 });
      return;
    }
    const thumb = Math.max(18, (element.clientHeight / element.scrollHeight) * 100);
    setCheckoutScrollbar({
      visible: true,
      thumb,
      top: (element.scrollTop / overflow) * (100 - thumb),
    });
  }

  function moveCheckoutScrollbar(clientY: number, track: HTMLDivElement) {
    const element = checkoutScrollRef.current;
    if (!element) return;
    const overflow = element.scrollHeight - element.clientHeight;
    if (overflow <= 0) return;
    const rect = track.getBoundingClientRect();
    const thumbPixels = (checkoutScrollbar.thumb / 100) * rect.height;
    const available = Math.max(1, rect.height - thumbPixels);
    const position = Math.min(available, Math.max(0, clientY - rect.top - thumbPixels / 2));
    element.scrollTop = (position / available) * overflow;
  }

  useEffect(() => {
    if (!checkoutOpen) return;
    const frame = requestAnimationFrame(syncCheckoutScrollbar);
    const element = checkoutScrollRef.current;
    if (!element) return () => cancelAnimationFrame(frame);
    const observer = new MutationObserver(syncCheckoutScrollbar);
    observer.observe(element, { childList: true, subtree: true, characterData: true });
    window.addEventListener("resize", syncCheckoutScrollbar);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", syncCheckoutScrollbar);
    };
  }, [checkoutOpen]);

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
      setError({ api: err, key: "cart.err.quantity" });
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
      setError({ api: err, key: "cart.err.remove" });
    } finally {
      setBusy(false);
    }
  }

  function proceedToCheckout() {
    if (!items) return;
    const block = checkoutBlock(items, selected);
    if (block === "NOTHING_SELECTED") {
      setError({ key: "cart.pick_one" });
      return;
    }
    if (block === "SELECTION_NEEDS_ADJUSTMENT") {
      setError({ key: "cart.needs_adjustment" });
      return;
    }
    sessionStorage.setItem("checkout_cart_item_ids", JSON.stringify([...selected]));
    setCheckoutOpen(true);
  }

  if (activeTab === "cart" && error && !items) {
    return (
      <div className="cart-page page-shell">
        <div className="error-banner" style={{ maxWidth: 560 }}>{errorText(error)}</div>
      </div>
    );
  }

  if (activeTab === "cart" && !items) {
    return <CartSkeleton />;
  }

  const cartItems = items ?? [];
  const selectedTotal = cartItems
    .filter((i) => selected.has(i.id))
    .reduce((sum, i) => sum + i.unit_price * i.quantity, 0);
  const blocked = checkoutBlock(cartItems, selected) === "SELECTION_NEEDS_ADJUSTMENT";

  return (
    <div className="cart-page page-shell">
      <div className="wide-shell cart-content cart-workspace" style={{ maxWidth: 1120 }}>
        <div className="cart-tabs" role="tablist" aria-label={t("cart.tabs")}>
          <button type="button" role="tab" aria-label={fmt(t("cart.my_cart_n"), { n: cartItems.length })} aria-selected={activeTab === "cart"} className={activeTab === "cart" ? "active" : ""} onClick={() => setActiveTab("cart")}>
            <CartIcon /><span>{t("cart.my_cart")}</span><small>{cartItems.length}</small>
          </button>
          <button type="button" role="tab" aria-label={t("cart.my_orders")} aria-selected={activeTab === "orders"} className={activeTab === "orders" ? "active" : ""} onClick={() => setActiveTab("orders")}>
            <ClipboardIcon /><span>{t("cart.my_orders")}</span>
          </button>
        </div>

        {activeTab === "cart" ? <>
          {error && <div className="error-banner" role="alert">{errorText(error)}</div>}
          {notice && <div className="notice-banner" role="status">{notice}</div>}

          {cartItems.length === 0 && (
          <EmptyState
            title={t("cart.empty")}
            message={t("cart.empty_hint")}
            actionHref="/discovery"
            actionLabel={t("cart.discover")}
          />
          )}

          <div className="cart-layout">
          <div className="cart-lines" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {cartItems.map((item) => {
            const state = lineState(item);
            const message = lineMessage(item, lang);
            const title = pickText(lang, item.title_en, item.title_ar);
            const dimmed = state === "sold_out" || state === "unavailable";
            return (
              <div
                key={item.id}
                className={`card cart-line${dimmed ? " cart-line-dim" : ""}`}
                data-line-state={state}
                style={{ maxWidth: "none" }}
              >
                <div className="cart-line-main" style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    aria-label={fmt(t("cart.select"), { title })}
                    checked={selected.has(item.id)}
                    disabled={!canSelect(item)}
                    onChange={() => toggle(item)}
                  />
                  <div style={{ flex: 1 }}>
                    <div>{title}</div>
                    {(item.color_name_ar || item.size_label) && (
                      <div className="cart-line-variant" data-testid="cart-line-variant">
                        {item.color_name_ar && (
                          <>
                            <ColorDot
                              swatchUrl={item.color_swatch_url}
                              hex={item.color_hex}
                              familyHex={taxonomy.data?.colors.find((c) => c.code === item.color_code)?.hex}
                            />
                            {colorDisplayName({ name_ar: item.color_name_ar, name_en: item.color_name_en }, lang)}
                          </>
                        )}
                        {item.color_name_ar && item.size_label && " / "}
                        {item.size_label}
                      </div>
                    )}
                    <div className="muted">
                      {item.unit_price} ₪ × {item.quantity} = {item.unit_price * item.quantity} ₪
                    </div>
                  </div>
                  {dimmed && <span className="availability-badge availability-sold_out">{t("cart.unavailable")}</span>}
                  {!dimmed && item.availability === "low_stock" && (
                    <span className="availability-badge availability-low_stock">{t("cart.limited")}</span>
                  )}
                </div>

                <div className="cart-line-actions" style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
                  {!dimmed && (
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span className="muted">{t("cart.quantity")}</span>
                      <input
                        type="number"
                        min={1}
                        max={item.purchase_limit}
                        value={item.quantity}
                        disabled={busy}
                        style={{ width: 72 }}
                        onChange={(e) => updateQuantity(item, Number(e.target.value))}
                      />
                    </label>
                  )}
                  <button className="button-link" disabled={busy} onClick={() => removeItem(item.id)}>
                    {t("cart.remove")}
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
                {state === "exceeds_max" && item.max_quantity !== null && (
                  <button
                    className="button-link"
                    style={{ marginTop: 8 }}
                    disabled={busy}
                    onClick={() => updateQuantity(item, item.max_quantity!)}
                  >
                    {fmt(t("cart.set_quantity"), { n: item.max_quantity })}
                  </button>
                )}
              </div>
            );
          })}
          </div>

          {cartItems.length > 0 && (
          <div className="card cart-summary-card" style={{ maxWidth: "none" }}>
            <div className="cart-summary-total" style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
              <span>{t("cart.total")}</span>
              <span className="product-card-price">{selectedTotal} ₪</span>
            </div>
            <button className="button button-block" onClick={proceedToCheckout} disabled={busy || blocked}>
              {t("cart.checkout")}
            </button>
            {blocked && (
              <p className="cart-line-note" role="alert" style={{ marginBottom: 0 }}>
                {t("cart.adjust_first")}
              </p>
            )}
          </div>
          )}
          </div>
        </> : <OrdersPage embedded context="cart" />}
      </div>
      {checkoutOpen && (
        <div className="checkout-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setCheckoutOpen(false)}>
          <section className="checkout-dialog" role="dialog" aria-modal="true" aria-label={t("cart.checkout_dialog")}>
            <button type="button" className="checkout-dialog-close" onClick={() => setCheckoutOpen(false)} aria-label={t("cart.close_checkout")}>×</button>
            <div id="checkout-dialog-content" ref={checkoutScrollRef} className="checkout-dialog-scroll" onScroll={syncCheckoutScrollbar}>
              <CheckoutPage embedded />
            </div>
            {checkoutScrollbar.visible && (
              <div
                className="checkout-dialog-scrollbar"
                role="scrollbar"
                aria-controls="checkout-dialog-content"
                aria-orientation="vertical"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(checkoutScrollbar.top)}
                tabIndex={0}
                onPointerDown={(event) => {
                  checkoutScrollbarDragging.current = true;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  moveCheckoutScrollbar(event.clientY, event.currentTarget);
                }}
                onPointerMove={(event) => {
                  if (checkoutScrollbarDragging.current) moveCheckoutScrollbar(event.clientY, event.currentTarget);
                }}
                onPointerUp={(event) => {
                  checkoutScrollbarDragging.current = false;
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onPointerCancel={() => { checkoutScrollbarDragging.current = false; }}
              >
                <span style={{ height: `${checkoutScrollbar.thumb}%`, transform: `translateY(${checkoutScrollbar.top}%)` }} />
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
