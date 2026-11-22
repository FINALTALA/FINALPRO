"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAdsLang } from "./adsCopy";
import { FitTitle, MAIN_CATEGORIES, rvDelay, StoreMark, useReveal } from "./AdsShared";
import type { AdsCategory } from "./data/adsDemo";
import { loadViaOffers, SEGMENT_OF, type ViaOffer } from "./data/viaData";
import { ArrowUpLeft, ArrowUpRight } from "./icons";
import "./ads-offers.css";

// THE OFFER EDIT: a compact editorial board of up to four store offers,
// built only from live Via data - products discounted right now, their real
// discount (base vs sale price of the store's offer) and their product page.
//
// Placement model: two sponsored slots + two editorial selections, with
// valid organic offers filling any slot that has nothing booked. Via has no
// paid-promotion or editorial-selection data yet, so today every slot is an
// organic offer and none carries the Sponsored label. Not shown because the
// public API does not expose it: the discount's end date.

const SLOTS = 4;
type Placement = "sponsored" | "editorial" | "organic";
const SLOT_PLAN: Placement[] = ["sponsored", "editorial", "sponsored", "editorial"];

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export default function AdsOfferEdit() {
  const { t, pick, isArabic, dir } = useAdsLang();
  const [cat, setCat] = useState<"All" | AdsCategory>("All");
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; offers: ViaOffer[] }>({ status: "loading", offers: [] });
  const [attempt, setAttempt] = useState(0);
  const Arrow = isArabic ? ArrowUpLeft : ArrowUpRight;
  const intro = useReveal<HTMLDivElement>();
  const board = useReveal<HTMLDivElement>();

  useEffect(() => {
    let alive = true;
    const segment = cat === "All" ? null : SEGMENT_OF[cat] ?? null;
    loadViaOffers(segment, SLOTS)
      .then((offers) => alive && setState({ status: "ready", offers }))
      .catch(() => alive && setState({ status: "error", offers: [] }));
    return () => {
      alive = false;
    };
  }, [cat, attempt]);

  const pickCat = (c: "All" | AdsCategory) => {
    if (c === cat) return;
    setState((s) => ({ ...s, status: "loading" }));
    setCat(c);
  };

  // No sponsored or editorial bookings exist: each slot falls back to organic.
  const placed = state.offers.map((o, k) => ({ offer: o, placement: "organic" as Placement, plan: SLOT_PLAN[k] }));

  return (
    <section className="ads-section ao" aria-labelledby="offer-edit-title">
      <div className="ads-wrap">
        <div ref={intro} className="ads-intro ao-intro" dir={dir}>
          <span className="rv-mask"><span className="ads-kicker rv-up">{t("ads.offers.kicker")}</span></span>
          <FitTitle id="offer-edit-title" text={t("ads.offers.heading")} mobileLines={["THE OFFER", "EDIT"]} />
          <div className="ao-sub-row">
            <span className="rv-mask"><p className="ads-intro-sub rv-up" style={rvDelay(0.3)}>{t("ads.offers.sub")}</p></span>
            <div className="ao-cats rv-fade" style={rvDelay(0.38)} role="group" aria-label={t("ads.moreCategoriesAria")}>
              {MAIN_CATEGORIES.map((c) => (
                <button key={c} type="button" className="ads-cat" aria-pressed={cat === c} onClick={() => pickCat(c)}>
                  {t(`ads.cat.${c}`)}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div ref={board} className="ao-board rv-i" aria-busy={state.status === "loading"} dir={dir}>
          {state.status === "error" ? (
            <div className="ao-msg">
              <p>{t("ads.offers.error")}</p>
              <button type="button" onClick={() => { setState({ status: "loading", offers: [] }); setAttempt((a) => a + 1); }}>{t("ads.offers.retry")}</button>
            </div>
          ) : state.status === "loading" && state.offers.length === 0 ? (
            Array.from({ length: SLOTS }, (_, k) => <div key={k} className="ao-cell is-skeleton" aria-hidden="true" />)
          ) : placed.length === 0 ? (
            <div className="ao-msg"><p>{t("ads.offers.empty")}</p></div>
          ) : (
            placed.map(({ offer: o, placement }) => (
              <article key={o.id} className={`ao-cell${state.status === "loading" ? " is-stale" : ""}`}>
                {/* The image repeats the Shop Offer link for pointer users. */}
                <Link href={o.href} className="ao-media" tabIndex={-1} aria-hidden="true">
                  {o.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={o.image} alt="" loading="lazy" decoding="async" />
                  ) : (
                    <span className="ao-media-empty" />
                  )}
                  <span className="ao-pct-tag"><bdi>-{o.percent}%</bdi></span>
                </Link>

                <div className="ao-body">
                  <header className="ao-store">
                    <StoreMark store={o.store} size={20} />
                    <span className="ao-store-name">{pick(o.store.name)}</span>
                    {placement === "sponsored" && <span className="ao-label">{t("ads.sponsored")}</span>}
                    {placement === "editorial" && <span className="ao-label is-quiet">{t("ads.offers.editorial")}</span>}
                  </header>
                  <h3 className="ao-name">{pick(o.name)}</h3>
                  <p className="ao-price">
                    <span className="ao-now"><span className="ads-sr">{t("ads.offers.now")} </span><bdi><span className="ao-cur">₪</span>{fmt(o.now)}</bdi></span>
                    <s><span className="ads-sr">{t("ads.offers.was")} </span><bdi><span className="ao-cur">₪</span>{fmt(o.was)}</bdi></s>
                    <span className="ao-pct"><bdi>{o.percent}%</bdi> {t("ads.offers.off")}</span>
                  </p>
                  <Link href={o.href} className="ao-shop">
                    <span>{t("ads.offers.shop")}</span>
                    <Arrow />
                  </Link>
                </div>
              </article>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
