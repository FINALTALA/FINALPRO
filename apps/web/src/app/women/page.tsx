"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import Footer from "@/components/Footer";
import { ErrorBanner } from "@/components/States";
import WomenCategorySection from "@/components/women/WomenCategorySection";
import WomenDiscoverySection from "@/components/women/WomenDiscoverySection";
import type { WomenBrowseTab, WomenSortOption } from "@/components/women/WomenDiscoverySection";
import { ApiError, apiFetch } from "@/lib/api";
import { ComparisonCardDto } from "@/lib/types";
import { WOMEN_CATEGORIES } from "@/lib/womenCategories";
import { takeWomenListingRestore, useWomenListing } from "@/lib/womenListing";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSessionToken } from "@/lib/useSession";
import "./women.css";

interface FavoriteDto {
  id: string;
  target_type: "PRODUCT" | "OFFER";
  canonical_product_id: string | null;
}

type SortOption = WomenSortOption;
type BrowseTab = WomenBrowseTab;

export default function WomenPage() {
  const router = useRouter();
  const token = useSessionToken();
  // Returning with the browser's back button restores the loaded list,
  // filters and scroll position (see lib/womenListing.ts).
  const [restore] = useState(takeWomenListingRestore);
  const [category, setCategory] = useState(restore?.query.category ?? "");
  const [sort, setSort] = useState<SortOption>(restore?.query.sort ?? "newest");
  const [browseTab, setBrowseTab] = useState<BrowseTab>(restore?.query.filter ?? "all");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [favoriteState, setFavoriteState] = useState<{
    token: string;
    rows: FavoriteDto[] | null;
    error: string | null;
  } | null>(null);
  const [favoritePendingIds, setFavoritePendingIds] = useState<Set<string>>(new Set());
  const [favoriteError, setFavoriteError] = useState<string | null>(null);

  const listing = useWomenListing(
    { sort, filter: browseTab === "all" ? null : browseTab, category: category || null },
    restore?.scrollY ?? null,
  );
  const favoriteRows = useMemo(
    () => favoriteState?.token === token ? favoriteState.rows ?? [] : [],
    [favoriteState, token],
  );
  const favoriteLoadError = favoriteState?.token === token ? favoriteState.error : null;
  const favoritesLoading = Boolean(token) && favoriteState?.token !== token;
  const favoriteIds = useMemo(
    () => new Set(favoriteRows
      .flatMap((favorite) =>
        favorite.target_type === "PRODUCT" && favorite.canonical_product_id
          ? [favorite.canonical_product_id]
          : [],
      )),
    [favoriteRows],
  );
  const { categoryCounts } = listing;
  const categoryGrid = useMemo(
    () => WOMEN_CATEGORIES.map((item) => ({ ...item, count: categoryCounts?.[item.slug] ?? 0 })),
    [categoryCounts],
  );

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    apiFetch<FavoriteDto[]>("/favorites")
      .then((rows) => {
        if (!cancelled) setFavoriteState({ token, rows, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setFavoriteState({
          token,
          rows: null,
          error: error instanceof ApiError ? error.message : "تعذّر تحميل المفضلة",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  function clearFilters() {
    setCategory("");
  }

  async function toggleFavorite(card: ComparisonCardDto) {
    if (!token) {
      router.push(`/login?next=${encodeURIComponent("/women")}`);
      return;
    }
    if (favoritesLoading || favoriteLoadError || favoritePendingIds.has(card.canonical_product_id)) return;

    const existing = favoriteRows.find(
      (favorite) => favorite.target_type === "PRODUCT" &&
        favorite.canonical_product_id === card.canonical_product_id,
    );
    setFavoriteError(null);
    setFavoritePendingIds((previous) => new Set(previous).add(card.canonical_product_id));
    try {
      let updatedRows: FavoriteDto[];
      if (existing) {
        await apiFetch(`/favorites/${existing.id}`, { method: "DELETE" });
        updatedRows = favoriteRows.filter((favorite) => favorite.id !== existing.id);
      } else {
        await apiFetch("/favorites", {
          method: "POST",
          body: { target_type: "PRODUCT", canonical_product_id: card.canonical_product_id },
        });
        updatedRows = await apiFetch<FavoriteDto[]>("/favorites");
      }
      setFavoriteState({ token, rows: updatedRows, error: null });
    } catch (error) {
      setFavoriteError(error instanceof ApiError ? error.message : "تعذّر تحديث المفضلة");
    } finally {
      setFavoritePendingIds((previous) => {
        const next = new Set(previous);
        next.delete(card.canonical_product_id);
        return next;
      });
    }
  }

  // A stable callback, so the memoized cards don't re-render on every
  // page append; it always runs the latest toggleFavorite.
  const toggleFavoriteRef = useRef(toggleFavorite);
  useLayoutEffect(() => {
    toggleFavoriteRef.current = toggleFavorite;
  });
  const onToggleFavorite = useCallback((card: ComparisonCardDto) => toggleFavoriteRef.current(card), []);

  return (
    <div className="women-page">
      <section className="women-hero" aria-labelledby="women-hero-title">
        <h1 className="visually-hidden" id="women-hero-title">ما وراء المألوف</h1>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="women-hero-image"
          src="/images/women-hero-runway.png"
          alt=""
          aria-hidden="true"
          fetchPriority="high"
          width={2037}
          height={768}
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="women-hero-title-art"
          src="/images/via-women-hero-title.svg"
          alt=""
          aria-hidden="true"
          width={936}
          height={287}
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="women-hero-subject"
          src="/images/women-hero-runway-subject.png"
          alt=""
          aria-hidden="true"
          fetchPriority="high"
          width={2037}
          height={768}
        />
        <Link className="women-hero-cta" href="#women-products">تسوّق الآن</Link>
      </section>

      <div className="women-ticker" aria-label="اكتشفي وقارني واختاري">
        <div className="women-ticker-track">
          {[0, 1].map((copy) => (
            <span className="women-ticker-group" key={copy} aria-hidden={copy === 1}>
              <span>اكتشفي أزياء من محلات فلسطينية</span>
              <i aria-hidden="true">✦</i>
              <span>قارني أسعار المنتج نفسه</span>
              <i aria-hidden="true">✦</i>
              <span>السعر والتوفر حسب بيانات المتاجر</span>
              <i aria-hidden="true">✦</i>
            </span>
          ))}
        </div>
      </div>

      <div className="women-offer-strip" role="note">
        <span className="women-offer-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h11v10H3zM14 9h4l3 3.5V16h-7" />
            <circle cx="7" cy="17.5" r="1.6" />
            <circle cx="17.5" cy="17.5" r="1.6" />
          </svg>
        </span>
        <span>
          اشتري بـ <strong>500 ₪</strong> واحصلي على <strong>توصيل مجاني</strong>
        </span>
        <Link href="#women-products" className="women-offer-link">تسوّقي الآن <span aria-hidden="true">←</span></Link>
      </div>

      <div className="women-floor-extension">
      <div className="women-content">
        <WomenCategorySection
          categories={categoryGrid}
          selectedCategory={category}
          onSelectCategory={(value) => {
            setCategory(value);
            if (value) document.getElementById("women-products")?.scrollIntoView({ behavior: "smooth" });
          }}
        />

        {(favoriteLoadError || favoriteError) && (
          <ErrorBanner message={favoriteError ?? favoriteLoadError ?? "تعذّر تحميل المفضلة"} />
        )}
        <WomenDiscoverySection
          items={listing.items}
          total={listing.total}
          status={listing.status}
          hasMore={listing.hasMore}
          error={listing.error}
          onLoadMore={listing.loadMore}
          onRetry={listing.retry}
          allCount={listing.allCount}
          categories={categoryGrid}
          category={category}
          setCategory={setCategory}
          sort={sort}
          setSort={setSort}
          browseTab={browseTab}
          setBrowseTab={setBrowseTab}
          sidebarOpen={sidebarOpen}
          setSidebarOpen={setSidebarOpen}
          clearFilters={clearFilters}
          favoriteIds={favoriteIds}
          favoritePendingIds={favoritePendingIds}
          favoritesLoading={favoritesLoading}
          onToggleFavorite={onToggleFavorite}
        />
      </div>
      <Footer />
      </div>
    </div>
  );
}
