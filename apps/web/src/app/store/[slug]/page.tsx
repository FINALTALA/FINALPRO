"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { ShareIcon } from "@/components/Icons";
import { EmptyState, ErrorBanner, SkeletonGrid } from "@/components/States";
import { ApiError, apiFetch } from "@/lib/api";
import { AVAILABILITY_LABEL, Availability } from "@/lib/types";
import { useSessionToken } from "@/lib/useSession";
import { useFetch } from "@/lib/useFetch";

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
  availability: Availability;
  image_url: string | null;
}

interface StoreSectionsDto {
  is_available: boolean;
  all: OfferSummaryDto[];
  new_arrivals: OfferSummaryDto[];
  discounts: OfferSummaryDto[];
  custom: { id: string; name: string; offers: OfferSummaryDto[] }[];
}

const FEATURED_COUNT = 4;

function OfferCard({ slug, offer }: { slug: string; offer: OfferSummaryDto }) {
  return (
    <Link href={`/store/${slug}/products/${offer.id}`} className="product-card">
      <div className="product-card-media">
        {offer.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={offer.image_url} alt={offer.title_ar} loading="lazy" />
        ) : (
          <span className="product-card-noimage">لا توجد صورة</span>
        )}
      </div>
      <div className="product-card-body">
        <div className="product-card-name">{offer.title_ar}</div>
        {offer.min_price && <div className="product-card-price">{offer.min_price} ₪</div>}
        <span className={`availability-badge availability-${offer.availability}`}>
          {AVAILABILITY_LABEL[offer.availability]}
        </span>
      </div>
    </Link>
  );
}

// Sprint 7/8 (RB-STOREF-001/002, PDR-011/012): the public storefront.
// Sprint 13: cover, circular logo, share, contacts, a real follow
// button (persisted server-side, sign-in required), section chips,
// featured products (newest first - view-based ranking is still
// deferred) and the full product list. "المحل غير متاح حالياً" stays a
// status beside the identity, never a 404.
export default function StorefrontPage() {
  const params = useParams<{ slug: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const token = useSessionToken();
  const store = useFetch<StorefrontDto>(`/storefronts/${params.slug}`);
  const sections = useFetch<StoreSectionsDto>(`/storefronts/${params.slug}/sections`);
  const followStatus = useFetch<{ following: boolean }>(
    token ? `/customers/me/following/${params.slug}` : null,
    true,
  );
  const [activeTab, setActiveTab] = useState("all");
  const [override, setOverride] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const following = override ?? followStatus.data?.following ?? false;

  async function toggleFollow() {
    if (!token) {
      router.push(`/login?next=${encodeURIComponent(pathname)}`);
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const res = await apiFetch<{ following: boolean }>(
        `/customers/me/following/${params.slug}`,
        { method: following ? "DELETE" : "PUT" },
      );
      setOverride(res.following);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "تعذّر تحديث المتابعة");
    } finally {
      setBusy(false);
    }
  }

  async function share() {
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: store.data?.display_name, url });
      } else {
        await navigator.clipboard.writeText(url);
        setNotice("تم نسخ رابط المتجر");
        setTimeout(() => setNotice(null), 2500);
      }
    } catch {
      // The user dismissed the share sheet - nothing to report.
    }
  }

  if (store.error) {
    return (
      <div className="page-shell">
        <div className="wide-shell">
          {store.status === 404 ? (
            <EmptyState title="لا يوجد متجر بهذا الرابط" actionHref="/discovery" actionLabel="اكتشفي المنتجات" />
          ) : (
            <ErrorBanner message="تعذّر تحميل صفحة المتجر" />
          )}
        </div>
      </div>
    );
  }
  if (!store.data) {
    return (
      <div className="page-shell">
        <div className="wide-shell"><SkeletonGrid count={4} /></div>
      </div>
    );
  }

  const s = store.data;
  const contacts = [
    s.instagram_url && { label: "إنستغرام", url: s.instagram_url },
    s.facebook_url && { label: "فيسبوك", url: s.facebook_url },
    s.whatsapp_url && { label: "واتساب", url: s.whatsapp_url },
  ].filter((c): c is { label: string; url: string } => Boolean(c));

  const sec = sections.data;
  const tabOffers = !sec
    ? []
    : activeTab === "all"
      ? sec.all
      : activeTab === "new_arrivals"
        ? sec.new_arrivals
        : activeTab === "discounts"
          ? sec.discounts
          : (sec.custom.find((c) => c.id === activeTab)?.offers ?? []);

  return (
    <div className="page-shell">
      <div className="storefront-card">
        <div
          className="storefront-cover"
          style={{
            backgroundColor: s.cover_color ?? undefined,
            backgroundImage: s.cover_image_url ? `url(${s.cover_image_url})` : undefined,
          }}
        />
        <div className="storefront-header">
          {s.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={s.logo_url} alt={s.display_name} className="storefront-logo" />
          ) : (
            <div className="storefront-logo storefront-logo-placeholder">{s.display_name.slice(0, 1)}</div>
          )}
          <div className="storefront-title">
            <h1 className="storefront-name">{s.display_name}</h1>
            <span className={`badge${s.is_available ? " badge-active" : ""}`}>
              {s.is_available ? "متاح الآن" : "المحل غير متاح حالياً"}
            </span>
          </div>
          <div className="storefront-actions">
            <button
              className={following ? "button button-secondary" : "button"}
              onClick={toggleFollow}
              disabled={busy || (!s.is_available && !following)}
              aria-pressed={following}
            >
              {following ? "إلغاء المتابعة" : "تابعي المتجر"}
            </button>
            <button className="button-link" onClick={share} aria-label="مشاركة المتجر">
              <ShareIcon /> مشاركة
            </button>
          </div>
        </div>

        {s.bio && <p className="storefront-bio">{s.bio}</p>}

        {contacts.length > 0 && (
          <div className="storefront-contacts">
            {contacts.map((c) => (
              <a key={c.label} href={c.url} target="_blank" rel="noopener noreferrer" className="button-link">
                {c.label}
              </a>
            ))}
          </div>
        )}
      </div>

      <div className="wide-shell" style={{ marginTop: 16 }}>
        {notice && <div className="notice-banner" role="status">{notice}</div>}
        {actionError && <ErrorBanner message={actionError} />}
        {!s.is_available && (
          <div className="warning-banner">هذا المتجر غير متاح حالياً، ولا يمكن الطلب منه الآن.</div>
        )}

        {sections.loading && <SkeletonGrid count={4} />}

        {sec && sec.all.length === 0 && s.is_available && (
          <EmptyState title="لا توجد منتجات في المتجر بعد" />
        )}

        {sec && sec.all.length > 0 && (
          <>
            <div className="section-heading">
              <h2>منتجات مميزة</h2>
              <span className="muted">الأحدث أولاً</span>
            </div>
            <div className="product-grid">
              {sec.all.slice(0, FEATURED_COUNT).map((o) => (
                <OfferCard key={o.id} slug={params.slug} offer={o} />
              ))}
            </div>

            <div className="section-heading">
              <h2>كل المنتجات</h2>
            </div>
            <div className="section-tabs" role="tablist" aria-label="أقسام المتجر">
              {[
                { id: "all", label: "الكل" },
                { id: "new_arrivals", label: "وصل حديثاً" },
                { id: "discounts", label: "تخفيضات" },
                ...sec.custom.map((c) => ({ id: c.id, label: c.name })),
              ].map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={activeTab === t.id}
                  className={`section-tab${activeTab === t.id ? " active" : ""}`}
                  onClick={() => setActiveTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {tabOffers.length === 0 ? (
              <p className="muted">لا توجد منتجات في هذا القسم.</p>
            ) : (
              <div className="product-grid">
                {tabOffers.map((o) => (
                  <OfferCard key={o.id} slug={params.slug} offer={o} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
