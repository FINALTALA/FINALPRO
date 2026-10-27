"use client";

import { IBM_Plex_Sans_Arabic, Inter_Tight } from "next/font/google";
import Link from "next/link";
import ProductCard from "@/components/ProductCard";
import type { ComparisonCardDto } from "@/lib/types";
import TrendEditorialHead from "./TrendEditorialHead";
import { useCallback, useEffect, useRef, useState } from "react";
// The /women stylesheet (all of it is scoped under .women-*), so the cards
// below are the women page's cards with the women page's styles.
import "@/app/women/women.css";
import "./trend-look.css";

// Same faces as the sections above (identical options share the font files).
const interTight = Inter_Tight({ subsets: ["latin"], weight: ["600", "900"], variable: "--tp-font-display" });
const plex = IBM_Plex_Sans_Arabic({ subsets: ["arabic"], weight: ["400", "500", "600", "700"], variable: "--ts-font-ar" });

// "Shop the look": the look's pieces in a grid of women's-page cards beside a
// sticky vertical film (REF/20261025-1449-36.6680092.mp4), opened by the
// page's editorial header (STREET EDIT). The film drives everything: the
// active piece is the last one whose start time is at or before the film's
// current time, and that ONE piece gets the "on screen" overlay, the
// "in scene" badge and the dark card frame. Mirrored for RTL: the film
// column sits on the right.
//
// The cards are the women page's ProductCard. The pieces are not in Via's
// catalogue yet, so they carry no price, sizes, stores or favourites (the
// card leaves those out when the data has none) and link to the women's
// collection.

type Match = "exact" | "styled";
type Piece = {
  key: string;
  t: number;       // second where the piece is clearest in the film (cue)
  match: Match;    // "exact" only when the photo is the very item filmed
  name: string;
  cat: string;
  color: string;   // a name lib/colors knows, so the card shows its swatch
  img: string;
  w: number;
  h: number;
  half?: boolean;  // a -half.webp exists
  alt: string;
};

// Sorted by t. Two pieces at the same second are offset by 0.5 s.
const PIECES: Piece[] = [
  {
    key: "jeans", t: 0, match: "styled",
    name: "جينز أبيض واسع بخصر عالٍ", cat: "بناطيل", color: "أبيض",
    img: "jeans-white", w: 896, h: 1200, half: true, alt: "جينز أبيض بقَصّة واسعة وخصر عالٍ",
  },
  {
    key: "tote", t: 2, match: "exact",
    name: "حقيبة جلد مضفور", cat: "حقائب", color: "بني",
    img: "tote-woven", w: 765, h: 1024, half: true, alt: "حقيبة كتف من الجلد المضفور بلون بنّي داكن",
  },
  {
    key: "heels", t: 3, match: "exact",
    name: "حذاء سلينغ باك بكعب مدبّب", cat: "أحذية", color: "خمري",
    img: "heels-oxblood", w: 765, h: 1024, half: true, alt: "حذاء عنّابي من الجلد اللامع بمقدّمة مدبّبة وحزام خلفي",
  },
  {
    key: "jacket", t: 5, match: "exact",
    name: "جاكيت جلد واسع بحزام", cat: "جاكيتات", color: "خمري",
    img: "jacket-front", w: 765, h: 1024, half: true, alt: "جاكيت جلد عنّابي داكن واسع بياقة عريضة وحزام",
  },
  {
    key: "hoops", t: 6, match: "styled",
    name: "حلق دائري ذهبي عريض", cat: "إكسسوارات", color: "ذهبي",
    img: "hoops-gold", w: 765, h: 1024, half: true, alt: "زوج أقراط دائرية ذهبية عريضة",
  },
  {
    key: "tee", t: 6.5, match: "styled",
    name: "تيشيرت قطني أبيض", cat: "تيشيرتات", color: "أبيض",
    img: "tee-white", w: 765, h: 1024, alt: "تيشيرت قطني أبيض برقبة دائرية",
  },
];

const MATCH_LABEL: Record<Match, string> = { exact: "EXACT MATCH", styled: "STYLED WITH" };
const src = (p: Piece, half = false) => `/trend/look/${p.img}${half ? "-half" : ""}.webp`;

/** The piece as a women-page card. No offer yet: no price, sizes or stores. */
const toCard = (p: Piece): ComparisonCardDto => ({
  canonical_product_id: `look-${p.key}`,
  canonical_name_ar: p.name,
  canonical_name_en: "",
  lowest_price: "",
  lowest_price_availability: "available",
  image_url: src(p),
  brand_name: null,
  category_name: p.cat,
  store_count: 0,
  colors: [p.color],
  sizes: [],
  cheapest_offer: { vendor_id: "", vendor_slug: "", offer_id: "", offer_variant_id: "" },
  store_logos: [],
});
const CARDS = PIECES.map(toCard);

/** The active piece: the last cue at or before t (the film loops to 0). */
const activeAt = (t: number) => {
  let a = 0;
  PIECES.forEach((p, i) => {
    if (p.t <= t + 0.001) a = i;
  });
  return a;
};

export default function TrendLook() {
  const rootRef = useRef<HTMLElement>(null);
  const filmRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fillRef = useRef<HTMLSpanElement>(null);
  const [active, setActive] = useState(0);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  // userPaused: the visitor stopped the film; scrolling back must not restart it.
  const st = useRef({ visible: false, userPaused: false, reduced: false, raf: 0 });

  const sync = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    setActive(activeAt(v.currentTime));
    setTime(v.currentTime);
  }, []);

  // Smooth progress line (the time label and the active piece follow
  // timeupdate / seeked; the line itself is drawn every frame).
  const drawRef = useRef<() => void>(() => {});
  const draw = useCallback(() => {
    const v = videoRef.current;
    const s = st.current;
    if (v && fillRef.current && v.duration) fillRef.current.style.transform = `scaleX(${v.currentTime / v.duration})`;
    s.raf = v && !v.paused ? requestAnimationFrame(() => drawRef.current()) : 0;
  }, []);
  useEffect(() => {
    drawRef.current = draw;
  }, [draw]);

  const autoplay = useCallback(() => {
    const v = videoRef.current;
    const s = st.current;
    if (!v) return;
    if (s.visible && !document.hidden && !s.userPaused && !s.reduced) v.play().catch(() => undefined);
    else v.pause();
  }, []);

  useEffect(() => {
    const v = videoRef.current;
    const root = rootRef.current;
    if (!v || !root) return;
    const s = st.current;
    s.reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const onPlay = () => {
      setPlaying(true);
      cancelAnimationFrame(s.raf);
      s.raf = requestAnimationFrame(draw);
    };
    const onPause = () => {
      setPlaying(false);
      draw();
    };
    const onMeta = () => {
      setDuration(v.duration);
      sync();
      draw();
    };
    const onSeeked = () => {
      sync();
      draw();
    };
    v.addEventListener("timeupdate", sync);
    v.addEventListener("seeked", onSeeked);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    if (v.readyState >= 1) onMeta();

    const io = new IntersectionObserver(([e]) => {
      s.visible = e.isIntersecting;
      if (e.isIntersecting) root.setAttribute("data-in", "");
      autoplay();
    }, { threshold: 0.25 });
    io.observe(filmRef.current ?? root);
    document.addEventListener("visibilitychange", autoplay);
    return () => {
      v.removeEventListener("timeupdate", sync);
      v.removeEventListener("seeked", onSeeked);
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      io.disconnect();
      document.removeEventListener("visibilitychange", autoplay);
      cancelAnimationFrame(s.raf);
    };
  }, [autoplay, draw, sync]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      st.current.userPaused = false;
      v.play().catch(() => undefined);
    } else {
      st.current.userPaused = true;
      v.pause();
    }
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  };

  const fullscreen = () => {
    const el = filmRef.current as (HTMLElement & { webkitRequestFullscreen?: () => void }) | null;
    const v = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    else if (el?.requestFullscreen) el.requestFullscreen().catch(() => undefined);
    else if (el?.webkitRequestFullscreen) el.webkitRequestFullscreen();
    else v?.webkitEnterFullscreen?.();
  };

  /** Progress line: click / keyboard seeking (RTL: it fills from the right). */
  const scrub = (e: React.MouseEvent<HTMLDivElement>) => {
    const v = videoRef.current;
    if (!v || !v.duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    v.currentTime = Math.min(Math.max((r.right - e.clientX) / r.width, 0), 1) * v.duration;
  };
  const scrubKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const v = videoRef.current;
    if (!v || !v.duration) return;
    const step = e.key === "ArrowLeft" ? 1 : e.key === "ArrowRight" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    v.currentTime = Math.min(Math.max(v.currentTime + step, 0), v.duration - 0.05);
  };

  /** Header link: glide to this section's products grid. */
  const toGrid = (e: React.MouseEvent<HTMLAnchorElement>) => {
    const grid = document.getElementById("tl-grid");
    if (!grid) return;
    e.preventDefault();
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Not scrollIntoView: the site's scroll-padding leaves room for a header
    // that has already left by this point of the page.
    window.scrollTo({ top: grid.getBoundingClientRect().top + window.scrollY - 24, behavior: smooth ? "smooth" : "auto" });
  };

  const now = PIECES[active];
  const total = duration || 7.5;

  return (
    <section ref={rootRef} className={`tl ${interTight.variable} ${plex.variable}`} aria-labelledby="tl-title">
      <TrendEditorialHead
        id="tl-title"
        words={["LOOK", "OF", "THE", "WEEK"]}
        label="Look of the week - إطلالة الأسبوع"
        arTitle="إطلالة الأسبوع"
        count={PIECES.length}
        link={{ href: "#tl-grid", label: "تسوّقي الإطلالة", onClick: toGrid }}
        fit
      />

      <div className="tl-layout">
        {/* ------------------------------------------------ film column */}
        <aside className="tl-film-col" aria-label="فيلم الإطلالة">
          <figure ref={filmRef} className="tl-film">
            <video
              ref={videoRef}
              className="tl-video"
              src="/trend/look/film.mp4"
              poster="/trend/look/film-poster.webp"
              muted
              loop
              playsInline
              preload="metadata"
              aria-label="فيلم قصير للعارضة بإطلالة العنّابي في الشارع"
            />
            <span className="tl-tag tl-latin"><i aria-hidden="true" />VIA FILM · 9:16</span>
            <span className="tl-clock tl-latin" aria-hidden="true"><bdi>{time.toFixed(1)}s / {total.toFixed(1)}s</bdi></span>

            <div className="tl-film-foot">
              {/* On screen now: the same piece as the active chip, badge and card. */}
              <div className="tl-onscreen" data-key={now.key}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src(now, !!now.half)} alt="" width={40} height={48} />
                <span className="tl-onscreen-text">
                  <span className="tl-onscreen-label tl-latin">ON SCREEN</span>
                  <span className="tl-onscreen-name">{now.name}</span>
                </span>
              </div>
              <div
                className="tl-progress"
                role="slider"
                tabIndex={0}
                aria-label="موضع الفيلم"
                aria-valuemin={0}
                aria-valuemax={Math.round(total * 10) / 10}
                aria-valuenow={Math.round(time * 10) / 10}
                aria-valuetext={`${time.toFixed(1)} من ${total.toFixed(1)} ثانية`}
                onClick={scrub}
                onKeyDown={scrubKey}
              >
                <span className="tl-progress-fill" ref={fillRef} />
              </div>
              <div className="tl-controls">
                <button type="button" className="tl-ctl" onClick={togglePlay} aria-label={playing ? "إيقاف الفيلم" : "تشغيل الفيلم"}>
                  {playing ? (
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6v12M15 6v12" /></svg>
                  ) : (
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z" className="is-fill" /></svg>
                  )}
                </button>
                <button type="button" className="tl-ctl" onClick={toggleMute} aria-pressed={!muted} aria-label={muted ? "تشغيل الصوت" : "كتم الصوت"}>
                  {muted ? (
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4zM16 9.5l5 5M21 9.5l-5 5" /></svg>
                  ) : (
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4zM16 9a4.5 4.5 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" /></svg>
                  )}
                </button>
                <span className="tl-scene tl-latin" aria-hidden="true">VIA STREET SCENE</span>
                <button type="button" className="tl-ctl" onClick={fullscreen} aria-label="ملء الشاشة">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M10 19H5v-5M19 5l-6 6M5 19l6-6" /></svg>
                </button>
              </div>
            </div>
          </figure>

        </aside>

        {/* --------------------------------------- the pieces (women cards) */}
        <div className="tl-main">
          <div id="tl-grid" className="women-page tl-women">
            <ul className="tl-grid">
              {PIECES.map((p, i) => (
                <li key={p.key} data-active={i === active ? "" : undefined}>
                  <ProductCard
                    card={CARDS[i]}
                    presentation="women"
                    href="/women"
                    overlay={
                      <>
                        {i === active && <span className="tl-badge tl-badge-scene tl-latin"><i aria-hidden="true" />IN SCENE</span>}
                        <span className={`tl-badge tl-badge-match tl-latin is-${p.match}`}>{MATCH_LABEL[p.match]}</span>
                      </>
                    }
                  />
                </li>
              ))}
            </ul>
          </div>

          <div className="tl-foot">
            <span className="tl-foot-count"><bdi className="tl-latin">{PIECES.length}</bdi> قطع في هذه الإطلالة</span>
            <Link href="/women" className="tl-cta">
              تصفّحي مجموعة النساء
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M10 7l-5 5 5 5" /></svg>
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
