"use client";

import Image from "next/image";
import ProductCard from "@/components/ProductCard";
import Reveal from "@/components/Reveal";
import { EmptyState, SkeletonGrid } from "@/components/States";
import type { ComparisonCardDto } from "@/lib/types";
import type { ListingStatus } from "@/lib/audienceListing";
import {
  activeDrawerFilterCount,
  clearDrawerFilters,
  hasAnyFilter,
  type DiscoveryFilters,
  type ListingSort,
  type ListingTab,
} from "@/lib/discoveryFilters";
import type { CountedWomenCategory } from "./WomenCategorySection";
import { memo, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import "@/lib/listText";
import { useT } from "@/lib/useLang";
import { fmt } from "@/lib/shopText";


export type WomenSortOption = ListingSort;
// "trend" = sold by more than one store, most stores first - the only
// popularity signal the discovery data actually carries.
export type WomenBrowseTab = ListingTab;

/** The drawer's choices, from GET /taxonomy (never hard-coded here). */
export interface ListingFilterOptions {
  colors: { code: string; label: string; hex: string | null }[];
  sizes: { code: string; label: string }[];
  seasons: { code: string; label: string }[];
}

interface WomenDiscoverySectionProps {
  /** Products loaded so far (server-sorted/filtered, appended per page). */
  items: ComparisonCardDto[];
  total: number;
  status: ListingStatus;
  hasMore: boolean;
  error: string | null;
  onLoadMore: () => void;
  onRetry: () => void;
  /** All women's products, for the sidebar's "all categories" row. */
  allCount: number | null;
  categories: CountedWomenCategory[];
  /** The applied filters (the page URL) and how to change them. */
  filters: DiscoveryFilters;
  setFilters: (next: DiscoveryFilters) => void;
  filterOptions: ListingFilterOptions;
  sidebarOpen: boolean;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  favoriteIds: ReadonlySet<string>;
  favoritePendingIds: ReadonlySet<string>;
  favoritesLoading: boolean;
  onToggleFavorite: (card: ComparisonCardDto) => void;
  /** PD-5.3: offer the «الأكثر مبيعاً» sort (the feature flag is on). */
  bestsellerEnabled?: boolean;
  /** TB-25: which listing this is (its accessible name). */
  audience?: "WOMEN" | "MEN" | "KIDS";
}

const LAYOUT_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
// Start fetching the next page this far before the grid's end is visible.
const PREFETCH_MARGIN = "0px 0px 800px 0px";
// The price range slider's bounds; the ends mean "no limit".
const PRICE_FLOOR = 0;
const PRICE_CEIL = 1000;
const PRICE_STEP = 10;

// Appending a page must not re-render the cards already on screen.
const MemoProductCard = memo(ProductCard);

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export default function WomenDiscoverySection(props: WomenDiscoverySectionProps) {
  const {
    items, total, status, hasMore, error, onLoadMore, onRetry, allCount, categories,
    filters, setFilters, filterOptions, sidebarOpen, setSidebarOpen,
    favoriteIds, favoritePendingIds, favoritesLoading, onToggleFavorite,
    bestsellerEnabled = false,
    audience = "WOMEN",
  } = props;
  const t = useT();
  const { category, tab: browseTab } = filters;
  const gridHostRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const filterToggleRef = useRef<HTMLButtonElement>(null);
  const filterDrawerRef = useRef<HTMLElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  // The drawer edits a draft; "عرض النتائج" applies it to the URL.
  const [draftSort, setDraftSort] = useState<WomenSortOption>(filters.sort);
  const [selectedColors, setSelectedColors] = useState<string[]>(filters.colors);
  const [selectedSizes, setSelectedSizes] = useState<string[]>(filters.sizes);
  const [selectedSeasons, setSelectedSeasons] = useState<string[]>(filters.seasons);
  const [priceMin, setPriceMin] = useState(filters.minPrice ?? PRICE_FLOOR);
  const [priceMax, setPriceMax] = useState(filters.maxPrice ?? PRICE_CEIL);
  const [availableOnly, setAvailableOnly] = useState(filters.availableOnly);
  const drawerCount = activeDrawerFilterCount(filters);
  const filtered = hasAnyFilter(filters);
  // Card rects captured just before the sidebar toggles, so the cards can
  // glide (FLIP) from their 5-column positions to the 4-column ones
  // instead of jumping when the column count changes.
  const firstRects = useRef<DOMRect[] | null>(null);

  const productGrid = () => gridHostRef.current?.querySelector<HTMLElement>(".women-product-grid") ?? null;

  function setSidebar(open: boolean) {
    const grid = productGrid();
    if (grid && !prefersReducedMotion()) {
      firstRects.current = Array.from(grid.children, (child) => child.getBoundingClientRect());
    }
    setSidebarOpen(open);
  }

  useLayoutEffect(() => {
    const first = firstRects.current;
    firstRects.current = null;
    const grid = productGrid();
    if (!first || !grid) return;
    Array.from(grid.children).forEach((child, index) => {
      const from = first[index];
      if (!from || !(child instanceof HTMLElement)) return;
      const to = child.getBoundingClientRect();
      if (to.width === 0) return;
      const scale = from.width / to.width;
      const dx = from.right - to.right;
      const dy = from.top - to.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(scale - 1) < 0.01) return;
      child.animate(
        [
          { transformOrigin: "top right", transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
          { transformOrigin: "top right", transform: "none" },
        ],
        { duration: 300, easing: LAYOUT_EASING },
      );
    });
  }, [sidebarOpen]);

  // Escape closes the sidebar; focus moves into it on open and back to
  // the toolbar button on close.
  useEffect(() => {
    if (!sidebarOpen) return;
    sidebarRef.current?.querySelector<HTMLButtonElement>(".women-sidebar-close")?.focus({ preventScroll: true });
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSidebarOpen(false);
        toggleRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOpen, setSidebarOpen]);

  useEffect(() => {
    if (!filterOpen) return;
    filterDrawerRef.current?.querySelector<HTMLButtonElement>(".women-filter-close")?.focus({ preventScroll: true });
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setFilterOpen(false);
        filterToggleRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filterOpen]);

  // Infinite scroll: one observer on a sentinel below the grid. It is
  // re-created after every page, and an observer always reports its
  // initial state - so if the sentinel is still near the viewport after a
  // short page, the next page loads straight away. Only while idle with
  // more to load; the store also ignores calls while a request is open.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || status !== "idle" || !hasMore || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
      },
      { rootMargin: PREFETCH_MARGIN },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [status, hasMore, items.length, onLoadMore]);

  function toggleTab(tab: Exclude<WomenBrowseTab, "all">) {
    setFilters({ ...filters, tab: browseTab === tab ? "all" : tab });
  }

  function setCategory(value: string) {
    setFilters({ ...filters, category: value });
  }

  /** Opens the drawer on the currently applied filters. */
  function openFilter() {
    setDraftSort(filters.sort);
    setSelectedColors(filters.colors);
    setSelectedSizes(filters.sizes);
    setSelectedSeasons(filters.seasons);
    setPriceMin(filters.minPrice ?? PRICE_FLOOR);
    setPriceMax(filters.maxPrice ?? PRICE_CEIL);
    setAvailableOnly(filters.availableOnly);
    setFilterOpen(true);
  }

  function applyFilters() {
    setFilters({
      ...filters,
      sort: draftSort,
      colors: selectedColors,
      sizes: selectedSizes,
      seasons: selectedSeasons,
      minPrice: priceMin > PRICE_FLOOR ? priceMin : null,
      maxPrice: priceMax < PRICE_CEIL ? priceMax : null,
      availableOnly,
    });
    setFilterOpen(false);
  }

  function toggleValue(value: string, current: string[], update: Dispatch<SetStateAction<string[]>>) {
    update(current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  }

  /** "مسح الكل": clears the drawer's own filters (colour, size, season,
   * price, availability, sort) and shows the results straight away - the
   * category chosen from the circles stays active (clearDrawerFilters). */
  function clearAllFilters() {
    setDraftSort("newest");
    setSelectedColors([]);
    setSelectedSizes([]);
    setSelectedSeasons([]);
    setPriceMin(PRICE_FLOOR);
    setPriceMax(PRICE_CEIL);
    setAvailableOnly(false);
    setFilters(clearDrawerFilters(filters));
  }

  return (
    <section className={`women-discovery${filterOpen ? " filter-is-open" : ""}`} aria-label={t(`list.aria.${audience}`)} id="women-products">
      <div className="women-listing-toolbar" role="toolbar" aria-label={t("list.toolbar")}>
        <button
          ref={filterToggleRef}
          className="women-tool women-filter-toggle"
          type="button"
          onClick={openFilter}
          aria-expanded={filterOpen}
          aria-controls="women-filter-drawer"
        >
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M5.5 10h9M8 15h4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
          {t("list.filter")}{drawerCount > 0 ? ` (${drawerCount})` : ""}
        </button>
        <button className="women-tool" type="button" aria-pressed={browseTab === "trend"} onClick={() => toggleTab("trend")}>
          {t("list.trend")}
        </button>
        <button className="women-tool" type="button" aria-pressed={browseTab === "discounts"} onClick={() => toggleTab("discounts")}>
          {t("list.discounts")}
        </button>
      </div>

      {filterOpen && <button className="women-filter-scrim" type="button" aria-label={t("list.close_filter")} onClick={() => setFilterOpen(false)} />}
      <aside
        ref={filterDrawerRef}
        id="women-filter-drawer"
        className={`women-filter-drawer${filterOpen ? " is-open" : ""}`}
        aria-label={t("list.filter_products")}
        aria-hidden={!filterOpen}
        inert={!filterOpen}
      >
        <div className="women-filter-head">
          <div><span>{t("list.find_yours")}</span><h2>{t("list.filter")}</h2></div>
          <button className="women-filter-close" type="button" aria-label={t("list.close_filter")} onClick={() => setFilterOpen(false)}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
          </button>
        </div>
        <div className="women-filter-scroll">
          <fieldset className="women-filter-group"><legend>{t("list.sort")}</legend><div className="women-filter-options">
            {(["newest", "price-asc", "price-desc", ...(bestsellerEnabled ? ["bestseller" as const] : [])] as const).map((value) => <button key={value} type="button" aria-pressed={draftSort === value} onClick={() => setDraftSort(value)}>{t(`list.sort.${value}`)}</button>)}
          </div></fieldset>
          <fieldset className="women-filter-group"><legend>{t("list.price")}</legend><div className="women-filter-price">
            <span>{fmt(t("list.price_from"), { n: priceMin > PRICE_FLOOR ? priceMin : 0 })} — {priceMax < PRICE_CEIL ? fmt(t("list.price_to"), { n: priceMax }) : t("list.price_no_max")}</span>
            <input type="range" aria-label={t("list.price_min")} min={PRICE_FLOOR} max={PRICE_CEIL} step={PRICE_STEP} value={priceMin} onChange={(event) => setPriceMin(Math.min(Number(event.target.value), priceMax))} />
            <input type="range" aria-label={t("list.price_max")} min={PRICE_FLOOR} max={PRICE_CEIL} step={PRICE_STEP} value={priceMax} onChange={(event) => setPriceMax(Math.max(Number(event.target.value), priceMin))} />
          </div></fieldset>
          <fieldset className="women-filter-group"><legend>{t("list.size")}</legend><div className="women-filter-options women-filter-options-compact">
            {filterOptions.sizes.map((size) => <button key={size.code} type="button" aria-pressed={selectedSizes.includes(size.code)} onClick={() => toggleValue(size.code, selectedSizes, setSelectedSizes)}>{size.label}</button>)}
          </div></fieldset>
          <fieldset className="women-filter-group"><legend>{t("list.color")}</legend><div className="women-filter-colors">
            {filterOptions.colors.map((color) => <label key={color.code}><input type="checkbox" checked={selectedColors.includes(color.code)} onChange={() => toggleValue(color.code, selectedColors, setSelectedColors)} /><span>{color.label}</span></label>)}
          </div></fieldset>
          <fieldset className="women-filter-group"><legend>{t("list.season")}</legend><div className="women-filter-options">
            {filterOptions.seasons.map((season) => <button key={season.code} type="button" aria-pressed={selectedSeasons.includes(season.code)} onClick={() => toggleValue(season.code, selectedSeasons, setSelectedSeasons)}>{season.label}</button>)}
          </div></fieldset>
          <label className="women-filter-availability"><input type="checkbox" checked={availableOnly} onChange={(event) => setAvailableOnly(event.target.checked)} /><span>{t("list.available_only")}</span></label>
        </div>
        <div className="women-filter-actions"><button type="button" onClick={clearAllFilters}>{t("list.clear_all")}</button><button type="button" onClick={applyFilters}>{t("list.show_results")}</button></div>
      </aside>

      <div className={`women-results-layout${sidebarOpen ? " has-sidebar" : ""}`}>
        <aside
          ref={sidebarRef}
          className="women-category-sidebar"
          id="women-category-sidebar"
          aria-label={t("list.categories")}
          inert={!sidebarOpen}
        >
          <div className="women-sidebar-head">
            <h3>{t("list.categories")}</h3>
            <button
              className="women-sidebar-close"
              type="button"
              aria-label={t("list.close_categories")}
              onClick={() => {
                setSidebar(false);
                toggleRef.current?.focus({ preventScroll: true });
              }}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="m5 5 10 10M15 5 5 15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <ul className="women-sidebar-list">
            <li>
              <button className="women-sidebar-option" type="button" aria-pressed={category === ""} onClick={() => setCategory("")}>
                <span className="women-sidebar-thumb" aria-hidden="true">{t("list.all_short")}</span>
                <span className="women-sidebar-label">{t("list.all_categories")}</span>
                <span className="women-sidebar-count">{allCount ?? ""}</span>
              </button>
            </li>
            {categories.map((item) => (
              <li key={item.slug}>
                <button
                  className="women-sidebar-option"
                  type="button"
                  aria-pressed={category === item.slug}
                  onClick={() => setCategory(category === item.slug ? "" : item.slug)}
                >
                  <span className="women-sidebar-thumb" aria-hidden="true">
                    {/* Same sizes as the category circles, so these reuse the already-loaded files. */}
                    {item.image ? (
                      <Image src={item.image} alt="" fill sizes="(max-width: 639px) 52px, 64px" />
                    ) : (
                      item.label.slice(0, 1)
                    )}
                  </span>
                  <span className="women-sidebar-label">{item.label}</span>
                  <span className="women-sidebar-count">{item.count}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
        {sidebarOpen && (
          <button className="women-sidebar-scrim" type="button" aria-label={t("list.close_categories")} tabIndex={-1} onClick={() => setSidebar(false)} />
        )}

        <div className="women-results">
          {items.length === 0 && status === "loading" && <SkeletonGrid count={10} />}
          {items.length === 0 && status === "done" && (
            <EmptyState
              title={filtered ? t("list.empty_filtered") : t("list.empty")}
              message={filtered ? t("list.empty_filtered_msg") : t("list.empty_msg")}
            >
              {drawerCount > 0 && (
                <button className="button-link" type="button" onClick={clearAllFilters}>
                  {t("list.clear_filters")}
                </button>
              )}
            </EmptyState>
          )}
          {items.length > 0 && (
            <div ref={gridHostRef}>
              <Reveal className="women-product-grid">
                {items.map((card) => (
                  <MemoProductCard
                    key={card.canonical_product_id}
                    card={card}
                    presentation="women"
                    favorited={favoriteIds.has(card.canonical_product_id)}
                    favoritePending={favoritesLoading || favoritePendingIds.has(card.canonical_product_id)}
                    onToggleFavorite={onToggleFavorite}
                  />
                ))}
              </Reveal>
            </div>
          )}

          {/* Fixed-height status row: loading / error / end never shift the layout. */}
          <div className="women-list-status" role="status" aria-live="polite">
            {status === "loading" && items.length > 0 && (
              <span className="women-list-loader">
                <span className="women-list-dots" aria-hidden="true"><i /><i /><i /></span>
                <span className="visually-hidden">{t("list.loading_more")}</span>
              </span>
            )}
            {status === "error" && (
              <span className="women-list-error">
                <span>{error ?? t("list.load_failed")}</span>
                <button type="button" onClick={onRetry}>{t("list.retry")}</button>
              </span>
            )}
            {status === "done" && items.length > 0 && (
              <span className="women-list-end">
                <span aria-hidden="true">✦</span> {fmt(t("list.seen_all"), { n: total })}
              </span>
            )}
          </div>
          <div ref={sentinelRef} className="women-list-sentinel" aria-hidden="true" />
        </div>
      </div>
    </section>
  );
}

