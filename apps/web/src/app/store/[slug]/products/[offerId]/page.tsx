"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch, ApiError, newIdempotencyKey } from "@/lib/api";
import { getSessionToken } from "@/lib/session";

interface OfferVariantDto {
  id: string;
  seller_sku: string;
  condition: string;
  currency: "ILS";
  base_price: string;
  sale_price: string | null;
  specs_text_ar: string | null;
  specs_text_en: string | null;
  canonical_variant_id: string | null;
  // Sprint 8 round 4 review fix (RB-COMP-001, PDR-015): null for an
  // unmatched variant - the signal for whether a "compare prices" link
  // can be shown at all, never inferred from canonical_variant_id
  // alone.
  canonical_product_id: string | null;
  availability: "available" | "low_stock" | "sold_out";
}

interface OfferDetailDto {
  id: string;
  vendor_id: string;
  vendor_slug: string;
  vendor_display_name: string;
  title_ar: string;
  title_en: string;
  variants: OfferVariantDto[];
}

const AVAILABILITY_LABEL: Record<string, string> = {
  available: "متوفر",
  low_stock: "كمية محدودة",
  sold_out: "غير متوفر",
};

// Sprint 8 (RB-COMP-001, PDR-015/016): "الضغط على شعار محل يفتح تفاصيل
// المنتج داخل صفحة ذلك المحل، وليس السلة." This page is that detail -
// reached from a comparison/discovery card, or by browsing a store's
// own sections directly.
// Sprint 10 (PDR-002): "أضف للسلة" is the one cart affordance added
// here - a guest (no session) sees a prompt to sign in instead of a
// silent failure, since PDR-002 restricts the cart to signed-in
// customers only; no guest-cart merge exists anywhere in this
// codebase.
export default function StoreProductPage() {
  const params = useParams<{ slug: string; offerId: string }>();
  const router = useRouter();
  const [offer, setOffer] = useState<OfferDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [addedId, setAddedId] = useState<string | null>(null);
  const [cartError, setCartError] = useState<string | null>(null);

  async function addToCart(variantId: string) {
    if (!getSessionToken()) {
      router.push("/login");
      return;
    }
    if (!offer) return;
    setAddingId(variantId);
    setCartError(null);
    try {
      await apiFetch("/cart/items", {
        method: "POST",
        body: { vendor_id: offer.vendor_id, offer_variant_id: variantId, quantity: 1 },
        idempotencyKey: newIdempotencyKey("cart-add"),
      });
      setAddedId(variantId);
      setTimeout(() => setAddedId((prev) => (prev === variantId ? null : prev)), 2000);
    } catch (err) {
      setCartError(err instanceof ApiError ? err.message : "تعذّرت الإضافة للسلة");
    } finally {
      setAddingId(null);
    }
  }

  useEffect(() => {
    apiFetch<OfferDetailDto>(
      `/storefronts/${params.slug}/offers/${params.offerId}`,
      { auth: false },
    )
      .then(setOffer)
      .catch((err) => {
        setError(
          err instanceof ApiError && err.status === 404
            ? "المنتج غير موجود"
            : "تعذّر تحميل تفاصيل المنتج",
        );
      });
  }, [params.slug, params.offerId]);

  if (error) {
    return (
      <div className="page-shell">
        <div className="error-banner" style={{ maxWidth: 560 }}>{error}</div>
      </div>
    );
  }

  if (!offer) {
    return (
      <div className="page-shell">
        <p className="muted">جارٍ التحميل...</p>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="top-bar">
        <div className="brand" style={{ margin: 0 }}>
          {offer.title_ar}
        </div>
        <a href="/cart" className="button-link">
          السلة
        </a>
      </div>
      <div className="card" style={{ maxWidth: 560 }}>
        <div className="muted">{offer.vendor_display_name}</div>
        <div className="brand" style={{ margin: "6px 0 16px" }}>
          {offer.title_ar}
        </div>
        {cartError && <div className="error-banner">{cartError}</div>}

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {offer.variants.map((v) => (
            <div
              key={v.id}
              style={{
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                padding: 12,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span className="product-card-price">
                  {v.sale_price ?? v.base_price} ₪
                </span>
                <span
                  className={`availability-badge availability-${v.availability}`}
                >
                  {AVAILABILITY_LABEL[v.availability]}
                </span>
              </div>
              {v.sale_price && (
                <div className="muted" style={{ textDecoration: "line-through" }}>
                  {v.base_price} ₪
                </div>
              )}
              {v.specs_text_ar && (
                <p className="muted" style={{ marginTop: 8 }}>
                  {v.specs_text_ar}
                </p>
              )}
              {v.availability !== "sold_out" && (
                <button
                  className="button"
                  style={{ marginTop: 8 }}
                  disabled={addingId === v.id}
                  onClick={() => addToCart(v.id)}
                >
                  {addedId === v.id ? "أُضيف ✓" : "أضف للسلة"}
                </button>
              )}
              {/* Sprint 8 round 4 review fix: a customer who arrived
                  here via a comparison-card store-logo click had no way
                  back into the comparison for this same product - shown
                  only when this variant has a CONFIRMED canonical match
                  (never for an unmatched offer, which has no comparison
                  target at all). */}
              {v.canonical_product_id && (
                <button
                  className="button-link"
                  style={{ marginTop: 8 }}
                  onClick={() =>
                    router.push(`/compare/${v.canonical_product_id}`)
                  }
                >
                  قارني الأسعار
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
