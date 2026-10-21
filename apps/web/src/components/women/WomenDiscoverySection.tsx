"use client";

import Image from "next/image";
import ProductCard from "@/components/ProductCard";
import Reveal from "@/components/Reveal";
import { EmptyState, SkeletonGrid } from "@/components/States";
import type { ComparisonCardDto } from "@/lib/types";
import type { WomenListingSort, WomenListingStatus } from "@/lib/womenListing";
import type { CountedWomenCategory } from "./WomenCategorySection";
import { memo, useEffect, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from "react";

export type WomenSortOption = WomenListingSort;
// "trend" = sold by more than one store, most stores first - the only
// popularity signal the discovery data actually carries.
export type WomenBrowseTab = "all" | "trend" | "discounts";

interface WomenDiscoverySectionProps {
  /** Products loaded so far (server-sorted/filtered, appended per page). */
  items: ComparisonCardDto[];
  total: number;
  status: WomenListingStatus;
  hasMore: boolean;
  error: string | null;
  onLoadMore: () => void;
  onRetry: () => void;
  /** All women's products, for the sidebar's "all categories" row. */
  allCount: number | null;
  categories: CountedWomenCategory[];
  category: string;
  setCategory: Dispatch<SetStateAction<string>>;
  sort: WomenSortOption;
  setSort: Dispatch<SetStateAction<WomenSortOption>>;
  browseTab: WomenBrowseTab;
  setBrowseTab: Dispatch<SetStateAction<WomenBrowseTab>>;
  sidebarOpen: boolean;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  clearFilters: () => void;
  favoriteIds: ReadonlySet<string>;
  favoritePendingIds: ReadonlySet<string>;
  favoritesLoading: boolean;
  onToggleFavorite: (card: ComparisonCardDto) => void;
}

const LAYOUT_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
// Start fetching the next page this far before the grid's end is visible.
const PREFETCH_MARGIN = "0px 0px 800px 0px";

// Appending a page must not re-render the cards already on screen.
const MemoProductCard = memo(ProductCard);

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export default function WomenDiscoverySection(props: WomenDiscoverySectionProps) {
  const {
    items, total, status, hasMore, error, onLoadMore, onRetry, allCount, categories, category, setCategory,
    sort, setSort, browseTab, setBrowseTab, sidebarOpen, setSidebarOpen, clearFilters,
    favoriteIds, favoritePendingIds, favoritesLoading, onToggleFavorite,
  } = props;
  const gridHostRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
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
    setBrowseTab((current) => (current === tab ? "all" : tab));
  }

  return (
    <section className="women-discovery" aria-label="منتجات النساء" id="women-products">
      <div className="women-listing-toolbar" role="toolbar" aria-label="ترتيب المنتجات وتصفيتها">
        <label className="women-tool women-tool-sort">
          <span>ترتيب حسب</span>
          <select value={sort} onChange={(event) => setSort(event.target.value as WomenSortOption)} aria-label="ترتيب حسب">
            <option value="newest">الأحدث</option>
            <option value="price-asc">السعر: من الأقل للأعلى</option>
            <option value="price-desc">السعر: من الأعلى للأقل</option>
            <option value="discounts">العروض بخصم أولًا</option>
          </select>
        </label>
        <button
          ref={toggleRef}
          className="women-tool"
          type="button"
          onClick={() => setSidebar(!sidebarOpen)}
          aria-expanded={sidebarOpen}
          aria-controls="women-category-sidebar"
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M3 5h14M5.5 10h9M8 15h4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          التصنيفات
          {category && <span className="women-tool-dot" aria-label="تصنيف محدد" />}
        </button>
        <button className="women-tool" type="button" aria-pressed={browseTab === "trend"} onClick={() => toggleTab("trend")}>
          الترند
        </button>
        <button className="women-tool" type="button" aria-pressed={browseTab === "discounts"} onClick={() => toggleTab("discounts")}>
          الخصومات
        </button>
      </div>

      <div className={`women-results-layout${sidebarOpen ? " has-sidebar" : ""}`}>
        <aside
          ref={sidebarRef}
          className="women-category-sidebar"
          id="women-category-sidebar"
          aria-label="التصنيفات"
          inert={!sidebarOpen}
        >
          <div className="women-sidebar-head">
            <h3>التصنيفات</h3>
            <button
              className="women-sidebar-close"
              type="button"
              aria-label="إغلاق التصنيفات"
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
                <span className="women-sidebar-thumb" aria-hidden="true">الكل</span>
                <span className="women-sidebar-label">كل التصنيفات</span>
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
                    <Image src={item.image} alt="" fill sizes="(max-width: 639px) 52px, 64px" />
                  </span>
                  <span className="women-sidebar-label">{item.label}</span>
                  <span className="women-sidebar-count">{item.count}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
        {sidebarOpen && (
          <button className="women-sidebar-scrim" type="button" aria-label="إغلاق التصنيفات" tabIndex={-1} onClick={() => setSidebar(false)} />
        )}

        <div className="women-results">
          {items.length === 0 && status === "loading" && <SkeletonGrid count={10} />}
          {items.length === 0 && status === "done" && (
            <EmptyState
              title={category || browseTab !== "all" ? "لا توجد منتجات بهذه المواصفات" : "لا توجد منتجات نسائية متاحة حاليًا"}
              message={category || browseTab !== "all" ? "غيّري التصنيف أو الفلتر لعرض نتائج أخرى." : "ستظهر المنتجات هنا عند نشر المتاجر لعروضها."}
            >
              {(category || browseTab !== "all") && (
                <button className="button-link" type="button" onClick={() => { clearFilters(); setBrowseTab("all"); }}>
                  مسح الفلاتر
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
                <span className="visually-hidden">جارٍ تحميل المزيد من المنتجات</span>
              </span>
            )}
            {status === "error" && (
              <span className="women-list-error">
                <span>{error ?? "تعذّر تحميل المنتجات"}</span>
                <button type="button" onClick={onRetry}>إعادة المحاولة</button>
              </span>
            )}
            {status === "done" && items.length > 0 && (
              <span className="women-list-end">
                <span aria-hidden="true">✦</span> شاهدتِ كل المنتجات ({total})
              </span>
            )}
          </div>
          <div ref={sentinelRef} className="women-list-sentinel" aria-hidden="true" />
        </div>
      </div>
    </section>
  );
}
