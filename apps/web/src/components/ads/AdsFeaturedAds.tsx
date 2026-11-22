"use client";

import { useAdsLang } from "./adsCopy";
import { FitTitle, rvDelay, StoreMark, useReveal } from "./AdsShared";
import { FEATURED_ADS, type FeaturedAd } from "./data/adsDemo";
import { ArrowUpLeft, ArrowUpRight } from "./icons";
import "./ads-featured.css";

// THE FEATURED EDIT (AI Studio FeaturedAdsSection): a two-row mosaic of four
// ad cards (60/40, then 40/60). Demo placements (see data/adsDemo.ts): no
// card links anywhere and "Browse Store" is inert until real ads exist.

function AdCard({ ad }: { ad: FeaturedAd }) {
  const { t, pick, isArabic, dir } = useAdsLang();
  const Arrow = isArabic ? ArrowUpLeft : ArrowUpRight;
  const body = (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={ad.image.src}
        srcSet={ad.image.srcSet}
        sizes="(max-width: 767px) 100vw, 60vw"
        alt={pick(ad.alt)}
        style={{ objectPosition: ad.objectPosition }}
        loading="lazy"
        decoding="async"
      />
      <span className="fa-scrim" aria-hidden="true" />
      <span
        className={`fa-text${ad.textBox.center ? " is-center" : ""}`}
        style={{ left: ad.textBox.left, top: ad.textBox.top, maxWidth: ad.textBox.maxWidth }}
      >
        {/* Store, then the collection, then one line about it. */}
        <span dir={dir} className="fa-text-in">
          <span className="fa-eyebrow">
            <StoreMark store={ad.store} size={20} className="is-square" />
            <span>{pick(ad.store.name)}</span>
          </span>
          <span className="fa-title" style={{ color: ad.titleColor }}>{pick(ad.title)}</span>
          <span className="fa-sub">{pick(ad.subtitle)}</span>
        </span>
      </span>
      <span className="fa-store" dir={dir}>
        <span className="fa-store-in">
          <span className="fa-store-id">
            {ad.sponsored && <span className="fa-sponsored">{t("ads.sponsored")}</span>}
            {ad.store.demo && <span className="ads-demo">{t("ads.demo")}</span>}
          </span>
          <span className={`fa-browse${ad.href ? "" : " is-unavailable"}`} title={ad.href ? undefined : t("ads.unavailableDemo")}>
            <span>{t("ads.featured.cta")}</span>
            <Arrow />
          </span>
        </span>
      </span>
    </>
  );
  const label = `${pick(ad.title)} - ${pick(ad.store.name)}`;
  return ad.href ? (
    <a href={ad.href} className="fa-card" aria-label={label}>{body}</a>
  ) : (
    <article className="fa-card is-static" aria-label={label}>{body}</article>
  );
}

// One mosaic row: its two blocks rise in together, the second 0.07 s later.
function Row({ ads }: { ads: FeaturedAd[] }) {
  const ref = useReveal<HTMLDivElement>();
  return (
    <div ref={ref} className="fa-row rv-blocks">
      {ads.map((ad) => (
        <div key={ad.id} className={`fa-cell is-${ad.span}`}><AdCard ad={ad} /></div>
      ))}
    </div>
  );
}

export default function AdsFeaturedAds() {
  const { t, dir } = useAdsLang();
  const intro = useReveal<HTMLDivElement>();
  const rows = [1, 2].map((r) => FEATURED_ADS.filter((a) => a.row === r));
  return (
    <section className="ads-section fa" aria-labelledby="featured-ads-title">
      <div className="ads-wrap">
        <div ref={intro} className="ads-intro fa-intro" dir={dir}>
          <div className="fa-kicker-row">
            <span className="rv-mask"><span className="ads-kicker rv-up">{t("ads.featured.kicker")}</span></span>
            <span className="rv-mask"><span className="fa-issue rv-up">{t("ads.featured.issue")}</span></span>
          </div>
          <FitTitle id="featured-ads-title" text={t("ads.featured.heading")} mobileLines={["THE FEATURED", "EDIT"]} />
          <span className="rv-mask">
            <p className="ads-intro-sub fa-sub-row rv-up" style={rvDelay(0.3)} lang="ar">
              {t("ads.featured.sub")}
              <span className="ads-demo" title={t("ads.demoNote")}>{t("ads.demo")}</span>
            </p>
          </span>
        </div>
        <div className="fa-mosaic">
          {rows.map((row, k) => <Row key={k} ads={row} />)}
        </div>
      </div>
    </section>
  );
}
