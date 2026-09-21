"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/api";

interface StorefrontDto {
  slug: string;
  display_name: string;
  logo_url: string | null;
  bio: string | null;
  cover_image_url: string | null;
  cover_color: string | null;
  instagram_url: string | null;
  facebook_url: string | null;
  whatsapp_url: string | null;
  is_available: boolean;
}

interface OfferSummaryDto {
  id: string;
  title_ar: string;
  title_en: string;
  min_price: string | null;
  availability: "available" | "low_stock" | "sold_out";
}

interface CustomSectionDto {
  id: string;
  name: string;
  offers: OfferSummaryDto[];
}

interface StoreSectionsDto {
  is_available: boolean;
  all: OfferSummaryDto[];
  new_arrivals: OfferSummaryDto[];
  discounts: OfferSummaryDto[];
  custom: CustomSectionDto[];
}

const AVAILABILITY_LABEL: Record<string, string> = {
  available: "متوفر",
  low_stock: "كمية محدودة",
  sold_out: "غير متوفر",
};

// Sprint 7 (RB-STOREF-001, PDR-011): the public storefront page - no
// auth, no session, reachable by anyone via the vendor's stable slug.
// "المحل غير متاح حالياً" is shown as a status alongside the identity,
// never a 404 - matches GET /storefronts/:slug's own contract of
// always resolving for an existing vendor regardless of availability.
//
// Sprint 8 (RB-STOREF-002, PDR-012): adds the fixed All / automatic New
// arrivals+Discounts / owner-created custom sections as tabs, each
// backed by GET /storefronts/:slug/sections. A product card here routes
// to /store/:slug/products/:offerId - the same in-store product detail
// page a comparison-card logo click also lands on.
export default function StorefrontPage() {
  const params = useParams<{ slug: string }>();
  const [store, setStore] = useState<StorefrontDto | null>(null);
  const [sections, setSections] = useState<StoreSectionsDto | null>(null);
  const [activeTab, setActiveTab] = useState<string>("all");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<StorefrontDto>(`/storefronts/${params.slug}`, { auth: false })
      .then(setStore)
      .catch((err) => {
        setError(
          err instanceof ApiError && err.status === 404
            ? "لا يوجد متجر بهذا الرابط"
            : "تعذّر تحميل صفحة المتجر",
        );
      });
    apiFetch<StoreSectionsDto>(`/storefronts/${params.slug}/sections`, {
      auth: false,
    })
      .then(setSections)
      .catch(() => {
        // Sections are a secondary enhancement to the page's own
        // identity fetch above - a failure here degrades to no product
        // grid, not a page-level error (the identity fetch's own error
        // handling already covers "store not found" for both).
      });
  }, [params.slug]);

  if (error) {
    return (
      <div className="page-shell">
        <div className="error-banner" style={{ maxWidth: 560, width: "100%" }}>
          {error}
        </div>
      </div>
    );
  }

  if (!store) {
    return (
      <div className="page-shell">
        <p className="muted">جارٍ التحميل...</p>
      </div>
    );
  }

  const contacts = [
    store.instagram_url && { label: "إنستغرام", url: store.instagram_url },
    store.facebook_url && { label: "فيسبوك", url: store.facebook_url },
    store.whatsapp_url && { label: "واتساب", url: store.whatsapp_url },
  ].filter((c): c is { label: string; url: string } => Boolean(c));

  return (
    <div className="page-shell">
      <div className="storefront-card">
        <div
          className="storefront-cover"
          style={{
            backgroundColor: store.cover_color ?? "var(--color-border)",
            backgroundImage: store.cover_image_url
              ? `url(${store.cover_image_url})`
              : undefined,
          }}
        />
        <div className="storefront-header">
          {store.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={store.logo_url} alt={store.display_name} className="storefront-logo" />
          ) : (
            <div className="storefront-logo storefront-logo-placeholder">
              {store.display_name.slice(0, 1)}
            </div>
          )}
          <div>
            <div className="storefront-name">{store.display_name}</div>
            <span className={`badge${store.is_available ? " badge-active" : ""}`}>
              {store.is_available ? "متاح الآن" : "المحل غير متاح حالياً"}
            </span>
          </div>
        </div>

        {store.bio && <p className="storefront-bio">{store.bio}</p>}

        {contacts.length > 0 && (
          <div className="storefront-contacts">
            {contacts.map((c) => (
              <a
                key={c.label}
                href={c.url}
                target="_blank"
                rel="noopener noreferrer"
                className="button-link"
              >
                {c.label}
              </a>
            ))}
          </div>
        )}
      </div>

      {sections && (
        <div className="wide-shell" style={{ marginTop: 20 }}>
          <div className="section-tabs">
            <button
              className={`section-tab${activeTab === "all" ? " active" : ""}`}
              onClick={() => setActiveTab("all")}
            >
              الكل
            </button>
            <button
              className={`section-tab${activeTab === "new_arrivals" ? " active" : ""}`}
              onClick={() => setActiveTab("new_arrivals")}
            >
              وصل حديثاً
            </button>
            <button
              className={`section-tab${activeTab === "discounts" ? " active" : ""}`}
              onClick={() => setActiveTab("discounts")}
            >
              تخفيضات
            </button>
            {sections.custom.map((section) => (
              <button
                key={section.id}
                className={`section-tab${activeTab === section.id ? " active" : ""}`}
                onClick={() => setActiveTab(section.id)}
              >
                {section.name}
              </button>
            ))}
          </div>

          {(() => {
            const offers =
              activeTab === "all"
                ? sections.all
                : activeTab === "new_arrivals"
                  ? sections.new_arrivals
                  : activeTab === "discounts"
                    ? sections.discounts
                    : (sections.custom.find((s) => s.id === activeTab)?.offers ??
                      []);

            if (offers.length === 0) {
              return <p className="muted">لا توجد منتجات في هذا القسم.</p>;
            }

            return (
              <div className="product-grid">
                {offers.map((offer) => (
                  <Link
                    key={offer.id}
                    href={`/store/${params.slug}/products/${offer.id}`}
                    className="product-card"
                  >
                    <div className="product-card-name">{offer.title_ar}</div>
                    {offer.min_price && (
                      <div className="product-card-price">
                        {offer.min_price} ₪
                      </div>
                    )}
                    <span
                      className={`availability-badge availability-${offer.availability}`}
                    >
                      {AVAILABILITY_LABEL[offer.availability]}
                    </span>
                  </Link>
                ))}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
