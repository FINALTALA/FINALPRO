"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import SafeImage from "@/components/SafeImage";
import StoreCircle from "@/components/StoreCircle";
import { EmptyState, ErrorBanner, SkeletonGrid } from "@/components/States";
import { apiFetch, ApiError } from "@/lib/api";
import { AVAILABILITY_LABEL, Availability } from "@/lib/types";
import { useFetch } from "@/lib/useFetch";
import { useSessionToken } from "@/lib/useSession";

const ZONES = [
  { value: "", label: "بدون تحديد منطقة" },
  { value: "WEST_BANK", label: "الضفة الغربية" },
  { value: "JERUSALEM", label: "القدس" },
  { value: "INSIDE", label: "الداخل" },
];

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
  // Sprint 24 (FR-COMP-003/005/006).
  condition: string;
  warranty_period: string;
  warranty_type: string;
  delivery_fee: number | null;
  delivery_fee_status: "NO_ZONE_SELECTED" | "AVAILABLE" | "NOT_AVAILABLE_IN_ZONE";
  rating: number | null;
  rating_count: number;
  is_price_stale: boolean;
  is_cheapest?: boolean;
  cheapest_reason?: string;
}

interface DiffFieldDto {
  field: string;
  values: (string | number | boolean | null)[];
  all_same: boolean;
}

interface ComparisonPageDto {
  canonical_product_id: string;
  canonical_name_ar: string;
  canonical_name_en: string;
  variants: VariantOptionDto[];
  offers: ComparisonOfferDto[];
  diff: DiffFieldDto[];
}

const FIELD_LABEL: Record<string, string> = {
  condition: "الحالة",
  warranty_period: "مدة الضمان",
  warranty_type: "نوع الضمان",
};

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
  const token = useSessionToken();
  const [variantId, setVariantId] = useState<string | null>(null);
  const [zone, setZone] = useState("");
  const [favorited, setFavorited] = useState(false);
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const [addedToSet, setAddedToSet] = useState(false);
  const base = `/canonical-products/${params.canonicalProductId}/comparison`;
  const zoneQuery = zone ? `zone=${zone}` : "";
  // The unfiltered response always drives the header and the option
  // chips (so filtering never removes the other choices); a selected
  // colour/size is a second, filtered request that only supplies offers.
  const full = useFetch<ComparisonPageDto>(zoneQuery ? `${base}?${zoneQuery}` : base);
  const filtered = useFetch<ComparisonPageDto>(
    variantId
      ? `${base}?canonical_variant_id=${variantId}${zoneQuery ? `&${zoneQuery}` : ""}`
      : null,
  );
  const { data: fullData, error, status, loading } = full;
  const data = fullData
    ? { ...fullData, offers: variantId ? (filtered.data?.offers ?? []) : fullData.offers }
    : null;
  const offersLoading = variantId !== null && filtered.loading;

  async function addFavorite() {
    if (!token || favoriteBusy) return;
    setFavoriteBusy(true);
    try {
      await apiFetch("/favorites", {
        method: "POST",
        body: { target_type: "PRODUCT", canonical_product_id: params.canonicalProductId },
      });
      setFavorited(true);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
    } finally {
      setFavoriteBusy(false);
    }
  }

  async function addToNewSet() {
    if (!token) return;
    try {
      await apiFetch("/customers/me/comparison-sets", {
        method: "POST",
        body: { canonical_product_ids: [params.canonicalProductId] },
      });
      setAddedToSet(true);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
    }
  }

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
            <SafeImage src={image} alt={data.canonical_name_ar} className="compare-thumb" />
          ) : null}
          <div>
            <h1 className="page-title">{data.canonical_name_ar}</h1>
            <p className="page-subtitle" style={{ margin: 0 }}>
              مقارنة الأسعار بين {data.offers.length === 1 ? "عرض واحد" : `${data.offers.length} عروض`}
              {cheapest ? ` - الأقل: ${cheapest.price} ₪` : ""}
            </p>
          </div>
        </div>

        {token && (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
            <button className="button-link" disabled={favorited || favoriteBusy} onClick={addFavorite}>
              {favorited ? "في المفضلة" : "أضيفي للمفضلة"}
            </button>
            <button className="button-link" disabled={addedToSet} onClick={addToNewSet}>
              {addedToSet ? "أُضيف لمجموعة مقارنة جديدة" : "أضيفي لمجموعة مقارنة جديدة"}
            </button>
            <Link href="/compare/sets" className="button-link">مجموعاتي المحفوظة</Link>
          </div>
        )}

        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14 }}>
          <label className="muted" htmlFor="compare-zone">منطقة التوصيل:</label>
          <select id="compare-zone" value={zone} onChange={(e) => setZone(e.target.value)}>
            {ZONES.map((z) => (
              <option key={z.value} value={z.value}>{z.label}</option>
            ))}
          </select>
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
            {data.offers.map((offer) => {
              const href = `/store/${offer.vendor_slug}/products/${offer.offer_id}`;
              return (
                <div key={offer.offer_variant_id} className={`compare-card${offer.is_cheapest ? " best" : ""}`}>
                  {offer.is_cheapest && (
                    <span className="compare-rank">{offer.cheapest_reason ?? "الأرخص"}</span>
                  )}
                  <Link href={href} style={{ display: "flex", gap: 10, alignItems: "center", textDecoration: "none", color: "inherit" }}>
                    <span className="store-circle">
                      {offer.logo_url ? (
                        <SafeImage src={offer.logo_url} alt={offer.display_name} />
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
                  {offer.is_price_stale && (
                    <span className="muted" style={{ fontSize: 12 }}>⚠ بيانات السعر قديمة</span>
                  )}
                  <div className="muted" style={{ fontSize: 13 }}>الضمان: {offer.warranty_period}</div>
                  {offer.delivery_fee_status === "AVAILABLE" && (
                    <div className="muted" style={{ fontSize: 13 }}>رسوم التوصيل: {offer.delivery_fee} ₪</div>
                  )}
                  {offer.delivery_fee_status === "NOT_AVAILABLE_IN_ZONE" && (
                    <div className="muted" style={{ fontSize: 13 }}>لا توصيل لهذه المنطقة</div>
                  )}
                  {typeof offer.rating === "number" && (
                    <div className="muted" style={{ fontSize: 13 }}>
                      التقييم: {offer.rating.toFixed(1)} ({offer.rating_count})
                    </div>
                  )}
                  <Link href={href} className="button button-block" style={{ marginTop: "auto" }}>
                    افتحي في المتجر
                  </Link>
                </div>
              );
            })}
          </div>
        )}

        {data.diff.some((d) => !d.all_same) && (
          <div className="card" style={{ marginTop: 16 }}>
            <strong style={{ display: "block", marginBottom: 8 }}>الفروقات بين العروض</strong>
            {data.diff
              .filter((d) => !d.all_same)
              .map((d) => (
                <div key={d.field} className="muted" style={{ fontSize: 13 }}>
                  {FIELD_LABEL[d.field] ?? d.field}: {d.values.map((v) => String(v ?? "غير متوفر")).join(" / ")}
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
