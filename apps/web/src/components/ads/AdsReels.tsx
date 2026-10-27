"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAdsLang } from "./adsCopy";
import { FilterControls, FitTitle, rvDelay, Strip, StoreMark, useCategoryFilter, useReveal, type Feed } from "./AdsShared";
import ReelsViewer from "./AdsReelsViewer";
import { REELS, type AdsCategory, type Reel } from "./data/adsDemo";
import { Play } from "./icons";
import "./ads-reels.css";

// STYLE IN MOTION / REELS (AI Studio ReelsSection): 9:16 video cards that
// play while on screen (muted, inline); a card opens the full viewer. All
// reels are demo data (see data/adsDemo.ts).

const EXTRA: AdsCategory[] = ["Shoes", "Bags", "Jewelry", "Sports"];

function ReelCard({ reel, index, viewerOpen, onOpen }: { reel: Reel; index: number; viewerOpen: boolean; onOpen: (i: number) => void }) {
  const { t, pick, dir } = useAdsLang();
  const cardRef = useRef<HTMLButtonElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Play while at least 35 % visible and the viewer is closed.
  useEffect(() => {
    const v = videoRef.current;
    const el = cardRef.current;
    if (!v || !el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !viewerOpen) v.play().catch(() => undefined);
      else v.pause();
    }, { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, [viewerOpen]);

  return (
    <button ref={cardRef} type="button" className="ar-card" onClick={() => onOpen(index)} aria-label={t("ads.reels.watch", { title: pick(reel.title) })}>
      <span className="ar-frame">
        <video ref={videoRef} src={reel.video} muted loop playsInline preload="metadata" />
        <span className="ar-shade" aria-hidden="true" />
        <span className="ar-badges">
          {reel.sponsored ? <span className="ar-sponsored">{t("ads.sponsored")}</span> : <span />}
          <span className="ar-play"><Play /></span>
        </span>
        <span className="ar-text" dir={dir}>
          <span className="ar-title">{pick(reel.title)}</span>
          <span className="ar-caption">{pick(reel.caption)}</span>
        </span>
      </span>
      <span className="as-id" dir={dir}>
        <StoreMark store={reel.store} size={22} />
        <span className="as-name">{pick(reel.store.name)}</span>
      </span>
    </button>
  );
}

export default function AdsReels() {
  const { t, dir } = useAdsLang();
  const [open, setOpen] = useState<number | null>(null);
  const [feed, setFeed] = useState<Feed>("discover");
  const cats = useCategoryFilter();
  const intro = useReveal<HTMLDivElement>();
  const bar = useReveal<HTMLDivElement>();

  const reels = useMemo(
    () => REELS.filter((r) => (feed === "discover" || r.followingDemo) && cats.matches(r.categories)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [feed, cats.selected],
  );

  return (
    <section className="ads-section ar" aria-labelledby="reels-editorial-title">
      <div className="ads-wrap">
        <div ref={intro} className="ads-intro" dir={dir}>
          <span className="rv-mask"><span className="ads-kicker rv-up">{t("ads.reels.presents")}</span></span>
          <FitTitle id="reels-editorial-title" text={t("ads.reels.heading")} mobileLines={["STYLE IN", "MOTION"]} />
          <span className="rv-mask"><p className="ads-intro-sub rv-up" style={rvDelay(0.3)} lang="ar">{t("ads.reels.sub")}</p></span>
        </div>

        <div ref={bar} className="ads-filterbar ar-bar rv-fade" style={rvDelay(0.38)} dir={dir}>
          <div className="as-head">
            <span className="ar-label">{t("ads.reels.label")}</span>
            <span className="ads-demo" title={t("ads.demoNote")}>{t("ads.demo")}</span>
          </div>
          <FilterControls feed={feed} onFeed={setFeed} selected={cats.selected} onToggle={cats.toggle} extra={EXTRA} />
        </div>

        {reels.length === 0 ? (
          <div className="ads-empty" dir={dir}>
            <p>{feed === "following" ? t("ads.reels.emptyFollowing") : t("ads.reels.empty")}</p>
            <button type="button" onClick={() => { cats.setSelected(new Set()); setFeed("discover"); }}>{t("ads.reels.showAll")}</button>
          </div>
        ) : (
          <Strip prevLabel={t("ads.reels.prev")} nextLabel={t("ads.reels.next")} step={350}>
            {reels.map((r, k) => (
              <ReelCard key={r.id} reel={r} index={k} viewerOpen={open !== null} onOpen={setOpen} />
            ))}
          </Strip>
        )}
      </div>

      {open !== null && <ReelsViewer reels={reels} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </section>
  );
}
