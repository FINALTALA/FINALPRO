"use client";

import { IBM_Plex_Sans_Arabic, Syne } from "next/font/google";
import { useEffect, useRef } from "react";
import "./trend-hero.css";

// The site's own header (the homepage bar, rendered by AppShell) sits on
// top of this hero, so the hero has no header of its own.
const syne = Syne({ subsets: ["latin"], weight: ["600", "700", "800"], variable: "--th-font-name" });
const plex = IBM_Plex_Sans_Arabic({ subsets: ["arabic"], weight: ["300", "400", "500", "600", "700"], variable: "--th-font-ar" });

export default function TrendHero() {
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let destroy: (() => void) | undefined;
    let cancelled = false;
    // The engine touches window/WebGL, so it loads on the client only.
    import("./engine.js").then(({ mountTrendHero }) => {
      if (cancelled) return;
      destroy = mountTrendHero(root, {
        // The site header is fixed over the hero: start the model's head
        // just below its navigation bar, never under it.
        topInset: () => {
          const nav = document.querySelector(".trend-page-header nav");
          if (!nav) return 0;
          return nav.getBoundingClientRect().bottom - root.getBoundingClientRect().top + 16;
        },
      });
    });
    return () => {
      cancelled = true;
      destroy?.();
    };
  }, []);

  return (
    <section
      ref={rootRef}
      className={`th-hero ${syne.variable} ${plex.variable}`}
      aria-roledescription="عارض الإطلالات"
      aria-label="الإطلالات الأكثر طلباً"
    >
      {/* Loader: percentage of decoded look images */}
      <div className="th-loader" data-th="loader" role="status" aria-live="polite">
        <span className="th-loader-brand" data-th="loaderBrand">الترند</span>
        <span className="th-loader-bar"><span className="th-loader-fill" data-th="loaderFill" /></span>
        <span className="th-loader-pct"><span data-th="loaderPct">0</span>%</span>
      </div>

      {/* Layer 0: faint editorial word, behind the model */}
      <div className="th-bg-word" data-th="bgWord" aria-hidden="true">TREND</div>

      {/* Layer 1: the model (WebGL canvas, or <img> fallback) */}
      <canvas className="th-stage" data-th="stage" aria-hidden="true" />
      <div className="th-stage-fallback" data-th="fallback" aria-hidden="true" />

      {/* Layer 2: the editorial headline */}
      <div className="th-name-wrap" data-th="nameWrap">
        <h1 className="th-name" data-th="name">
          <span className="th-sr-only" data-th="nameLive" aria-live="polite" />
          <span className="th-name-spacer" data-th="nameSpacer" aria-hidden="true" />
          <span className="th-name-ghost" data-th="nameGhost" aria-hidden="true" />
          <span className="th-name-slices" data-th="nameSlices" aria-hidden="true" />
        </h1>
      </div>

      {/* Layer 3: interface */}
      <div className="th-ui">
        <p className="th-look-index" aria-hidden="true">
          LOOK <b data-th="lookNum">01</b> / <span data-th="lookTotal">02</span>
        </p>

        <div className="th-info" data-th="info">
          <div className="th-meta">
            <p className="th-line-ar" data-th="lineAr" />
            <span className="th-badge" data-th="badge" />
          </div>
        </div>

        <div className="th-controls" data-th="controls">
          <div className="th-dots" data-th="dots" role="tablist" aria-label="الإطلالات" />
          <div className="th-arrows">
            <button className="th-arrow th-arrow-prev" data-th="prevBtn" type="button" aria-label="الإطلالة السابقة">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M14 7l5 5-5 5" /></svg>
            </button>
            <button className="th-arrow th-arrow-next" data-th="nextBtn" type="button" aria-label="الإطلالة التالية">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M10 7l-5 5 5 5" /></svg>
            </button>
          </div>
          {/* href is set per look by the engine (plain <a>: the engine owns it) */}
          <a className="th-cta" data-th="cta" href="/women">
            <span>تسوّق الإطلالة</span>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M10 7l-5 5 5 5" /></svg>
          </a>
        </div>

        <div className="th-cards" data-th="cards" aria-label="قطع الإطلالة" />

        <div className="th-cam" data-th="cam" aria-hidden="true">
          <span className="th-cam-label">الرأس</span>
          <span className="th-cam-track" data-th="camTrack"><span className="th-cam-dot" data-th="camDot" /></span>
          <span className="th-cam-label">الحذاء</span>
        </div>

        <button className="th-next-box" data-th="nextBox" type="button" aria-label="انتقل للترند التالي">
          <span className="th-next-media" data-th="nextMedia" />
          <span className="th-next-text">
            <span className="th-next-kicker">اسحب ←</span>
            <span className="th-next-title">الترند التالي</span>
            <span className="th-next-name" data-th="nextName" />
          </span>
        </button>

        <p className="th-hint" data-th="hint" aria-hidden="true">
          <span className="th-hint-mouse"><span /></span>
          مرّر للأسفل
        </p>
      </div>
    </section>
  );
}
