"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import ProductCard from "@/components/ProductCard";
import { EmptyState, ErrorBanner } from "@/components/States";
import ZonePicker, { type FulfilmentContext, type ZoneChoice } from "@/components/ZonePicker";
import { collectionDescription, collectionTitle, PublicCollection } from "@/lib/publicCollections";
import { useSessionToken } from "@/lib/useSession";
import { useFetch } from "@/lib/useFetch";
import { useLang } from "@/lib/useLang";

// PD-5b.4: one live platform collection - its title, description and the
// standard product cards (a click opens the price comparison first). The
// API decides which products a shopper in the chosen zone can buy now:
// the default address zone when signed in (never GPS), a zone picked
// with the product page's own picker (PD-2), or every zone. Nothing
// administrative is shown.
export default function CollectionPage() {
  const params = useParams<{ slug: string }>();
  const lang = useLang();
  const token = useSessionToken();
  const [zone, setZone] = useState<ZoneChoice>("");
  const collection = useFetch<PublicCollection & { fulfilment_context: FulfilmentContext }>(
    `/collections/${encodeURIComponent(params.slug)}${zone ? `?zone=${zone}` : ""}`,
    true,
  );
  const en = lang === "en";

  if (collection.status === 404) {
    return (
      <div className="page-shell">
        <EmptyState
          title={en ? "This collection isn't available" : "هذه المجموعة غير متاحة"}
          message={en ? "It may have ended or been removed." : "ربما انتهت فترة عرضها أو أُزيلت."}
          actionHref="/"
          actionLabel={en ? "Home" : "الرئيسية"}
        />
      </div>
    );
  }

  const c = collection.data;
  const description = c ? collectionDescription(c, lang) : null;

  return (
    <div className="page-shell collection-page">
      <div className="wide-shell">
        {collection.error && !c && (
          <>
            <ErrorBanner message={collection.error} />
            <button type="button" className="button button-secondary" onClick={() => window.location.reload()}>
              {en ? "Try again" : "إعادة المحاولة"}
            </button>
          </>
        )}
        {!c && !collection.error && <div className="skeleton" style={{ height: 160, width: "100%" }} aria-busy="true" />}
        {c && (
          <>
            <header className="collection-page-head">
              <div>
                <h1 className="page-title">{collectionTitle(c, lang)}</h1>
                {description && <p className="page-subtitle">{description}</p>}
              </div>
              <div className="collection-zone">
                <label>
                  <span>{en ? "Delivery area" : "منطقة التوصيل"}</span>
                  <ZonePicker value={zone} onChange={setZone} defaultZone={c.fulfilment_context.default_zone} lang={lang} />
                </label>
                {token && !c.fulfilment_context.default_zone && (
                  <Link href="/account/addresses" className="collection-zone-hint">
                    {en ? "Add a default address to see what reaches your area" : "أضيفي عنواناً افتراضياً لمعرفة ما يصل إلى منطقتك"}
                  </Link>
                )}
              </div>
            </header>
            {c.products.length === 0 ? (
              <EmptyState
                title={en ? "No products in this collection are available right now" : "لا توجد منتجات متاحة في هذه المجموعة حالياً"}
                message={zone ? (en ? "Try another area." : "جرّبي منطقة أخرى.") : undefined}
              />
            ) : (
              <div className="product-grid collection-page-grid" aria-busy={collection.loading}>
                {c.products.map((card) => (
                  <ProductCard key={card.canonical_product_id} card={card} />
                ))}
              </div>
            )}
            <p className="muted collection-page-foot">
              <Link href="/discovery">{en ? "Discover more products" : "اكتشفي المزيد من المنتجات"}</Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
