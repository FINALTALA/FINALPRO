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
import { Fragment, useMemo, useState } from "react";
import { useProductFavorites } from "@/lib/useProductFavorites";
import { useLang } from "@/lib/useLang";
import { translate } from "@/lib/i18n";
import "@/lib/sectionText";
import homeStyles from "@/app/home-via.module.css";
import "./women.css";
import CollectionShowcase from "@/components/CollectionShowcase";
import { AUDIENCE_BUILT_IN, useAudienceEditorial } from "@/lib/audienceEditorial";
import { ManagedContentProvider } from "@/lib/contentStudio";

// VIA phase 6: the hero, ticker and offer strip may come from the Content
// Studio (same markup); categories, collection and products stay live.
export default function WomenPage() {
  return (
    <ManagedContentProvider page="WOMEN">
      <WomenPageBody />
    </ManagedContentProvider>
  );
}

function WomenPageBody() {
  const ed = useAudienceEditorial("WOMEN", AUDIENCE_BUILT_IN.WOMEN);
  // The filters are the page URL (refresh, back/forward, shared links);
  // returning with the back button also restores the loaded list and
  // scroll position (see lib/audienceListing.ts).
  const { filters, setFilters } = useListingFilters();
  const [restoreScrollY] = useState(() => takeListingRestore("WOMEN"));
  const taxonomy = useTaxonomy();
  const lang = useLang();
  const t = (key: string) => translate(lang, key);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { favoriteIds, favoritePendingIds, favoritesLoading, favoriteLoadError, favoriteError, onToggleFavorite } =
    useProductFavorites("/women");

  const listing = useAudienceListing("WOMEN", filters, restoreScrollY);
  const { categoryCounts } = listing;
  const categoryGrid = useMemo(
    () => listingCategories("WOMEN", taxonomy.data, categoryCounts, lang),
    [taxonomy.data, categoryCounts, lang],
  );
  const filterOptions = useMemo(() => listingFilterOptions("WOMEN", taxonomy.data, lang), [taxonomy.data, lang]);

  return (
    <div className={`${homeStyles.home} women-page`}>
      {ed.hero && (
      <section className="women-hero" aria-labelledby="women-hero-title">
        <h1 className="visually-hidden" id="women-hero-title">{ed.hero.title}</h1>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="women-hero-image"
          src={ed.hero.image}
          alt=""
          aria-hidden="true"
          fetchPriority="high"
          width={2037}
          height={768}
        />
        {ed.hero.titleArt && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="women-hero-title-art"
            src={ed.hero.titleArt}
            alt=""
            aria-hidden="true"
            width={936}
            height={287}
          />
        )}
        {ed.hero.subject && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="women-hero-subject"
            src={ed.hero.subject}
            alt=""
            aria-hidden="true"
            fetchPriority="high"
            width={2037}
            height={768}
          />
        )}
        <Link className="women-hero-cta" href={ed.hero.ctaHref}>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5 8.5h14l-1 11H6l-1-11Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="M8.5 9V6.75a3.5 3.5 0 0 1 7 0V9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <span>{ed.hero.cta}</span>
        </Link>
      </section>
      )}

      {ed.ticker && (
      <div className="women-ticker" aria-label={ed.ticker.label}>
        <div className="women-ticker-track">
          {[0, 1].map((copy) => (
            <span className="women-ticker-group" key={copy} aria-hidden={copy === 1}>
              {ed.ticker!.items.map((text, i) => (
                <Fragment key={i}>
                  <span>{text}</span>
                  <i aria-hidden="true">✦</i>
                </Fragment>
              ))}
            </span>
          ))}
        </div>
      </div>
      )}

      {ed.offer && (
      <div className="women-offer-strip" role="note">
        <span className="women-offer-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h11v10H3zM14 9h4l3 3.5V16h-7" />
            <circle cx="7" cy="17.5" r="1.6" />
            <circle cx="17.5" cy="17.5" r="1.6" />
          </svg>
        </span>
        <span>
          {ed.offer.pre}<strong>{ed.offer.amount}</strong>{ed.offer.mid}<strong>{ed.offer.benefit}</strong>
        </span>
        <Link href={ed.offer.href} className="women-offer-link">{ed.offer.linkLabel} <span aria-hidden="true">←</span></Link>
      </div>
      )}

      <div className="women-floor-extension">
      <div className="women-content">
        <WomenCategorySection
          categories={categoryGrid}
          selectedCategory={filters.category}
          onSelectCategory={(value) => {
            setFilters({ ...filters, category: value });
            if (value) document.getElementById("women-products")?.scrollIntoView({ behavior: "smooth" });
          }}
        />
        {/* PD-5b.4: one live collection for women (none -> nothing). */}
        <CollectionShowcase placement="AUDIENCE" audience="WOMEN" presentation="women" favoriteIds={favoriteIds} favoritePendingIds={favoritePendingIds} favoritesLoading={favoritesLoading} onToggleFavorite={onToggleFavorite} />

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
