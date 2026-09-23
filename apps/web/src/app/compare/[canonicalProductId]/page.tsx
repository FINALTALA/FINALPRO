"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import StoreCircle from "@/components/StoreCircle";
import { EmptyState, ErrorBanner, SkeletonGrid } from "@/components/States";
import { AVAILABILITY_LABEL, Availability } from "@/lib/types";
import { useFetch } from "@/lib/useFetch";

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
  availability: Availability;
  image_url: string | null;
}

interface ComparisonPageDto {
  canonical_product_id: string;
  canonical_name_ar: string;
  canonical_name_en: string;
  variants: VariantOptionDto[];
  offers: ComparisonOfferDto[];
}

function variantLabel(attrs: Record<string, unknown>): string {
  const values = Object.values(attrs).filter((v) => v !== null && v !== undefined && v !== "");
  return values.length > 0 ? values.join(" / ") : "خيار واحد";
}

// Sprint 8 (RB-COMP-001, PDR-016): every eligible store offer, lowest to
// highest, in a card grid; a chosen colour/size limits the results.
// Never offers "add to cart" here - the customer must enter the store's
// own product page first (cards route there, never to a cart).
export default function ComparisonPage() {
  const params = useParams<{ canonicalProductId: string }>();
  const [variantId, setVariantId] = useState<string | null>(null);
  const base = `/canonical-products/${params.canonicalProductId}/comparison`;
  // The unfiltered response always drives the header and the option
  // chips (so filtering never removes the other choices); a selected
  // colour/size is a second, filtered request that only supplies offers.
  const full = useFetch<ComparisonPageDto>(base);
  const filtered = useFetch<ComparisonPageDto>(
    variantId ? `${base}?canonical_variant_id=${variantId}` : null,
  );
  const { data: fullData, error, status, loading } = full;
  const data = fullData
    ? { ...fullData, offers: variantId ? (filtered.data?.offers ?? []) : fullData.offers }
    : null;
  const offersLoading = variantId !== null && filtered.loading;

  if (error) {
    return (
      <div className="page-shell">
        <div className="wide-shell">
          {status === 404 ? (
            <EmptyState
              title="لا توجد عروض مؤهلة لهذا المنتج حالياً"
              actionHref="/discovery"
              actionLabel="العودة للاكتشاف"
            />
          ) : (
            <ErrorBanner message="تعذّر تحميل صفحة المقارنة" />
          )}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="page-shell">
        <div className="wide-shell">{loading && <SkeletonGrid count={4} />}</div>
      </div>
    );
  }

  const image = data.offers.find((o) => o.image_url)?.image_url ?? null;
  const cheapest = data.offers[0];

  return (
    <div className="page-shell">
      <div className="wide-shell">
        <div className="compare-header">
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={image} alt={data.canonical_name_ar} className="compare-thumb" />
          ) : null}
          <div>
            <h1 className="page-title">{data.canonical_name_ar}</h1>
            <p className="page-subtitle" style={{ margin: 0 }}>
              مقارنة الأسعار بين {data.offers.length === 1 ? "عرض واحد" : `${data.offers.length} عروض`}
              {cheapest ? ` - الأقل: ${cheapest.price} ₪` : ""}
            </p>
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
          <span className="muted">المتاجر:</span>
          {data.offers.map((o) => (
            <StoreCircle
              key={o.offer_variant_id}
              name={o.display_name}
              logoUrl={o.logo_url}
              href={`/store/${o.vendor_slug}/products/${o.offer_id}`}
              size={44}
            />
          ))}
        </div>

        {data.variants.length > 1 && (
          <div className="variant-picker" role="group" aria-label="اللون والمقاس">
            <button
              className={`variant-chip${variantId === null ? " active" : ""}`}
              onClick={() => setVariantId(null)}
            >
              كل الخيارات
            </button>
            {data.variants.map((v) => (
              <button
                key={v.id}
                className={`variant-chip${variantId === v.id ? " active" : ""}`}
                onClick={() => setVariantId(v.id)}
              >
                {variantLabel(v.structural_attributes)}
              </button>
            ))}
          </div>
        )}

        {offersLoading ? (
          <SkeletonGrid count={4} />
        ) : data.offers.length === 0 ? (
          <EmptyState title="لا توجد عروض لهذا الخيار" message="جرّبي لوناً أو مقاساً آخر." />
        ) : (
          <div className="compare-grid">
            {data.offers.map((offer, i) => {
              const href = `/store/${offer.vendor_slug}/products/${offer.offer_id}`;
              return (
                <div key={offer.offer_variant_id} className={`compare-card${i === 0 ? " best" : ""}`}>
                  {i === 0 && <span className="compare-rank">الأرخص</span>}
                  <Link href={href} style={{ display: "flex", gap: 10, alignItems: "center", textDecoration: "none", color: "inherit" }}>
                    <span className="store-circle">
                      {offer.logo_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={offer.logo_url} alt={offer.display_name} />
                      ) : (
                        offer.display_name.slice(0, 1)
                      )}
                    </span>
                    <span>
                      <strong>{offer.display_name}</strong>
                      <br />
                      <span className="muted">{variantLabel(offer.structural_attributes)}</span>
                    </span>
                  </Link>
                  <div className="product-card-price">{offer.price} ₪</div>
                  <span className={`availability-badge availability-${offer.availability}`}>
                    {AVAILABILITY_LABEL[offer.availability]}
                  </span>
                  <Link href={href} className="button button-block" style={{ marginTop: "auto" }}>
                    افتحي في المتجر
                  </Link>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
