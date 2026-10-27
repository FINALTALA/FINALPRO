"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useAdsLang } from "./adsCopy";
import type { AdsCategory, AdsStore } from "./data/adsDemo";
import { ChevronLeft, ChevronRight, Sliders } from "./icons";

// Pieces shared by the Stories, Reels and Featured Stores sections (the
// design repeats the same filter row and horizontal strip in each).

export type Feed = "discover" | "following";
export const MAIN_CATEGORIES: ("All" | AdsCategory)[] = ["All", "Women", "Men", "Kids", "Accessories"];

/** Multi-select category state (AND matching), "All" clears it. */
export function useCategoryFilter() {
  const [selected, setSelected] = useState<Set<AdsCategory>>(() => new Set());
  const toggle = (c: "All" | AdsCategory) => {
    if (c === "All") return setSelected(new Set());
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  };
  const matches = (cats: readonly AdsCategory[]) => [...selected].every((c) => cats.includes(c));
  return { selected, setSelected, toggle, matches };
}

export function FilterControls({
  feed,
  onFeed,
  selected,
  onToggle,
  extra,
  trailing,
}: {
  feed?: Feed;
  onFeed?: (f: Feed) => void;
  selected: Set<AdsCategory>;
  onToggle: (c: "All" | AdsCategory) => void;
  extra: AdsCategory[];
  trailing?: ReactNode;
}) {
  const { t } = useAdsLang();
  const [open, setOpen] = useState(false);
  const extraPicked = extra.some((c) => selected.has(c));
  return (
    <div className="ads-controls">
      {feed && onFeed && (
        <>
          <div className="ads-tabs">
            {(["discover", "following"] as Feed[]).map((f) => (
              <button key={f} type="button" className="ads-tab" aria-pressed={feed === f} onClick={() => onFeed(f)}>
                {t(f === "discover" ? "ads.discover" : "ads.following")}
              </button>
            ))}
          </div>
          <div className="ads-vsep" aria-hidden="true" />
        </>
      )}
      <div className="ads-cats">
        {MAIN_CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            className="ads-cat"
            aria-pressed={c === "All" ? selected.size === 0 : selected.has(c)}
            onClick={() => onToggle(c)}
          >
            {t(`ads.cat.${c}`)}
          </button>
        ))}
      </div>
      <div className="ads-more">
        <button
          type="button"
          className={`ads-more-btn${extraPicked ? " has-pick" : ""}`}
          aria-label={t("ads.moreCategoriesAria")}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <Sliders />
          {extraPicked && <span className="ads-more-dot" />}
        </button>
        {open && (
          <div className="ads-pop">
            <span className="ads-pop-title">{t("ads.moreCategories")}</span>
            <div className="ads-pop-list">
              {extra.map((c) => (
                <button key={c} type="button" className="ads-cat" aria-pressed={selected.has(c)} onClick={() => onToggle(c)}>
                  {t(`ads.cat.${c}`)}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {trailing}
    </div>
  );
}

/** Scroll reveal, as on /trending: the element gets `data-in` while it is
 *  on screen and loses it once fully off screen, so its reveal plays again
 *  each time it comes back. The hidden state only exists while armed
 *  (`data-rv`, set here), so without JS, without IntersectionObserver or
 *  with reduced motion the content simply shows. */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Already on screen when armed: stay shown (no flash).
    const r = el.getBoundingClientRect();
    if (r.top < window.innerHeight && r.bottom > 0) el.dataset.in = "";
    el.dataset.rv = "";
    const io = new IntersectionObserver(([e]) => {
      if (e.intersectionRatio >= 0.15 || e.intersectionRect.height >= window.innerHeight * 0.15) el.dataset.in = "";
      else if (!e.isIntersecting) delete el.dataset.in;
    }, { threshold: [0, 0.05, 0.15] });
    io.observe(el);
    return () => {
      io.disconnect();
      delete el.dataset.rv;
      delete el.dataset.in;
    };
  }, []);
  return ref;
}

/** Delay for one step of a reveal (the Trending header's timings). */
export const rvDelay = (s: number) => ({ "--d": `${s}s` }) as CSSProperties;

/** One horizontal row with hover chevrons (the design's "group/strip"). */
export function Strip({ children, prevLabel, nextLabel, step = 320, btnTop }: {
  children: ReactNode;
  prevLabel: string;
  nextLabel: string;
  step?: number;
  btnTop?: string;
}) {
  const { isArabic, dir } = useAdsLang();
  const ref = useRef<HTMLDivElement>(null);
  const reveal = useReveal<HTMLDivElement>();
  const scroll = (side: "left" | "right") => ref.current?.scrollBy({ left: side === "left" ? -step : step, behavior: "smooth" });
  const style = btnTop ? { top: btnTop } : undefined;
  return (
    <div ref={reveal} className="ads-strip">
      <button type="button" className="ads-strip-btn is-left" style={style} aria-label={isArabic ? nextLabel : prevLabel} onClick={() => scroll("left")}>
        <ChevronLeft />
      </button>
      <button type="button" className="ads-strip-btn is-right" style={style} aria-label={isArabic ? prevLabel : nextLabel} onClick={() => scroll("right")}>
        <ChevronRight />
      </button>
      <div ref={ref} className="ads-strip-track rv-i" dir={dir}>
        {children}
      </div>
    </div>
  );
}

/** Store logo, or its monogram when the store has no logo. */
export function StoreMark({ store, size, className = "" }: { store: AdsStore; size: number; className?: string }) {
  return (
    <span className={`ads-mono ${className}`} style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.36)) }} aria-hidden="true">
      {store.logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={store.logo} alt="" width={size} height={size} />
      ) : (
        store.monogram
      )}
    </span>
  );
}

/** A display headline sized to run the full width of its column, the way
 *  the Trending page fits STREET EDIT: measured at 100px, then scaled to the
 *  line width (letters are never stretched). Below 640px it breaks into
 *  `mobileLines`, each line sized to the widest. */
export function FitTitle({ id, text, mobileLines }: { id: string; text: string; mobileLines?: string[] }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const size = () => {
      const avail = el.parentElement?.clientWidth ?? 0;
      if (!avail) return;
      el.style.fontSize = "100px";
      const lines = [...el.querySelectorAll<HTMLElement>(".ads-fit-line")].filter((l) => getComputedStyle(l).display !== "none");
      const w = Math.max(...lines.map((l) => l.getBoundingClientRect().width));
      el.style.fontSize = w > 0 ? `${Math.floor(((100 * avail) / w) * 100) / 100}px` : "";
    };
    size();
    const ro = new ResizeObserver(size);
    if (el.parentElement) ro.observe(el.parentElement);
    document.fonts?.ready.then(size).catch(() => undefined);
    return () => ro.disconnect();
  }, [text, mobileLines]);
  // Each word sits in a mask and rises out of it in turn (0.08 s apart).
  const words = (line: string, from: number) => line.split(" ").map((w, k) => (
    <span key={k}>
      {k > 0 && " "}
      <span className="ads-fit-word"><span className="rv-up" style={rvDelay(0.08 * (from + k + 1))}>{w}</span></span>
    </span>
  ));
  const starts = (mobileLines ?? [text]).map((_, k, all) => all.slice(0, k).join(" ").split(" ").filter(Boolean).length);
  return (
    <h2 id={id} ref={ref} className="ads-display-title is-fit" aria-label={text}>
      <span className="ads-fit-line is-desktop" aria-hidden="true">{words(text, 0)}</span>
      {(mobileLines ?? [text]).map((l, k) => (
        <span key={l} className="ads-fit-line is-mobile" aria-hidden="true">{words(l, starts[k])}</span>
      ))}
    </h2>
  );
}
