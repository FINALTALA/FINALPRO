"use client";

import Link from "next/link";
import Footer from "@/components/Footer";
import { ErrorBanner } from "@/components/States";
import WomenCategorySection from "@/components/women/WomenCategorySection";
import WomenDiscoverySection from "@/components/women/WomenDiscoverySection";
import { takeListingRestore, useAudienceListing } from "@/lib/audienceListing";
import { listingCategories, listingFilterOptions } from "@/lib/listingCategories";
import { useTaxonomy } from "@/lib/taxonomy";
import { useListingFilters } from "@/lib/useListingFilters";
import { useMemo, useState } from "react";
import { useProductFavorites } from "@/lib/useProductFavorites";
import { useLang } from "@/lib/useLang";
import { translate } from "@/lib/i18n";
import "@/lib/sectionText";
import homeStyles from "@/app/home-via.module.css";
import "./kids.css";
import CollectionShowcase from "@/components/CollectionShowcase";

export default function KidsPage() {
  // The filters are the page URL (refresh, back/forward, shared links);
  // returning with the back button also restores the loaded list and
  // scroll position (see lib/audienceListing.ts).
  const { filters, setFilters } = useListingFilters();
  const [restoreScrollY] = useState(() => takeListingRestore("KIDS"));
  const taxonomy = useTaxonomy();
  const lang = useLang();
  const t = (key: string) => translate(lang, key);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { favoriteIds, favoritePendingIds, favoritesLoading, favoriteLoadError, favoriteError, onToggleFavorite } =
    useProductFavorites("/kids");

  const listing = useAudienceListing("KIDS", filters, restoreScrollY);
  const { categoryCounts } = listing;
  const categoryGrid = useMemo(
    () => listingCategories("KIDS", taxonomy.data, categoryCounts, lang),
    [taxonomy.data, categoryCounts, lang],
  );
  const filterOptions = useMemo(() => listingFilterOptions("KIDS", taxonomy.data, lang), [taxonomy.data, lang]);

  return (
    <div className={`${homeStyles.home} kids-page`}>
      <section className="kids-hero" aria-labelledby="kids-hero-title">
        <h1 className="visually-hidden" id="kids-hero-title">{t("sec.kids.title")}</h1>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="kids-hero-image"
          src="/images/kids-hero-studio.png"
          alt={t("sec.kids.hero_alt")}
          aria-hidden="true"
          fetchPriority="high"
          width={2037}
          height={768}
        />
        <div className="kids-hero-copy" aria-hidden="true"><strong>{t("sec.kids.copy_strong")}</strong><span>{t("sec.kids.copy_span")}</span></div>
        <Link className="kids-hero-cta" href="#women-products">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5 8.5h14l-1 11H6l-1-11Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="M8.5 9V6.75a3.5 3.5 0 0 1 7 0V9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <span>{t("sec.shop_now")}</span>
        </Link>
      </section>

      <div className="kids-ticker" aria-label={t("sec.f.ticker_aria")}>
        <div className="kids-ticker-track">
          {[0, 1].map((copy) => (
            <span className="kids-ticker-group" key={copy} aria-hidden={copy === 1}>
              <span>{t("sec.f.ticker_1")}</span>
              <i aria-hidden="true">✦</i>
              <span>{t("sec.f.ticker_2")}</span>
              <i aria-hidden="true">✦</i>
              <span>{t("sec.ticker_3")}</span>
              <i aria-hidden="true">✦</i>
            </span>
          ))}
        </div>
      </div>

      <div className="kids-offer-strip" role="note">
        <span className="kids-offer-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h11v10H3zM14 9h4l3 3.5V16h-7" />
            <circle cx="7" cy="17.5" r="1.6" />
            <circle cx="17.5" cy="17.5" r="1.6" />
          </svg>
        </span>
        <span>
          {t("sec.f.offer_pre")}<strong>{t("sec.offer_amount")}</strong>{t("sec.f.offer_mid")}<strong>{t("sec.offer_free")}</strong>
        </span>
        <Link href="#women-products" className="kids-offer-link">{t("sec.f.shop_now")} <span aria-hidden="true">←</span></Link>
      </div>

      <div className="kids-floor-extension">
      <div className="kids-content">
        <WomenCategorySection
          categories={categoryGrid}
          selectedCategory={filters.category}
          onSelectCategory={(value) => {
            setFilters({ ...filters, category: value });
            if (value) document.getElementById("women-products")?.scrollIntoView({ behavior: "smooth" });
          }}
        />
        {/* PD-5b.4: one live collection for kids (none -> nothing). */}
        <CollectionShowcase placement="AUDIENCE" audience="KIDS" presentation="women" favoriteIds={favoriteIds} favoritePendingIds={favoritePendingIds} favoritesLoading={favoritesLoading} onToggleFavorite={onToggleFavorite} />

        {taxonomy.status === "error" && <ErrorBanner message={taxonomy.error} />}
        {(favoriteLoadError || favoriteError) && (
          <ErrorBanner message={favoriteError ?? favoriteLoadError ?? t("fav.load_failed")} />
        )}
        <WomenDiscoverySection
          items={listing.items}
          total={listing.total}
          status={listing.status}
          hasMore={listing.hasMore}
          error={listing.error}
          audience="KIDS"
          onLoadMore={listing.loadMore}
          onRetry={listing.retry}
          bestsellerEnabled={listing.bestsellerEnabled}
          allCount={listing.allCount}
          categories={categoryGrid}
          filters={filters}
          setFilters={setFilters}
          filterOptions={filterOptions}
          sidebarOpen={sidebarOpen}
          setSidebarOpen={setSidebarOpen}
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

