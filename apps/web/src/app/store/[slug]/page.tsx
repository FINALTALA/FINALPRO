"use client";

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

// Sprint 7 (RB-STOREF-001, PDR-011): the public storefront page - no
// auth, no session, reachable by anyone via the vendor's stable slug.
// Deliberately minimal (RB-STOREF-002's sections/All/New/Discounts and
// RB-COMP's comparison card are Sprint 8, out of scope here) - just the
// store's identity, bio, cover, and external contact links.
// "المحل غير متاح حالياً" is shown as a status alongside the identity,
// never a 404 - matches GET /storefronts/:slug's own contract of
// always resolving for an existing vendor regardless of availability.
export default function StorefrontPage() {
  const params = useParams<{ slug: string }>();
  const [store, setStore] = useState<StorefrontDto | null>(null);
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
    </div>
  );
}
