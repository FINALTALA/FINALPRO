"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import StoreCircle from "@/components/StoreCircle";
import { EmptyState, ErrorBanner, SkeletonGrid } from "@/components/States";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { AVAILABILITY_LABEL, Availability } from "@/lib/types";
import { useSessionToken } from "@/lib/useSession";
import { useFetch } from "@/lib/useFetch";

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
  // null for an unmatched variant - the signal for whether a "compare
  // prices" action can be shown at all.
  canonical_product_id: string | null;
  structural_attributes: Record<string, unknown> | null;
  availability: Availability;
}

interface OfferDetailDto {
  id: string;
  vendor_id: string;
  vendor_slug: string;
  vendor_display_name: string;
  title_ar: string;
  title_en: string;
  images: string[];
  variants: OfferVariantDto[];
}

interface StorefrontLogoDto {
  logo_url: string | null;
}

function optionLabel(v: OfferVariantDto, index: number): string {
  const values = Object.values(v.structural_attributes ?? {}).filter(
    (x) => typeof x === "string" && x !== "",
  );
  return values.length > 0 ? values.join(" / ") : `خيار ${index + 1}`;
}

// Sprint 8 (RB-COMP-001, PDR-015/016): the in-store product page a
// comparison/discovery card lands on. Sprint 10 (PDR-002): "أضف للسلة"
// needs a signed-in customer (a guest is sent to sign in and returned
// here). Sprint 13: real gallery, real option chips (only the values
// the product actually has), store strip, store count, and a direct
// path on to the cart.
export default function StoreProductPage() {
  const params = useParams<{ slug: string; offerId: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const token = useSessionToken();
  const offer = useFetch<OfferDetailDto>(`/storefronts/${params.slug}/offers/${params.offerId}`);
  const store = useFetch<StorefrontLogoDto>(`/storefronts/${params.slug}`);
  const [selected, setSelected] = useState<string | null>(null);
  const [imageIndex, setImageIndex] = useState(0);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);
  const [cartError, setCartError] = useState<string | null>(null);

  const data = offer.data;
  const variant = data ? (data.variants.find((v) => v.id === selected) ?? data.variants[0]) : null;
  const canonicalId = data?.variants.find((v) => v.canonical_product_id)?.canonical_product_id ?? null;
  const card = useFetch<{ store_count: number }>(
    canonicalId ? `/canonical-products/${canonicalId}/comparison-card` : null,
  );

  async function addToCart() {
    if (!token) {
      router.push(`/login?next=${encodeURIComponent(pathname)}`);
      return;
    }
    if (!data || !variant) return;
    setAdding(true);
    setCartError(null);
    try {
      await apiFetch("/cart/items", {
        method: "POST",
        body: { vendor_id: data.vendor_id, offer_variant_id: variant.id, quantity: 1 },
        idempotencyKey: newIdempotencyKey("cart-add"),
      });
      setAdded(true);
    } catch (err) {
      setCartError(err instanceof ApiError ? err.message : "تعذّرت الإضافة للسلة");
    } finally {
      setAdding(false);
    }
  }

  if (offer.error) {
    return (
      <div className="page-shell">
        <div className="wide-shell">
          {offer.status === 404 ? (
            <EmptyState title="المنتج غير موجود" actionHref={`/store/${params.slug}`} actionLabel="العودة للمتجر" />
          ) : (
            <ErrorBanner message="تعذّر تحميل تفاصيل المنتج" />
          )}
        </div>
      </div>
    );
  }
  if (!data || !variant) {
    return (
      <div className="page-shell">
        <div className="wide-shell"><SkeletonGrid count={2} /></div>
      </div>
    );
  }

  const price = variant.sale_price ?? variant.base_price;
  const images = data.images;
  const soldOut = variant.availability === "sold_out";

  return (
    <div className="page-shell">
      <div className="product-layout">
        <div>
          <div className="product-gallery-main">
            {images.length > 0 ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={images[imageIndex] ?? images[0]} alt={data.title_ar} />
            ) : (
              <span className="product-card-noimage">لا توجد صورة لهذا المنتج</span>
            )}
          </div>
          {images.length > 1 && (
            <div className="product-gallery-thumbs">
              {images.map((src, i) => (
                <button
                  key={src}
                  className={i === imageIndex ? "active" : ""}
                  onClick={() => setImageIndex(i)}
                  aria-label={`صورة ${i + 1}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt="" />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="product-info">
          <Link href={`/store/${data.vendor_slug}`} className="store-strip">
            <StoreCircle name={data.vendor_display_name} logoUrl={store.data?.logo_url ?? null} size={40} />
            <span>
              <strong>{data.vendor_display_name}</strong>
              <br />
              <span className="muted">زيارة صفحة المتجر</span>
            </span>
          </Link>

          <h1>{data.title_ar}</h1>

          <div className="price-row">
            <span className="price-now">{price} ₪</span>
            {variant.sale_price && <span className="price-old">{variant.base_price} ₪</span>}
            <span className={`availability-badge availability-${variant.availability}`}>
              {AVAILABILITY_LABEL[variant.availability]}
            </span>
          </div>

          {card.data && (
            <p className="muted" style={{ margin: "0 0 12px" }}>
              يباع في {card.data.store_count === 1 ? "متجر واحد" : `${card.data.store_count} متاجر`}
            </p>
          )}

          {data.variants.length > 1 && (
            <>
              <div style={{ fontWeight: 700 }}>اختاري الخيار</div>
              <div className="variant-picker" role="group" aria-label="خيارات المنتج">
                {data.variants.map((v, i) => (
                  <button
                    key={v.id}
                    className={`variant-chip${v.id === variant.id ? " active" : ""}`}
                    onClick={() => {
                      setSelected(v.id);
                      setAdded(false);
                    }}
                  >
                    {optionLabel(v, i)}
                  </button>
                ))}
              </div>
            </>
          )}

          {variant.specs_text_ar && <p className="muted">{variant.specs_text_ar}</p>}

          {cartError && <ErrorBanner message={cartError} />}
          {added && (
            <div className="notice-banner" role="status">
              أُضيف إلى السلة. <Link href="/cart">اذهبي إلى السلة</Link> لإكمال الشراء.
            </div>
          )}

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="button" disabled={adding || soldOut} onClick={addToCart}>
              {soldOut ? "غير متوفر" : adding ? "جارٍ الإضافة..." : token ? "أضيفي للسلة" : "سجّلي الدخول للشراء"}
            </button>
            {variant.canonical_product_id && (
              <Link href={`/compare/${variant.canonical_product_id}`} className="button button-secondary">
                قارني الأسعار
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
