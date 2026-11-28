"use client";

import { IBM_Plex_Sans_Arabic, Inter_Tight } from "next/font/google";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { FEATURED_FILMS, GALLERY, type FeaturedFilm, type GalleryItem } from "./collections";
import { linkOf, mediaOf, mediaUrl, overlayItems, pickText, refOf, useManagedSection } from "@/lib/contentStudio";
import { useLang } from "@/lib/useLang";
import "./trend-collections.css";

// Same faces as the sections above (identical options share the font files).
const interTight = Inter_Tight({ subsets: ["latin"], weight: ["600", "900"], variable: "--tp-font-display" });
const plex = IBM_Plex_Sans_Arabic({ subsets: ["arabic"], weight: ["400", "500", "600", "700"], variable: "--ts-font-ar" });

// "New collections": a wide film reel (three short clips, one at a time,
// crossfading in sequence and looping) and under it the "discover the
// collections" editorial gallery. Content and destinations: ./collections.

const FADE = 0.8; // seconds of overlap between two clips (matches the CSS)
// Tiles that span the whole row on tablet and phone.
const WIDE = new Set<GalleryItem["tile"]>(["tall", "wide-xl"]);

function FilmReel({ films, kicker }: { films: FeaturedFilm[]; kicker: string }) {
  // VIA phase 6: the films (and kicker) may come from the Content Studio.
  const filmCount = useRef(films.length);
  useEffect(() => {
    filmCount.current = films.length;
  }, [films.length]);
  const rootRef = useRef<HTMLDivElement>(null);
  const vids = useRef<(HTMLVideoElement | null)[]>([]);
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  const [active, setActive] = useState(0);
  const [prev, setPrev] = useState(-1); // stays fully shown under the fade-in
  const st = useRef({ active: 0, visible: false, reduced: false, raf: 0 });

  /** Show clip i from its start; the previous one keeps playing under the fade. */
  const showRef = useRef<(i: number) => void>(() => {});
  const show = useCallback((i: number) => {
    const s = st.current;
    const v = vids.current[i];
    if (i !== s.active) setPrev(s.active);
    s.active = i;
    setActive(i);
    bars.current.forEach((b) => b && (b.style.transform = "scaleX(0)"));
    if (!v) return;
    if (v.currentTime > 0.05) v.currentTime = 0; // normally already rewound (onEnded)
    if (s.visible && !s.reduced && !document.hidden) v.play().catch(() => undefined);
  }, []);
  useEffect(() => {
    showRef.current = show;
  }, [show]);

  // One rAF loop while on screen: progress bar, and the hand-over to the next
  // clip FADE seconds before the end (no gap, no black frame).
  const loopRef = useRef<() => void>(() => {});
  const loop = useCallback(() => {
    const s = st.current;
    const v = vids.current[s.active];
    if (v && v.duration) {
      const bar = bars.current[s.active];
      if (bar) bar.style.transform = `scaleX(${Math.min(v.currentTime / v.duration, 1)})`;
      if (!s.reduced && v.currentTime >= v.duration - FADE) showRef.current((s.active + 1) % filmCount.current);
    }
    s.raf = requestAnimationFrame(() => loopRef.current());
  }, []);
  useEffect(() => {
    loopRef.current = loop;
  }, [loop]);

  useEffect(() => {
    const s = st.current;
    const root = rootRef.current;
    if (!root) return;
    s.reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const run = () => {
      const on = s.visible && !document.hidden && !s.reduced;
      cancelAnimationFrame(s.raf);
      vids.current.forEach((v, i) => {
        if (!v) return;
        if (on && i === s.active) v.play().catch(() => undefined);
        else v.pause();
      });
      if (on) s.raf = requestAnimationFrame(() => loopRef.current());
    };
    const io = new IntersectionObserver(([e]) => {
      s.visible = e.isIntersecting;
      run();
    }, { threshold: 0.2 });
    io.observe(root);
    document.addEventListener("visibilitychange", run);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", run);
      cancelAnimationFrame(s.raf);
    };
  }, []);

  // A clip that has faded out is rewound at once, so its next turn starts
  // on a decoded first frame (no seek while it fades in).
  const onEnded = (i: number) => {
    const v = vids.current[i];
    if (!v || i === st.current.active) return;
    v.pause();
    v.currentTime = 0;
  };

  const film = films[active] ?? films[0];

  return (
    <div ref={rootRef} className="nc-reel" aria-roledescription="عرض أفلام" aria-label="مجموعات جديدة">
      {films.map((f, i) => (
        <video
          key={f.key}
          ref={(el) => { vids.current[i] = el; }}
          className="nc-video"
          data-on={i === active ? "" : undefined}
          data-prev={i === prev && i !== active ? "" : undefined}
          src={f.video}
          poster={f.poster}
          muted
          playsInline
          preload="auto"
          onEnded={() => onEnded(i)}
          style={{ "--nc-focus": f.focus ?? "50% 50%" } as React.CSSProperties}
          aria-hidden={i !== active}
        />
      ))}
      <div className="nc-reel-shade" aria-hidden="true" />

      <div className="nc-reel-copy" key={film.key} aria-live="polite">
        <span className="nc-kicker nc-latin">{kicker} · <bdi>{String(active + 1).padStart(2, "0")}/{String(films.length).padStart(2, "0")}</bdi></span>
        <h3 className="nc-reel-title nc-latin">{film.title}</h3>
        <span className="nc-reel-ar">{film.titleAr}{film.store && <> · {film.store}</>}</span>
        {film.href && (
          <Link href={film.href} className="nc-cta nc-latin">DISCOVER COLLECTION <span aria-hidden="true">↗</span></Link>
        )}
      </div>

      <div className="nc-dots" role="group" aria-label="اختيار الفيلم">
        {films.map((f, i) => (
          <button
            key={f.key}
            type="button"
            className="nc-dot"
            aria-label={`${f.title} - ${f.titleAr}`}
            aria-current={i === active ? "true" : undefined}
            onClick={() => show(i)}
          >
            <span className="nc-dot-fill" ref={(el) => { bars.current[i] = el; }} />
          </button>
        ))}
      </div>
    </div>
  );
}

function GalleryCard({ item }: { item: GalleryItem }) {
  const native = item.fit === "native";
  const body = (
    <>
      <span className={`nc-media${native ? " is-native" : ""}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.fullSrc ?? `${item.src}.webp`}
          srcSet={item.half && !item.fullSrc ? `${item.src}-half.webp ${Math.round(item.w / 2)}w, ${item.src}.webp ${item.w}w` : undefined}
          sizes={WIDE.has(item.tile) ? "(max-width: 1099px) 92vw, 54vw" : "(max-width: 1099px) 46vw, 36vw"}
          width={item.w}
          height={item.h}
          alt={item.alt}
          loading="lazy"
          decoding="async"
          style={native ? { maxWidth: `min(100%, ${item.w}px)`, maxHeight: `min(100%, ${item.h}px)` } : { objectPosition: item.focus }}
        />
      </span>
      <span className="nc-card-copy">
        <span className="nc-card-title nc-latin">{item.title}</span>
        <span className="nc-card-ar">{item.titleAr}{item.store && <> · {item.store}</>}</span>
        {item.href && <span className="nc-card-cta nc-latin" aria-hidden="true">DISCOVER <i>↗</i></span>}
      </span>
    </>
  );
  const cls = `nc-card is-${item.tile}${item.tone === "light" || native ? " is-light" : ""}`;
  return (
    <li className={cls}>
      {item.href ? (
        <Link href={item.href} className="nc-card-in" aria-label={`${item.title} - ${item.titleAr}`}>{body}</Link>
      ) : (
        <div className="nc-card-in">{body}</div>
      )}
    </li>
  );
}

export default function TrendCollections() {
  const ref = useRef<HTMLElement>(null);

  // Gallery rises in once, as it scrolls into view.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.dataset.in = "";
      return;
    }
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) {
        el.dataset.in = "";
        io.disconnect();
      }
    }, { threshold: 0.05 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // VIA phase 6: Reels & Videos (the film reel) and Discover Collections
  // (the gallery) may come from the Content Studio - same reel, same tiles.
  const lang = useLang();
  const reels = useManagedSection("trend.reels");
  const gallery = useManagedSection("trend.collections");
  const films = overlayItems(reels, FEATURED_FILMS, (f) => f.key, (base, it) => {
    const m = mediaOf(it.fields.video);
    if (!m || m.kind !== "VIDEO") return null; // a reel needs its video
    return {
      ...base,
      key: it.id,
      title: pickText(it.fields.title, "en", base.title),
      titleAr: pickText(it.fields.title, "ar", base.titleAr),
      video: mediaUrl(it.fields.video)!,
      store: null,
    };
  });
  const tiles = overlayItems(gallery, GALLERY, (g) => g.key, (base, it) => {
    const src = mediaUrl(it.fields.image, null);
    if (!src) return null;
    const col = refOf(it.fields.collection);
    return {
      ...base,
      key: it.id,
      title: pickText(it.fields.title, "en", base.title),
      titleAr: pickText(it.fields.title, "ar", base.titleAr),
      fullSrc: src === `${base.src}.webp` ? undefined : src,
      alt: pickText(mediaOf(it.fields.image)?.alt, lang, base.alt),
      href: col?.href ?? linkOf(it.fields.link, base.href),
      store: null,
    };
  });
  const kicker = reels.mode === "managed" ? pickText(reels.section.fields.heading, "en", "NEW COLLECTIONS") : "NEW COLLECTIONS";
  const galleryTitle =
    gallery.mode === "managed" ? pickText(gallery.section.fields.heading, "en", "DISCOVER THE COLLECTIONS") : "DISCOVER THE COLLECTIONS";
  const galleryLead =
    gallery.mode === "managed"
      ? pickText(gallery.section.fields.heading, "ar", "مجموعات مختارة بحسب الأسلوب والمزاج، من الكتّان الهادئ إلى الذهب.")
      : "مجموعات مختارة بحسب الأسلوب والمزاج، من الكتّان الهادئ إلى الذهب.";
  if (films.length === 0 && tiles.length === 0) return null;

  return (
    <section ref={ref} className={`nc ${interTight.variable} ${plex.variable}`} aria-labelledby="nc-title">
      {films.length > 0 && <FilmReel films={films} kicker={kicker} />}

      {tiles.length > 0 && (
        <>
          <div className="nc-head">
            <h2 id="nc-title" className="nc-title nc-latin">{galleryTitle}</h2>
            <p className="nc-lead">{galleryLead}</p>
          </div>

          <ul className="nc-gallery">
            {tiles.map((g) => <GalleryCard key={g.key} item={g} />)}
          </ul>
        </>
      )}
    </section>
  );
}
