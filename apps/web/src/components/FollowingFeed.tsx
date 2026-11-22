"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ReactNode, useEffect, useRef, useState } from "react";
import { BackIcon, SearchIcon, SparkleIcon, StarIcon, TagIcon } from "@/components/Icons";
import ProductCard from "@/components/ProductCard";
import { ApiError, apiFetch } from "@/lib/api";
import {
  NO_DRAWER,
  drawerCount,
  feedApiQuery,
  parseFeedState,
  withDepartment,
  writeFeedState,
  type FeedCollection,
  type FeedDepartment,
  type FeedDrawer,
  type FeedResponse,
  type FeedState,
} from "@/lib/followingFeed";
import { clearSession } from "@/lib/session";
import { useTaxonomy } from "@/lib/taxonomy";
import { useProductFavorites } from "@/lib/useProductFavorites";
import { useSessionToken } from "@/lib/useSession";
import { loginHref } from "@/lib/loginRedirect";

const PAGE_SIZE = 24;
const SEARCH_DEBOUNCE_MS = 350;
const RETURN_PATH = "/profile?tab=following";

const DEPARTMENTS: { id: FeedDepartment; label: string }[] = [
  { id: "ALL", label: "الكل" },
  { id: "WOMEN", label: "نساء" },
  { id: "MEN", label: "رجال" },
  { id: "KIDS", label: "أطفال" },
];
const SMART: { id: Exclude<FeedCollection, "ALL">; label: string; icon: ReactNode }[] = [
  { id: "NEW", label: "وصل حديثاً", icon: <SparkleIcon /> },
  { id: "DISCOUNT", label: "تخفيضات", icon: <TagIcon /> },
  { id: "TRENDING", label: "الترند", icon: <StarIcon /> },
];
const SORT_LABEL: { id: NonNullable<FeedDrawer["sort"]>; label: string }[] = [
  { id: "newest", label: "الأحدث" },
  { id: "price-asc", label: "الأقل سعرًا" },
  { id: "price-desc", label: "الأعلى سعرًا" },
  { id: "trending", label: "الأكثر رواجًا" },
];

/** A horizontal row whose arrows show only when it overflows. */
function ScrollRow({ className, label, children }: { className: string; label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const row = ref.current;
    if (!row) return;
    const update = () => setOverflow(row.scrollWidth > row.clientWidth + 1);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(row);
    for (const child of Array.from(row.children)) observer.observe(child);
    return () => observer.disconnect();
  });
  const scroll = (direction: "next" | "previous") =>
    ref.current?.scrollBy({ left: direction === "next" ? -280 : 280, behavior: "smooth" });
  return (
    <div className={`following-feed-scroll${overflow ? " has-overflow" : ""}`}>
      {overflow && (
        <button type="button" className="following-feed-arrow following-feed-arrow-next" onClick={() => scroll("next")} aria-label={`${label} - التالي`}>
          <BackIcon />
        </button>
      )}
      <div className={className} ref={ref} role="tablist" aria-label={label}>
        {children}
      </div>
      {overflow && (
        <button type="button" className="following-feed-arrow following-feed-arrow-previous" onClick={() => scroll("previous")} aria-label={`${label} - السابق`}>
          <BackIcon />
        </button>
      )}
    </div>
  );
}

// «أتابعه»'s product feed: only the followed stores' products, narrowed
// on the server by department -> category -> smart collection -> search
// -> drawer filters. The state is /profile's query string; `storesKey`
// (the followed stores) refetches it after a follow/unfollow.
export default function FollowingFeed({ storesKey }: { storesKey: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const token = useSessionToken();
  const taxonomy = useTaxonomy();
  const state = parseFeedState(new URLSearchParams(searchParams.toString()));
  const favorites = useProductFavorites(RETURN_PATH);

  const [searchDraft, setSearchDraft] = useState(state.q);
  const [searchOpen, setSearchOpen] = useState(Boolean(state.q));
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [drawer, setDrawer] = useState<FeedDrawer | null>(null);
  const [feed, setFeed] = useState<{ key: string; data: FeedResponse; items: FeedResponse["items"] } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const apiQuery = feedApiQuery(state, PAGE_SIZE);
  const key = `${token ?? ""}|${storesKey}|${apiQuery}`;

  /** Writes a new feed state into the URL (a history entry, so Back works). */
  function go(next: FeedState, mode: "push" | "replace" = "push") {
    const qs = writeFeedState(new URLSearchParams(searchParams.toString()), next).toString();
    const url = qs ? `${pathname}?${qs}` : pathname;
    if (mode === "push") router.push(url, { scroll: false });
    else router.replace(url, { scroll: false });
  }

  function sessionExpired() {
    clearSession();
    router.replace(loginHref(RETURN_PATH));
  }

  // The search box follows the URL (Back/Forward, a shared link) and,
  // after a short pause while typing, writes to it.
  const [syncedQ, setSyncedQ] = useState(state.q);
  if (syncedQ !== state.q) {
    setSyncedQ(state.q);
    setSearchDraft(state.q);
  }
  useEffect(() => {
    const typed = searchDraft.trim();
    if (typed === state.q) return;
    const handle = setTimeout(() => go({ ...state, q: typed }, "replace"), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  });

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    apiFetch<FeedResponse>(`/customers/me/following/feed?${apiQuery}`)
      .then((data) => {
        if (!cancelled) setFeed({ key, data, items: data.items });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          sessionExpired();
          return;
        }
        setError({ key, message: err instanceof ApiError ? err.message : "تعذّر تحميل منتجات المتاجر" });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` covers token, stores and query
  }, [key]);

  async function loadMore() {
    if (!feed?.data.next_cursor || loadingMore) return;
    const { key: forKey, data } = feed;
    setLoadingMore(true);
    try {
      const next = await apiFetch<FeedResponse>(
        `/customers/me/following/feed?${apiQuery}&cursor=${encodeURIComponent(data.next_cursor!)}`,
      );
      setFeed((current) => {
        if (current?.key !== forKey) return current;
        const seen = new Set(current.items.map((c) => c.canonical_product_id));
        return { key: forKey, data: next, items: [...current.items, ...next.items.filter((c) => !seen.has(c.canonical_product_id))] };
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        sessionExpired();
        return;
      }
      setError({ key, message: err instanceof ApiError ? err.message : "تعذّر تحميل المزيد" });
    } finally {
      setLoadingMore(false);
    }
  }

  const sizeGroup = (code: string) => taxonomy.data?.sizes.find((s) => s.code === code)?.group;
  const current = feed?.key === key ? feed : null;
  const data = current?.data ?? feed?.data ?? null;
  const items = current?.items ?? [];
  const loading = !current && !(error?.key === key);
  const shownError = error?.key === key ? error.message : null;
  const filters = drawerCount(state);
  const options = data?.filter_options;

  function openSearch() {
    setSearchOpen(true);
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }

  if (data && data.followed_store_count > 0 && data.department_counts.ALL === 0 && state.department === "ALL" && !state.q && filters === 0 && state.collection === "ALL") {
    return (
      <section className="following-feed" aria-label="منتجات المتاجر التي تتابعها">
        <p className="following-feed-empty">المتاجر التي تتابعها لا تعرض منتجات حالياً.</p>
      </section>
    );
  }

  function toggle(list: string[], value: string) {
    return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  }

  return (
    <section className="following-feed" aria-label="منتجات المتاجر التي تتابعها">
      <div className="following-feed-title">
        <h2>
          منتجات المتاجر التي تتابعها
          {data && <span className="following-feed-total"> · {data.total} منتج</span>}
        </h2>
      </div>
      <div className="following-feed-overview">
        <div className="following-feed-controls-panel">
          <div className="following-feed-head">
            <div className="following-feed-tools">
              <div className={`following-feed-search${searchOpen ? " is-open" : ""}`}>
                <button type="button" className="following-feed-search-toggle" onClick={openSearch} aria-label="البحث في منتجات المتاجر المتابعة" aria-expanded={searchOpen}>
                  <SearchIcon />
                </button>
                <input
                  ref={searchInputRef}
                  type="search"
                  value={searchDraft}
                  onChange={(event) => setSearchDraft(event.target.value)}
                  placeholder="ابحث في هذه المنتجات..."
                  aria-label="البحث في منتجات المتاجر المتابعة"
                  tabIndex={searchOpen ? 0 : -1}
                />
              </div>
              <button type="button" className="following-feed-filter-toggle" onClick={() => setDrawer({ ...state })} aria-haspopup="dialog">
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M5.5 10h9M8 15h4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
                Filter{filters > 0 ? ` (${filters})` : ""}
              </button>
            </div>
          </div>
          <ScrollRow className="following-feed-departments" label="الأقسام">
            {DEPARTMENTS.map((d) => (
              <button
                key={d.id}
                type="button"
                role="tab"
                data-department={d.id}
                aria-selected={state.department === d.id}
                className={`following-feed-chip${state.department === d.id ? " active" : ""}`}
                onClick={() => state.department !== d.id && go(withDepartment(state, d.id, sizeGroup))}
              >
                <span>{d.label}</span>
                <small>{data?.department_counts[d.id] ?? 0}</small>
              </button>
            ))}
          </ScrollRow>
        </div>
        <div className="following-feed-featured" aria-label="اختيارات المتاجر المتابعة">
          <button type="button" className="following-feed-feature-card following-feed-feature-new" onClick={() => go({ ...state, collection: "NEW" })} aria-label="وصل حديثاً">
            <span className="following-feed-feature-copy"><strong>وصل حديثاً</strong><small>من متاجرك</small></span>
          </button>
          <button type="button" className="following-feed-feature-card following-feed-feature-choose" onClick={() => setDrawer({ ...state })} aria-label="اختيارات خاصة لك">
            <span className="following-feed-feature-copy"><strong>اختيارات خاصة لك</strong><small>من المتاجر التي تتابعها</small></span>
          </button>
        </div>
      </div>

      {state.department !== "ALL" && data && data.categories.length > 0 && (
        <ScrollRow className="following-feed-categories" label="التصنيفات">
          {data.categories.map((c) => (
            <button
              key={c.code}
              type="button"
              role="tab"
              data-category={c.code}
              aria-selected={state.category === c.code}
              className={`following-feed-subchip${state.category === c.code ? " active" : ""}`}
              onClick={() => go({ ...state, category: state.category === c.code ? null : c.code })}
            >
              {c.name_ar} <small>{c.count}</small>
            </button>
          ))}
        </ScrollRow>
      )}

      <div className="following-feed-smart" role="group" aria-label="التجميع">
        <button
          type="button"
          data-collection="ALL"
          aria-pressed={state.collection === "ALL"}
          className={`following-feed-smart-chip${state.collection === "ALL" ? " active" : ""}`}
          onClick={() => go({ ...state, collection: "ALL" })}
        >
          <span>الكل</span>
          <small>{data?.collection_counts.ALL ?? 0}</small>
        </button>
        {SMART.map((s) => {
          const active = state.collection === s.id;
          const count = data?.collection_counts[s.id] ?? 0;
          if (!active && count === 0) return null;
          return (
            <button
              key={s.id}
              type="button"
              data-collection={s.id}
              aria-pressed={active}
              className={`following-feed-smart-chip${active ? " active" : ""}`}
              onClick={() => go({ ...state, collection: active ? "ALL" : s.id })}
            >
              {s.icon}
              <span>{s.label}</span>
              <small>{count}</small>
            </button>
          );
        })}
      </div>

      {shownError && <p className="following-feed-error" role="alert">{shownError}</p>}
      {loading && items.length === 0 && !feed ? (
        <div className="following-feed-grid" aria-busy="true">
          {Array.from({ length: 4 }, (_, i) => <span key={i} className="following-feed-skeleton" />)}
        </div>
      ) : (feed && !current ? feed.items : items).length === 0 ? (
        // No match stays empty - the selections are never widened.
        <p className="following-feed-empty">
          {state.q ? "لا توجد منتجات مطابقة لبحثك في المتاجر التي تتابعها." : "لا توجد منتجات تطابق اختياراتك."}
        </p>
      ) : (
        <div className={`following-feed-grid${current ? "" : " is-stale"}`} aria-busy={!current}>
          {(current ? items : feed!.items).map((card) => (
            <ProductCard
              key={card.canonical_product_id}
              card={card}
              presentation="women"
              favorited={favorites.favoriteIds.has(card.canonical_product_id)}
              favoritePending={favorites.favoritesLoading || favorites.favoritePendingIds.has(card.canonical_product_id)}
              onToggleFavorite={favorites.onToggleFavorite}
            />
          ))}
        </div>
      )}
      {favorites.favoriteError && <p className="following-feed-error" role="alert">{favorites.favoriteError}</p>}
      {current?.data.next_cursor && (
        <div className="following-feed-more">
          <button type="button" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "جارٍ التحميل..." : `عرض المزيد (${current.data.total - current.items.length})`}
          </button>
        </div>
      )}

      {drawer && (
        <>
          <button className="store-filter-scrim" type="button" aria-label="إغلاق الفلتر" onClick={() => setDrawer(null)} />
          <aside className="store-filter-drawer following-feed-drawer" role="dialog" aria-label="فلترة منتجات المتاجر المتابعة">
            <div className="store-filter-head">
              <div><span>منتجات متاجرك</span><h2>Filter</h2></div>
              <button type="button" className="store-filter-close" aria-label="إغلاق الفلتر" onClick={() => setDrawer(null)}>
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
              </button>
            </div>
            <div className="store-filter-scroll">
              <fieldset className="store-filter-group"><legend>الترتيب</legend><div className="store-filter-options">
                {SORT_LABEL.map((s) => (
                  <button key={s.id} type="button" aria-pressed={(drawer.sort ?? (state.collection === "TRENDING" ? "trending" : "newest")) === s.id} onClick={() => setDrawer({ ...drawer, sort: s.id })}>{s.label}</button>
                ))}
              </div></fieldset>
              {options?.price && (
                <fieldset className="store-filter-group"><legend>السعر (₪)</legend><div className="following-feed-price">
                  <input type="number" inputMode="decimal" min={0} aria-label="أقل سعر" placeholder={String(options.price.min)} value={drawer.minPrice ?? ""} onChange={(e) => setDrawer({ ...drawer, minPrice: e.target.value === "" ? null : Math.max(0, Number(e.target.value)) })} />
                  <span>—</span>
                  <input type="number" inputMode="decimal" min={0} aria-label="أعلى سعر" placeholder={String(options.price.max)} value={drawer.maxPrice ?? ""} onChange={(e) => setDrawer({ ...drawer, maxPrice: e.target.value === "" ? null : Math.max(0, Number(e.target.value)) })} />
                </div></fieldset>
              )}
              {options && options.sizes.length > 0 && (
                <fieldset className="store-filter-group"><legend>المقاس</legend><div className="store-filter-options store-filter-options-compact">
                  {options.sizes.map((s) => <button key={s.code} type="button" data-size={s.code} aria-pressed={drawer.sizes.includes(s.code)} onClick={() => setDrawer({ ...drawer, sizes: toggle(drawer.sizes, s.code) })}>{s.label}</button>)}
                </div></fieldset>
              )}
              {options && options.colors.length > 0 && (
                <fieldset className="store-filter-group"><legend>اللون</legend><div className="store-filter-colors">
                  {options.colors.map((c) => (
                    <label key={c.code} data-color={c.code}>
                      <input type="checkbox" checked={drawer.colors.includes(c.code)} onChange={() => setDrawer({ ...drawer, colors: toggle(drawer.colors, c.code) })} />
                      {c.hex && <i className="following-feed-swatch" style={{ background: c.hex }} aria-hidden="true" />}
                      <span>{c.name_ar}</span>
                    </label>
                  ))}
                </div></fieldset>
              )}
              {options && options.brands.length > 0 && (
                <fieldset className="store-filter-group"><legend>العلامة</legend><div className="store-filter-options">
                  {options.brands.map((b) => <button key={b.id} type="button" data-brand={b.id} aria-pressed={drawer.brands.includes(b.id)} onClick={() => setDrawer({ ...drawer, brands: toggle(drawer.brands, b.id) })}>{b.name}</button>)}
                </div></fieldset>
              )}
              {options && options.seasons.length > 0 && (
                <fieldset className="store-filter-group"><legend>الموسم</legend><div className="store-filter-options">
                  {options.seasons.map((s) => <button key={s.code} type="button" aria-pressed={drawer.seasons.includes(s.code)} onClick={() => setDrawer({ ...drawer, seasons: toggle(drawer.seasons, s.code) })}>{s.name_ar}</button>)}
                </div></fieldset>
              )}
              <label className="store-filter-availability"><input type="checkbox" checked={drawer.availableOnly} onChange={(e) => setDrawer({ ...drawer, availableOnly: e.target.checked })} /><span>المتاح فقط</span></label>
            </div>
            <div className="store-filter-actions">
              <button type="button" onClick={() => { setDrawer({ ...drawer, ...NO_DRAWER }); go({ ...state, ...NO_DRAWER }); }}>مسح الكل</button>
              <button
                type="button"
                onClick={() => {
                  const min = drawer.minPrice;
                  const max = drawer.maxPrice;
                  go({ ...state, ...drawer, ...(min !== null && max !== null && min > max ? { minPrice: max, maxPrice: min } : {}) });
                  setDrawer(null);
                }}
              >
                عرض النتائج
              </button>
            </div>
          </aside>
        </>
      )}
    </section>
  );
}
