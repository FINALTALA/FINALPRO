"use client";

import { useEffect, useRef, useState } from "react";
import { useAdsLang } from "./adsCopy";
import { HERO_SLIDES } from "./data/adsDemo";
import { ArrowUpLeft, ArrowUpRight, ChevronLeft, ChevronRight } from "./icons";
import "./ads-hero.css";

// Advertising hero (AI Studio AdvertisingHero): exactly three campaign
// slides, 3 s each, crossfade + slow zoom. Text is HTML in the site
// language; each slide's text block sits where its image has room and does
// not move with the language. The store block on the right follows the
// active slide. The 3 s clock is the active bar's CSS animation, so
// pausing (hover, keyboard focus, off-screen, hidden tab) just pauses it.

const SLIDE_MS = 3000;

export default function AdsHero() {
  const { t, pick, isArabic, dir } = useAdsLang();
  const n = HERO_SLIDES.length;
  const [i, setI] = useState(0);
  const [round, setRound] = useState(0);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [away, setAway] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [ready, setReady] = useState(false); // clock starts after hydration
  const rootRef = useRef<HTMLElement>(null);
  const swipe = useRef<{ x: number; y: number; id: number } | null>(null);

  const go = (to: number) => {
    setI(((to % n) + n) % n);
    setRound((r) => r + 1);
  };

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      setReduced(mq.matches);
      setReady(true);
    };
    sync();
    mq.addEventListener("change", sync);
    const io = new IntersectionObserver(([e]) => setAway(!e.isIntersecting), { threshold: 0.25 });
    if (rootRef.current) io.observe(rootRef.current);
    const vis = () => setAway(document.hidden);
    document.addEventListener("visibilitychange", vis);
    return () => {
      mq.removeEventListener("change", sync);
      io.disconnect();
      document.removeEventListener("visibilitychange", vis);
    };
  }, []);

  const paused = hover || focus || away;
  const slide = HERO_SLIDES[i];
  const store = slide.store;
  const Arrow = isArabic ? ArrowUpLeft : ArrowUpRight;

  return (
    <section
      ref={rootRef}
      className="ah"
      aria-roledescription="carousel"
      aria-label={t("ads.hero.aria")}
      data-paused={paused ? "" : undefined}
      onPointerEnter={(e) => e.pointerType === "mouse" && setHover(true)}
      onPointerLeave={(e) => e.pointerType === "mouse" && setHover(false)}
      onFocus={(e) => e.target.matches(":focus-visible") && setFocus(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setFocus(false)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") { e.preventDefault(); go(i - 1); }
        else if (e.key === "ArrowRight") { e.preventDefault(); go(i + 1); }
      }}
      onPointerDown={(e) => {
        if (e.pointerType !== "mouse") swipe.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
      }}
      onPointerUp={(e) => {
        const s = swipe.current;
        swipe.current = null;
        if (!s || s.id !== e.pointerId) return;
        const dx = e.clientX - s.x;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(e.clientY - s.y) * 1.3) go(dx < 0 ? i + 1 : i - 1);
      }}
    >
      {/* Exactly three slides: crossfade, subtle zoom, per-slide text. */}
      {HERO_SLIDES.map((s, k) => {
        const on = k === i;
        return (
          <div key={s.id} className="ah-slide" data-on={on ? "" : undefined} aria-hidden={!on || undefined}>
            <div className="ah-media">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                key={on ? `on-${round}` : "off"}
                className={on && !reduced ? "is-zoom" : undefined}
                src={s.image.src}
                srcSet={s.image.srcSet}
                sizes="100vw"
                width={s.image.w}
                height={s.image.h}
                alt={pick(s.alt)}
                style={{ "--pos": s.objectPosition, "--pos-m": s.mobile?.objectPosition ?? s.objectPosition } as React.CSSProperties}
                fetchPriority={k === 0 ? "high" : "low"}
                loading={k === 0 ? "eager" : "lazy"}
                decoding="async"
                draggable={false}
              />
            </div>
            <div className="ah-vignette" aria-hidden="true" />
            <div
              className={`ah-text${s.textBox.center ? " is-center" : ""}${s.mobile?.textBox ? " has-m" : ""}${s.tone === "light" ? " is-light" : ""}${(s.toneMobile ?? s.tone) === "light" ? " is-light-m" : ""}`}
              style={{
                "--l": s.textBox.left, "--t": s.textBox.top, "--mw": s.textBox.maxWidth,
                "--l-m": s.mobile?.textBox?.left, "--t-m": s.mobile?.textBox?.top, "--mw-m": s.mobile?.textBox?.maxWidth,
              } as React.CSSProperties}
            >
              {/* Store, collection, short description, action. Demo partners:
                  marked as demo, and the action has no destination yet. */}
              <div dir={dir} className={isArabic ? "is-ar" : "is-en"}>
                <p className="ah-eyebrow">
                  <span>{t("ads.hero.presents", { store: pick(s.store.name) })}</span>
                  {s.store.demo && <span className="ads-demo">{t("ads.demo")}</span>}
                </p>
                <h2 className="ah-title">{pick(s.title)}</h2>
                <p className="ah-sub">{pick(s.subtitle)}</p>
                {s.store.slug ? (
                  <a href={`/store/${s.store.slug}`} className="ah-cta">{t("ads.hero.cta")}</a>
                ) : (
                  <span className="ah-cta is-unavailable" role="link" aria-disabled="true" title={t("ads.unavailableDemo")}>{t("ads.hero.cta")}</span>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {/* Store identity on the right, following the active slide. */}
      <aside
        className={`ah-store${slide.storeTone === "light" ? " is-light" : ""}${(slide.storeToneMobile ?? slide.storeTone) === "light" ? " is-light-m" : ""}`}
        aria-label={t("ads.hero.storeAria")}
      >
        <span className="ah-store-wash" aria-hidden="true" />
        <div key={store.id} dir={dir} className="ah-store-in">
          <div className="ah-store-head">
            <div className={`ah-store-logo is-${store.logoBg}`} aria-hidden="true">{store.monogram}</div>
            <div className="ah-store-id">
              <div className="ah-store-name-row">
                <h3 className="ah-store-name">{pick(store.name)}</h3>
                {store.demo && <span className="ads-demo">{t("ads.demo")}</span>}
              </div>
              <p className="ah-store-line">{pick(store.subline)}</p>
            </div>
          </div>
          {/* No real store behind the demo partners yet: the link keeps its
              place but is inert. */}
          {store.slug ? (
            <a href={`/store/${store.slug}`} className="ah-store-btn">
              <span>{t("ads.browseStore")}</span>
              <Arrow />
            </a>
          ) : (
            <span className="ah-store-btn is-unavailable" role="link" aria-disabled="true" title={t("ads.unavailableDemo")}>
              <span>{t("ads.browseStore")}</span>
              <Arrow />
            </span>
          )}
        </div>
      </aside>

      {/* Counter, progress bars and arrows (bottom-left, as designed). */}
      <div className="ah-controls">
        <div className="ah-count" aria-label={t("ads.hero.counter", { n: i + 1, total: n })}>
          <bdi>
            <b>0{i + 1}</b><i>/</i><span>0{n}</span>
          </bdi>
        </div>
        <div className="ah-bars" role="group" aria-label={t("ads.hero.pick")}>
          {HERO_SLIDES.map((s, k) => (
            <button
              key={s.id}
              type="button"
              className="ah-bar"
              aria-label={t("ads.hero.slide", { n: k + 1 })}
              aria-current={k === i ? "true" : undefined}
              onClick={() => go(k)}
            >
              {k === i && (
                <span
                  key={round}
                  className="ah-bar-fill"
                  data-run={ready && !reduced ? "" : undefined}
                  style={{ "--ah-time": `${SLIDE_MS}ms` } as React.CSSProperties}
                  onAnimationEnd={() => go(i + 1)}
                />
              )}
            </button>
          ))}
        </div>
        <div className="ah-arrows">
          <button type="button" className="ah-arrow" aria-label={t("ads.hero.prev")} onClick={() => go(i - 1)}>
            <ChevronLeft />
          </button>
          <button type="button" className="ah-arrow" aria-label={t("ads.hero.next")} onClick={() => go(i + 1)}>
            <ChevronRight />
          </button>
        </div>
      </div>
    </section>
  );
}
