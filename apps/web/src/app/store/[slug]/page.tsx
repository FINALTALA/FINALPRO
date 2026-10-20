"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { CSSProperties, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  ExpandIcon,
  FacebookIcon,
  HeartIcon,
  InstagramIcon,
  SearchIcon,
  SparkleIcon,
  StarIcon,
  TagIcon,
  WhatsAppIcon,
} from "@/components/Icons";
import SafeImage from "@/components/SafeImage";
import { EmptyState, ErrorBanner } from "@/components/States";
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
  is_verified: boolean;
  follower_count: number;
}

interface OfferSummaryDto {
  id: string;
  title_ar: string;
  title_en: string;
  min_price: string | null;
  availability: Availability;
  image_url: string | null;
  created_at: string;
  favorite_variant_id: string | null;
}

interface StoreSectionsDto {
  is_available: boolean;
  all: OfferSummaryDto[];
  new_arrivals: OfferSummaryDto[];
  discounts: OfferSummaryDto[];
  custom: { id: string; name: string; offers: OfferSummaryDto[] }[];
}

interface ReviewsDto {
  aggregate: { average: number | null; count: number };
}

interface FavoriteDto {
  id: string;
  offer_variant_id: string | null;
}

type SortKey = "newest" | "price_asc" | "price_desc";

interface CategoryTab {
  id: string;
  label: string;
  count: number;
  kind: "all" | "smart" | "custom";
  icon?: ReactNode;
}

// The automatic filters get fixed ids in ?cat= - custom sections use
// their own uuid, so the two can never collide.
const NEW_TAB = "new";
const SALE_TAB = "sale";
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const SAFE_URL = /^(https?:\/\/|\/)/;

// offer variant id -> favorite id (the id DELETE /favorites/:id needs).
function favoritesByVariant(rows: FavoriteDto[]): Map<string, string> {
  return new Map(
    rows
      .filter((f) => f.offer_variant_id !== null)
      .map((f) => [f.offer_variant_id as string, f.id]),
  );
}

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

function sortOffers(offers: OfferSummaryDto[], sort: SortKey): OfferSummaryDto[] {
  const price = (o: OfferSummaryDto) =>
    o.min_price === null ? null : Number.parseFloat(o.min_price);
  return [...offers].sort((a, b) => {
    // Available products always come first, sold-out ones last.
    const soldOut = Number(a.availability === "sold_out") - Number(b.availability === "sold_out");
    if (soldOut !== 0) return soldOut;
    if (sort === "newest") return b.created_at.localeCompare(a.created_at);
    const pa = price(a);
    const pb = price(b);
    if (pa === null || pb === null) return pa === null ? (pb === null ? 0 : 1) : -1;
    return sort === "price_asc" ? pa - pb : pb - pa;
  });
}

function OfferCard({
  slug,
  offer,
  favorited,
  busy,
  onToggleFavorite,
}: {
  slug: string;
  offer: OfferSummaryDto;
  favorited: boolean;
  busy: boolean;
  onToggleFavorite: (offer: OfferSummaryDto) => void;
}) {
  const soldOut = offer.availability === "sold_out";
  return (
    <div className={`product-card${soldOut ? " is-sold-out" : ""}`}>
      <Link href={`/store/${slug}/products/${offer.id}`} className="store-card-link">
        <div className="product-card-media">
          {offer.image_url ? (
            <SafeImage src={offer.image_url} alt={offer.title_ar} loading="lazy" />
          ) : (
            <span className="product-card-noimage">لا توجد صورة</span>
          )}
          {soldOut && <span className="store-soldout-badge">نفد</span>}
        </div>
        <div className="product-card-body">
          <div className="product-card-name">{offer.title_ar}</div>
          {offer.min_price && <div className="product-card-price">{offer.min_price} ₪</div>}
          {!soldOut && (
            <span className={`availability-badge availability-${offer.availability}`}>
              {AVAILABILITY_LABEL[offer.availability]}
            </span>
          )}
        </div>
      </Link>
      {offer.favorite_variant_id && (
        <button
          type="button"
          className={`store-heart${favorited ? " on" : ""}`}
          disabled={busy}
          aria-pressed={favorited}
          aria-label={favorited ? "إزالة من المفضلة" : "إضافة إلى المفضلة"}
          onClick={() => onToggleFavorite(offer)}
        >
          <HeartIcon />
        </button>
      )}
    </div>
  );
}

function StoreSkeleton() {
  return (
    <div className="store-view" aria-busy="true" aria-label="جارٍ تحميل المتجر">
      <section className="store-hero">
        <div className="store-shell">
          <div className="store-topbar">
            <div className="store-identity">
              <span className="store-skel store-skel-logo" />
              <div className="store-identity-text">
                <span className="store-skel" style={{ width: 170, height: 16 }} />
                <span className="store-skel" style={{ width: 120, height: 11 }} />
              </div>
            </div>
            <span className="store-skel" style={{ width: 46, height: 46, borderRadius: 14 }} />
          </div>
          <div className="store-intro">
            <span className="store-skel" style={{ width: "60%", height: 30, margin: "0 auto" }} />
            <span className="store-skel" style={{ width: "80%", height: 13, margin: "22px auto 0" }} />
          </div>
          <div className="store-chips" aria-hidden="true">
            {[78, 96, 84, 70].map((w, i) => (
              <span key={i} className="store-skel" style={{ width: w, height: 40, borderRadius: 999 }} />
            ))}
          </div>
        </div>
      </section>
      <section className="store-products">
        <div className="store-shell">
          <div className="product-grid store-product-grid">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i}>
                <span className="store-skel" style={{ display: "block", aspectRatio: "4 / 5", borderRadius: 18 }} />
                <span className="store-skel" style={{ width: "70%", height: 12, marginTop: 12 }} />
                <span className="store-skel" style={{ width: "40%", height: 12, marginTop: 8 }} />
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

// Sprint 7/8 (RB-STOREF-001/002, PDR-011/012): the public storefront.
// Customer view only - everything here is what the store owner set on
// /vendor/[id]/storefront (identity, cover, links) and
// /vendor/[id]/sections (their own categories, names, order and
// membership); "وصل حديثاً" / "تخفيضات" are the API's automatic
// filters. Sprint 26 adds the profile stats line, a small follow
// button, per-product favorites, local search/sort, ?cat= in the URL
// and a sticky category bar. "المحل غير متاح حالياً" stays a status
// beside the identity, never a 404.
export default function StorefrontPage() {
  const params = useParams<{ slug: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const token = useSessionToken();

  const store = useFetch<StorefrontDto>(`/storefronts/${params.slug}`);
  const sections = useFetch<StoreSectionsDto>(`/storefronts/${params.slug}/sections`);
  const reviews = useFetch<ReviewsDto>(`/storefronts/${params.slug}/reviews`);
  const followStatus = useFetch<{ following: boolean }>(
    token ? `/customers/me/following/${params.slug}` : null,
    true,
  );

  const [followOverride, setFollowOverride] = useState<boolean | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  const [favorites, setFavorites] = useState<Map<string, string>>(new Map());
  const [favoriteBusy, setFavoriteBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [chipsStuck, setChipsStuck] = useState(false);
  // A callback ref (state), not useRef: the sentinel only mounts once
  // the skeleton is replaced, and the observer must attach then.
  const [chipsSentinel, setChipsSentinel] = useState<HTMLDivElement | null>(null);

  const loadFavorites = useCallback(async () => {
    setFavorites(favoritesByVariant(await apiFetch<FavoriteDto[]>("/favorites")));
  }, []);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    apiFetch<FavoriteDto[]>("/favorites")
      .then((rows) => {
        if (!cancelled) setFavorites(favoritesByVariant(rows));
      })
      .catch(() => {
        // Non-fatal: hearts simply start empty.
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // The category bar sticks to the top only once its own spot has
  // scrolled past the top of the viewport.
  useEffect(() => {
    if (!chipsSentinel) return;
    const observer = new IntersectionObserver(([entry]) => {
      setChipsStuck(!entry.isIntersecting && entry.boundingClientRect.top < 0);
    });
    observer.observe(chipsSentinel);
    return () => observer.disconnect();
  }, [chipsSentinel]);

  const sec = sections.data;
  const categoryTabs = useMemo<CategoryTab[]>(() => {
    if (!sec) return [];
    const tabs: CategoryTab[] = [{ id: "all", label: "الكل", count: sec.all.length, kind: "all" }];
    if (sec.new_arrivals.length > 0) {
      tabs.push({ id: NEW_TAB, label: "وصل حديثاً", count: sec.new_arrivals.length, kind: "smart", icon: <SparkleIcon /> });
    }
    if (sec.discounts.length > 0) {
      tabs.push({ id: SALE_TAB, label: "تخفيضات", count: sec.discounts.length, kind: "smart", icon: <TagIcon /> });
    }
    for (const c of sec.custom) {
      tabs.push({ id: c.id, label: c.name, count: c.offers.length, kind: "custom" });
    }
    return tabs;
  }, [sec]);

  // ?cat= is the single source of truth for the selected filter, so a
  // refresh, back/forward or a shared link all land on the same view.
  const requestedTab = searchParams.get("cat") ?? "all";
  const activeTab = categoryTabs.some((t) => t.id === requestedTab) ? requestedTab : "all";

  function selectTab(id: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (id === "all") next.delete("cat");
    else next.set("cat", id);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  const tabOffers = useMemo(() => {
    if (!sec) return [];
    const base =
      activeTab === "all"
        ? sec.all
        : activeTab === NEW_TAB
          ? sec.new_arrivals
          : activeTab === SALE_TAB
            ? sec.discounts
            : (sec.custom.find((c) => c.id === activeTab)?.offers ?? []);
    const q = query.trim().toLowerCase();
    const filtered = q
      ? base.filter((o) => o.title_ar.toLowerCase().includes(q) || o.title_en.toLowerCase().includes(q))
      : base;
    return sortOffers(filtered, sort);
  }, [sec, activeTab, query, sort]);

  const initialFollowing = followStatus.data?.following ?? false;
  const following = followOverride ?? initialFollowing;

  async function toggleFollow() {
    if (!token) {
      router.push(`/login?next=${encodeURIComponent(pathname)}`);
      return;
    }
    setFollowBusy(true);
    setActionError(null);
    try {
      const res = await apiFetch<{ following: boolean }>(`/customers/me/following/${params.slug}`, {
        method: following ? "DELETE" : "PUT",
      });
      setFollowOverride(res.following);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "تعذّر تحديث المتابعة");
    } finally {
      setFollowBusy(false);
    }
  }

  async function toggleFavorite(offer: OfferSummaryDto) {
    const variantId = offer.favorite_variant_id;
    if (!variantId) return;
    if (!token) {
      router.push(`/login?next=${encodeURIComponent(pathname)}`);
      return;
    }
    setFavoriteBusy(variantId);
    setActionError(null);
    try {
      const existing = favorites.get(variantId);
      if (existing) {
        await apiFetch(`/favorites/${existing}`, { method: "DELETE" });
      } else {
        await apiFetch("/favorites", {
          method: "POST",
          body: { target_type: "OFFER", offer_variant_id: variantId },
        });
      }
      // The add response carries no id, so re-read the list - it is
      // also what keeps every heart in sync with the account.
      await loadFavorites();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "تعذّر تحديث المفضلة");
    } finally {
      setFavoriteBusy(null);
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
  if (!store.data || sections.loading) {
    return <StoreSkeleton />;
  }

  const s = store.data;
  const statusLine = [
    s.is_available ? "متاح الآن" : "المحل غير متاح حالياً",
    s.is_verified && "متجر موثّق",
  ]
    .filter(Boolean)
    .join(" · ");

  // Follower count shown after a follow/unfollow in this visit, without
  // re-fetching the storefront.
  const followerCount =
    s.follower_count + (followOverride === null ? 0 : Number(followOverride) - Number(initialFollowing));
  const rating = reviews.data?.aggregate;

  const coverVars: Record<string, string> = {};
  if (s.cover_image_url && SAFE_URL.test(s.cover_image_url)) {
    coverVars["--store-cover-image"] = `url(${JSON.stringify(s.cover_image_url)})`;
  }
  if (s.cover_color && HEX_COLOR.test(s.cover_color)) {
    coverVars["--store-cover-tint"] = s.cover_color;
  }
  const heroClass = [
    "store-hero",
    coverVars["--store-cover-image"] && "has-cover-image",
    coverVars["--store-cover-tint"] && "has-cover-tint",
  ]
    .filter(Boolean)
    .join(" ");

  const socialCandidates: { key: string; label: string; url: string | null; icon: ReactNode }[] = [
    { key: "whatsapp", label: "واتساب", url: s.whatsapp_url, icon: <WhatsAppIcon /> },
    { key: "instagram", label: "إنستغرام", url: s.instagram_url, icon: <InstagramIcon /> },
    { key: "facebook", label: "فيسبوك", url: s.facebook_url, icon: <FacebookIcon /> },
  ];
  const socials = socialCandidates.filter(
    (c): c is { key: string; label: string; url: string; icon: ReactNode } =>
      c.url !== null && SAFE_URL.test(c.url),
  );
  const whatsapp = socials.find((c) => c.key === "whatsapp");

  const hasProducts = Boolean(sec && sec.all.length > 0);

  function renderChips(stuck: boolean) {
    return (
      <div
        className="store-chips"
        role="tablist"
        aria-label={stuck ? "تصنيفات المتجر - شريط مثبّت" : "تصنيفات المتجر"}
      >
        {categoryTabs.map((tab, i) => (
          <span key={tab.id} className="store-chip-slot">
            {tab.kind === "custom" && categoryTabs[i - 1]?.kind === "smart" && (
              <span className="store-chip-divider" aria-hidden="true" />
            )}
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              tabIndex={stuck && !chipsStuck ? -1 : undefined}
              className={`store-chip store-chip-${tab.kind}${activeTab === tab.id ? " active" : ""}`}
              onClick={() => selectTab(tab.id)}
            >
              {tab.icon}
              <span>{tab.label}</span>
              <small>{tab.count}</small>
            </button>
          </span>
        ))}
      </div>
    );
  }

  const activeLabel = categoryTabs.find((t) => t.id === activeTab)?.label;

  return (
    <div className={`store-view${whatsapp ? " has-whatsapp-fab" : ""}`}>
      <section className={heroClass} style={coverVars as CSSProperties}>
        <div className="store-shell">
          <div className="store-topbar">
            <div className="store-identity">
              {s.logo_url ? (
                <SafeImage src={s.logo_url} alt={s.display_name} className="store-logo" />
              ) : (
                <div className="store-logo store-view-logo-placeholder">{s.display_name.slice(0, 1)}</div>
              )}
              <div className="store-identity-text">
                <div className="store-name-row">
                  <h1 className="store-name">{s.display_name}</h1>
                  <button
                    type="button"
                    className={`store-follow${following ? " following" : ""}`}
                    onClick={toggleFollow}
                    disabled={followBusy || (!s.is_available && !following)}
                    aria-pressed={following}
                  >
                    {following ? "تتابعينه" : "متابعة"}
                  </button>
                </div>
                <div className="store-stats">
                  {sec && <span>{formatCount(sec.all.length)} منتج</span>}
                  <span>{formatCount(followerCount)} متابع</span>
                  {rating && rating.count > 0 && (
                    <Link href={`/store/${params.slug}/reviews`} className="store-rating">
                      {rating.average !== null ? (
                        <>
                          <StarIcon /> {rating.average.toFixed(1)}
                          <small>({formatCount(rating.count)})</small>
                        </>
                      ) : (
                        <>{formatCount(rating.count)} تقييم</>
                      )}
                    </Link>
                  )}
                </div>
                <span className={`store-status${s.is_available ? "" : " store-status-off"}`}>{statusLine}</span>
              </div>
            </div>
            <button type="button" className="store-icon-button" onClick={share} aria-label="مشاركة المتجر">
              <ExpandIcon />
            </button>
          </div>

          <div className="store-intro">
            <h2>{s.display_name}</h2>
            <p>{s.bio ?? "اكتشفي تشكيلة المتجر واختاري ما يناسب ذوقك بسهولة."}</p>
            {socials.length > 0 && (
              <div className="store-socials">
                {socials.map((c) => (
                  <a
                    key={c.key}
                    href={c.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`store-social store-social-${c.key}`}
                    aria-label={c.label}
                    title={c.label}
                  >
                    {c.icon}
                  </a>
                ))}
              </div>
            )}
          </div>

          {hasProducts && (
            <div className="store-categories">
              <div className="store-categories-heading">
                <h2>استكشفي التصنيفات</h2>
                <button type="button" className="store-view-all" onClick={() => selectTab("all")}>
                  عرض الكل
                </button>
              </div>
              <div ref={setChipsSentinel} />
              {renderChips(false)}
            </div>
          )}
        </div>
      </section>

      {hasProducts && (
        <div className={`store-sticky-bar${chipsStuck ? " visible" : ""}`} aria-hidden={!chipsStuck}>
          <div className="store-shell">{renderChips(true)}</div>
        </div>
      )}

      <section className="store-products">
        <div className="store-shell">
          {notice && <div className="notice-banner" role="status">{notice}</div>}
          {actionError && <ErrorBanner message={actionError} />}
          {!s.is_available && (
            <div className="warning-banner">هذا المتجر غير متاح حالياً، ولا يمكن الطلب منه الآن.</div>
          )}

          {sections.error && <ErrorBanner message="تعذّر تحميل منتجات المتجر" />}

          {sec && sec.all.length === 0 && s.is_available && (
            <EmptyState title="لا توجد منتجات في المتجر بعد" />
          )}

          {hasProducts && (
            <>
              <div className="store-products-heading">
                <h2>
                  {activeTab === "all" ? "كل منتجات المتجر" : activeLabel}
                  <span className="muted"> · {tabOffers.length} منتج</span>
                </h2>
                <div className="store-tools">
                  <label className="store-search">
                    <SearchIcon />
                    <input
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="ابحثي في منتجات المتجر"
                      aria-label="البحث في منتجات المتجر"
                    />
                  </label>
                  <select
                    className="store-sort"
                    value={sort}
                    onChange={(e) => setSort(e.target.value as SortKey)}
                    aria-label="ترتيب المنتجات"
                  >
                    <option value="newest">الأحدث</option>
                    <option value="price_asc">الأقل سعراً</option>
                    <option value="price_desc">الأعلى سعراً</option>
                  </select>
                </div>
              </div>
              {tabOffers.length === 0 ? (
                <p className="muted store-no-results">
                  {query.trim() ? "لا توجد منتجات مطابقة لبحثك." : "لا توجد منتجات في هذا القسم."}
                </p>
              ) : (
                <div className="product-grid store-product-grid">
                  {tabOffers.map((o) => (
                    <OfferCard
                      key={o.id}
                      slug={params.slug}
                      offer={o}
                      favorited={o.favorite_variant_id !== null && favorites.has(o.favorite_variant_id)}
                      busy={favoriteBusy !== null && favoriteBusy === o.favorite_variant_id}
                      onToggleFavorite={toggleFavorite}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {whatsapp && (
        <a
          href={whatsapp.url}
          target="_blank"
          rel="noopener noreferrer"
          className="store-whatsapp-fab"
        >
          <WhatsAppIcon size={22} />
          <span>تواصلي عبر واتساب</span>
        </a>
      )}
    </div>
  );
}
