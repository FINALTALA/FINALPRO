"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/api";

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
  availability: "available" | "low_stock" | "sold_out";
}

interface OfferDetailDto {
  id: string;
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
// own sections directly. Deliberately no cart/checkout affordance
// anywhere on it (out of scope for the whole project so far, not just
// this sprint).
export default function StoreProductPage() {
  const params = useParams<{ slug: string; offerId: string }>();
  const [offer, setOffer] = useState<OfferDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      <div className="card" style={{ maxWidth: 560 }}>
        <div className="muted">{offer.vendor_display_name}</div>
        <div className="brand" style={{ margin: "6px 0 16px" }}>
          {offer.title_ar}
        </div>

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
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
