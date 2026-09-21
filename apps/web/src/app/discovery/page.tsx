"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/api";

interface ComparisonCardDto {
  canonical_product_id: string;
  canonical_name_ar: string;
  canonical_name_en: string;
  lowest_price: string;
  lowest_price_availability: "available" | "low_stock" | "sold_out";
  cheapest_offer: {
    vendor_id: string;
    vendor_slug: string;
    offer_id: string;
    offer_variant_id: string;
  };
  store_logos: {
    vendor_id: string;
    vendor_slug: string;
    display_name: string;
    logo_url: string | null;
    offer_id: string;
    offer_variant_id: string;
    price: string;
  }[];
}

interface DiscoveryPageDto {
  page: number;
  page_size: number;
  total: number;
  items: ComparisonCardDto[];
}

const AVAILABILITY_LABEL: Record<string, string> = {
  available: "متوفر",
  low_stock: "كمية محدودة",
  sold_out: "غير متوفر",
};

// Sprint 8 (RB-STOREF-004, PDR-013/014/015): the public "All" discovery
// page - the only discovery surface this sprint builds (the four
// Women/Men/Kids/Accessories segment pages are RB-STOREF-004b, Should,
// deferred). Cards are the exact global comparison card RB-COMP-001
// defines - clicking the card opens the cheapest eligible offer inside
// its store; clicking a store logo opens THAT store's offer instead
// (PDR-015) - never the comparison page directly and never a cart.
export default function DiscoveryAllPage() {
  const router = useRouter();
  const [data, setData] = useState<DiscoveryPageDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  useEffect(() => {
    apiFetch<DiscoveryPageDto>(`/discovery/all?page=${page}&page_size=24`, {
      auth: false,
    })
      .then(setData)
      .catch((err) => {
        setError(
          err instanceof ApiError ? err.message : "تعذّر تحميل صفحة الاكتشاف",
        );
      });
  }, [page]);

  function openOffer(vendorSlug: string, offerId: string) {
    router.push(`/store/${vendorSlug}/products/${offerId}`);
  }

  return (
    <div className="page-shell">
      <div className="wide-shell">
        <div className="brand" style={{ textAlign: "right" }}>
          اكتشف المنتجات
        </div>

        {error && <div className="error-banner">{error}</div>}

        {!data && !error && <p className="muted">جارٍ التحميل...</p>}

        {data && data.items.length === 0 && (
          <p className="muted">لا توجد منتجات متاحة للمقارنة حالياً.</p>
        )}

        {data && data.items.length > 0 && (
          <>
            <div className="product-grid">
              {data.items.map((card) => (
                <div
                  key={card.canonical_product_id}
                  className="product-card"
                  onClick={() =>
                    openOffer(
                      card.cheapest_offer.vendor_slug,
                      card.cheapest_offer.offer_id,
                    )
                  }
                >
                  <div className="product-card-name">
                    {card.canonical_name_ar}
                  </div>
                  <div className="product-card-price">
                    {card.lowest_price} ₪
                  </div>
                  <span
                    className={`availability-badge availability-${card.lowest_price_availability}`}
                  >
                    {AVAILABILITY_LABEL[card.lowest_price_availability]}
                  </span>
                  <div className="product-card-logos">
                    {card.store_logos.map((logo) => (
                      <button
                        key={logo.vendor_id}
                        className="store-logo-button"
                        title={logo.display_name}
                        onClick={(e) => {
                          e.stopPropagation();
                          openOffer(logo.vendor_slug, logo.offer_id);
                        }}
                      >
                        {logo.logo_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={logo.logo_url}
                            alt={logo.display_name}
                            className="store-logo-img"
                          />
                        ) : (
                          <span className="store-logo-placeholder">
                            {logo.display_name.slice(0, 1)}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div
              style={{
                display: "flex",
                gap: 8,
                justifyContent: "center",
                marginTop: 24,
              }}
            >
              <button
                className="button-link"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                السابق
              </button>
              <span className="muted">
                صفحة {data.page} من{" "}
                {Math.max(1, Math.ceil(data.total / data.page_size))}
              </span>
              <button
                className="button-link"
                disabled={page * data.page_size >= data.total}
                onClick={() => setPage((p) => p + 1)}
              >
                التالي
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
