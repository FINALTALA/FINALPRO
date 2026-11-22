"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useAdsLang } from "./adsCopy";
import { FilterControls, FitTitle, rvDelay, Strip, StoreMark, useCategoryFilter, useReveal } from "./AdsShared";
import { DEMO_FEATURED_STORES, type AdsCategory, type FeaturedStore } from "./data/adsDemo";
import { STORE_COVER_OVERRIDES } from "./data/storeCovers";
import { useViaFeaturedStores } from "./data/viaData";
import { ArrowUpLeft, ArrowUpRight } from "./icons";
import "./ads-stores.css";

// DISCOVER STORES (AI Studio FeaturedStoresSection): one row of 5:3 store
// cards. Real Via stores (published, active, with a storefront cover) come
// first and link to their store page; the design's placeholder stores follow,
// marked as demo and not linked.

const EXTRA: AdsCategory[] = ["Shoes", "Bags", "Jewelry"];

function StoreCard({ item }: { item: FeaturedStore }) {
  const { t, pick, isArabic, dir } = useAdsLang();
  const Arrow = isArabic ? ArrowUpLeft : ArrowUpRight;
  const slug = item.store.slug;
  const own = STORE_COVER_OVERRIDES[item.store.id];
  const cover = own?.src ?? item.cover;
  const position = (own ? own.objectPosition : item.objectPosition) ?? "center";
  const alt = own?.alt ?? item.coverAlt;
  const body = (
    <>
      <span className="fs-cover">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={cover} alt={pick(alt)} style={{ objectPosition: position }} loading="lazy" decoding="async" />
        <span className="fs-shade" aria-hidden="true" />
        {item.sponsored && <span className="fs-badge"><span className="fs-sponsored">{t("ads.sponsored")}</span></span>}
      </span>
      <span className="fs-id" dir={dir}>
        <span className="fs-name-row">
          <StoreMark store={item.store} size={32} />
          <span className="fs-name">{pick(item.store.name)}</span>
          {item.store.demo && <span className="ads-demo">{t("ads.demo")}</span>}
        </span>
        <span className="fs-cats">{(isArabic ? item.categoryLabels.ar : item.categoryLabels.en).join(" • ")}</span>
        <span className={`fs-browse${slug ? "" : " is-unavailable"}`} title={slug ? undefined : t("ads.unavailableDemo")}>
          <span>{t("ads.browseStore")}</span>
          <Arrow />
        </span>
      </span>
    </>
  );
  const label = t("ads.stores.card", { name: pick(item.store.name) });
  return slug ? (
    <Link href={`/store/${slug}`} className="fs-card" aria-label={label}>{body}</Link>
  ) : (
    <article className="fs-card is-static" aria-label={label}>{body}</article>
  );
}

export default function AdsFeaturedStores() {
  const { t, dir } = useAdsLang();
  const cats = useCategoryFilter();
  const real = useViaFeaturedStores();
  const intro = useReveal<HTMLDivElement>();
  const bar = useReveal<HTMLDivElement>();
  const list = useMemo(
    () => [...real.stores, ...DEMO_FEATURED_STORES].filter((s) => cats.matches(s.categories)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [real.stores, cats.selected],
  );

  return (
    <section className="ads-section fs" aria-labelledby="discover-stores-heading">
      <div className="ads-wrap">
        <div ref={intro} className="ads-intro fs-intro" dir={dir}>
          <span className="rv-mask"><span className="ads-kicker rv-up">VIA / STORES</span></span>
          <FitTitle id="discover-stores-heading" text={t("ads.stores.heading")} mobileLines={["DISCOVER", "STORES"]} />
        </div>
        <div ref={bar} className="ads-filterbar fs-bar rv-fade" style={rvDelay(0.38)} dir={dir}>
          <FilterControls
            selected={cats.selected}
            onToggle={cats.toggle}
            extra={EXTRA}
            trailing={
              <>
                <div className="ads-vsep" aria-hidden="true" />
                {/* No store directory page exists yet. */}
                <span className="fs-viewall is-unavailable" role="link" aria-disabled="true" title={t("ads.stores.viewAllSoon")}>{t("ads.viewAll")}</span>
              </>
            }
          />
        </div>

        {list.length === 0 ? (
          <div className="ads-empty" dir={dir}>
            <p>{t("ads.stores.empty")}</p>
            <button type="button" onClick={() => cats.setSelected(new Set())}>{t("ads.stores.showAll")}</button>
          </div>
        ) : (
          <Strip prevLabel={t("ads.stores.prev")} nextLabel={t("ads.stores.next")} btnTop="33%">
            {list.map((s) => <StoreCard key={s.store.id} item={s} />)}
          </Strip>
        )}
      </div>
    </section>
  );
}
