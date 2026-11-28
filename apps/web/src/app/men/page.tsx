"use client";

import Link from "next/link";
import Footer from "@/components/Footer";
import WomenCategorySection from "@/components/women/WomenCategorySection";
import WomenDiscoverySection from "@/components/women/WomenDiscoverySection";
import { ErrorBanner } from "@/components/States";
import { takeListingRestore, useAudienceListing } from "@/lib/audienceListing";
import { listingCategories, listingFilterOptions } from "@/lib/listingCategories";
import { useTaxonomy } from "@/lib/taxonomy";
import { useListingFilters } from "@/lib/useListingFilters";
import homeStyles from "@/app/home-via.module.css";
import { Fragment, useCallback, useMemo, useState } from "react";
import { useProductFavorites } from "@/lib/useProductFavorites";
import { useLang } from "@/lib/useLang";
import { translate } from "@/lib/i18n";
import "@/lib/sectionText";
import "./men.css";
import CollectionShowcase from "@/components/CollectionShowcase";
import { AUDIENCE_BUILT_IN, useAudienceEditorial } from "@/lib/audienceEditorial";
import { ManagedContentProvider } from "@/lib/contentStudio";

// VIA phase 6: the hero, ticker and offer strip may come from the Content
// Studio (same markup); categories, collection and products stay live.
export default function MenPage() {
  return (
    <ManagedContentProvider page="MEN">
      <MenPageBody />
    </ManagedContentProvider>
  );
}

function MenPageBody() {
  const ed = useAudienceEditorial("MEN", AUDIENCE_BUILT_IN.MEN);
  // The filters are the page URL (refresh, back/forward, shared links).
  const { filters, setFilters } = useListingFilters();
  const [restoreScrollY] = useState(() => takeListingRestore("MEN"));
  const taxonomy = useTaxonomy();
  const lang = useLang();
  const t = (key: string) => translate(lang, key);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { favoriteIds, favoritePendingIds, favoritesLoading, favoriteLoadError, favoriteError, onToggleFavorite } =
    useProductFavorites("/men");
  const listing = useAudienceListing("MEN", filters, restoreScrollY);
  const categoryGrid = useMemo(
    () => listingCategories("MEN", taxonomy.data, listing.categoryCounts, lang),
    [taxonomy.data, listing.categoryCounts, lang],
  );
  const filterOptions = useMemo(() => listingFilterOptions("MEN", taxonomy.data, lang), [taxonomy.data, lang]);
  const chooseCategory = useCallback((value: string) => {
    setFilters({ ...filters, category: value });
    if (value) document.getElementById("men-products")?.scrollIntoView({ behavior: "smooth" });
  }, [filters, setFilters]);
  return (
    <div className={`${homeStyles.home} men-page`}>
      {ed.hero && (
      <section className="men-hero" aria-labelledby="men-hero-title">
        <h1 className="visually-hidden" id="men-hero-title">{ed.hero.title}</h1>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="men-hero-image" src={ed.hero.image} alt={ed.hero.imageAlt} fetchPriority="high" width={2041} height={770} />
        <div className="men-hero-copy" aria-hidden="true"><strong>{ed.hero.copyStrong}</strong><span>{ed.hero.copySpan}</span></div>
        <Link className="men-hero-cta" href={ed.hero.ctaHref}>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 8.5h14l-1 11H6l-1-11Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M8.5 9V6.75a3.5 3.5 0 0 1 7 0V9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          <span>{ed.hero.cta}</span>
        </Link>
      </section>
      )}

      {ed.ticker && (
      <div className="men-ticker" aria-label={ed.ticker.label}><div className="men-ticker-track">
        {[0, 1].map((copy) => <span className="men-ticker-group" key={copy} aria-hidden={copy === 1}>{ed.ticker!.items.map((text, i) => <Fragment key={i}><span>{text}</span><i>✦</i></Fragment>)}</span>)}
      </div></div>
      )}

      {ed.offer && (
      <div className="men-offer-strip" role="note">
        <span className="men-offer-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h11v10H3zM14 9h4l3 3.5V16h-7" /><circle cx="7" cy="17.5" r="1.6" /><circle cx="17.5" cy="17.5" r="1.6" /></svg></span>
        <span>{ed.offer.pre}<strong>{ed.offer.amount}</strong>{ed.offer.mid}<strong>{ed.offer.benefit}</strong></span>
        <Link href={ed.offer.href} className="men-offer-link">{ed.offer.linkLabel} <span aria-hidden="true">←</span></Link>
      </div>
      )}

      <div className="men-floor-extension"><div className="men-content">
        {(favoriteLoadError || favoriteError) && (
          <ErrorBanner message={favoriteError ?? favoriteLoadError ?? t("fav.load_failed")} />
        )}
        <WomenCategorySection categories={categoryGrid} selectedCategory={filters.category} onSelectCategory={chooseCategory} />
        {/* PD-5b.4: one live collection for men (none -> nothing). */}
        <CollectionShowcase placement="AUDIENCE" audience="MEN" presentation="women" favoriteIds={favoriteIds} favoritePendingIds={favoritePendingIds} favoritesLoading={favoritesLoading} onToggleFavorite={onToggleFavorite} />
        {taxonomy.status === "error" && <ErrorBanner message={taxonomy.error} />}
        <div id="men-products"><WomenDiscoverySection
          items={listing.items} total={listing.total} status={listing.status} hasMore={listing.hasMore} error={listing.error} audience="MEN"
          onLoadMore={listing.loadMore} onRetry={listing.retry} bestsellerEnabled={listing.bestsellerEnabled} allCount={listing.allCount} categories={categoryGrid}
          filters={filters} setFilters={setFilters} filterOptions={filterOptions}
          sidebarOpen={sidebarOpen} setSidebarOpen={setSidebarOpen}
          favoriteIds={favoriteIds} favoritePendingIds={favoritePendingIds} favoritesLoading={favoritesLoading} onToggleFavorite={onToggleFavorite}
        /></div>
      </div><Footer /></div>
    </div>
  );
}
