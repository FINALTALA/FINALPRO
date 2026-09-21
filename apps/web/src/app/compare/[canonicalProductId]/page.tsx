"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/api";

interface VariantOptionDto {
  id: string;
  structural_attributes: Record<string, unknown>;
}

interface ComparisonOfferDto {
  vendor_id: string;
  vendor_slug: string;
  display_name: string;
  logo_url: string | null;
  offer_id: string;
  offer_variant_id: string;
  canonical_variant_id: string;
  structural_attributes: Record<string, unknown>;
  currency: "ILS";
  price: string;
  availability: "available" | "low_stock" | "sold_out";
}

interface ComparisonPageDto {
  canonical_product_id: string;
  canonical_name_ar: string;
  canonical_name_en: string;
  variants: VariantOptionDto[];
  offers: ComparisonOfferDto[];
}

const AVAILABILITY_LABEL: Record<string, string> = {
  available: "متوفر",
  low_stock: "كمية محدودة",
  sold_out: "غير متوفر",
};

function variantLabel(attrs: Record<string, unknown>): string {
  const values = Object.values(attrs).filter(
    (v) => v !== null && v !== undefined && v !== "",
  );
  return values.length > 0 ? values.join(" / ") : "خيار واحد";
}

// Sprint 8 (RB-COMP-001, PDR-016): "صفحة مقارنة تعرض كل عروض المحلات
// المؤهلة من الأرخص إلى الأغلى... اختيار لون/مقاس يفلتر النتائج."
// Never offers "add to cart" here - a customer must enter the store's
// own product page first (this page's own row click / logo click both
// route there, never to a cart).
export default function ComparisonPage() {
  const params = useParams<{ canonicalProductId: string }>();
  const router = useRouter();
  const [data, setData] = useState<ComparisonPageDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    const query = selectedVariantId
      ? `?canonical_variant_id=${selectedVariantId}`
      : "";
    apiFetch<ComparisonPageDto>(
      `/canonical-products/${params.canonicalProductId}/comparison${query}`,
      { auth: false },
    )
      .then(setData)
      .catch((err) => {
        setError(
          err instanceof ApiError && err.status === 404
            ? "لا توجد عروض مؤهلة لهذا المنتج حالياً"
            : "تعذّر تحميل صفحة المقارنة",
        );
      });
  }, [params.canonicalProductId, selectedVariantId]);

  if (error) {
    return (
      <div className="page-shell">
        <div className="error-banner" style={{ maxWidth: 560 }}>{error}</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="page-shell">
        <p className="muted">جارٍ التحميل...</p>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="wide-shell">
        <div className="brand" style={{ textAlign: "right" }}>
          {data.canonical_name_ar}
        </div>

        {data.variants.length > 1 && (
          <div className="variant-picker">
            <button
              className={`variant-chip${selectedVariantId === null ? " active" : ""}`}
              onClick={() => setSelectedVariantId(null)}
            >
              كل الخيارات
            </button>
            {data.variants.map((v) => (
              <button
                key={v.id}
                className={`variant-chip${selectedVariantId === v.id ? " active" : ""}`}
                onClick={() => setSelectedVariantId(v.id)}
              >
                {variantLabel(v.structural_attributes)}
              </button>
            ))}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {data.offers.map((offer) => (
            <div
              key={offer.offer_variant_id}
              className="comparison-row"
              onClick={() =>
                router.push(`/store/${offer.vendor_slug}/products/${offer.offer_id}`)
              }
            >
              <div className="comparison-row-store">
                <button
                  className="store-logo-button"
                  onClick={(e) => {
                    e.stopPropagation();
                    router.push(
                      `/store/${offer.vendor_slug}/products/${offer.offer_id}`,
                    );
                  }}
                >
                  {offer.logo_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={offer.logo_url}
                      alt={offer.display_name}
                      className="store-logo-img"
                    />
                  ) : (
                    <span className="store-logo-placeholder">
                      {offer.display_name.slice(0, 1)}
                    </span>
                  )}
                </button>
                <div>
                  <div style={{ fontWeight: 600 }}>{offer.display_name}</div>
                  <div className="muted">
                    {variantLabel(offer.structural_attributes)}
                  </div>
                </div>
              </div>
              <div style={{ textAlign: "left" }}>
                <div className="product-card-price">{offer.price} ₪</div>
                <span
                  className={`availability-badge availability-${offer.availability}`}
                >
                  {AVAILABILITY_LABEL[offer.availability]}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
