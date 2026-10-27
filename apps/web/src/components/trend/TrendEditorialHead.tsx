"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef } from "react";
import "./trend-head.css";

// The page's editorial section header (after the "MOVEMENTS" layout): an
// oversized Latin headline across the full width, small labels set round
// it, and a reveal once it scrolls in. Used by every section of /trending
// that opens with a headline, so they all share one design.
//
// fit: size the headline from its real width so it runs edge to edge on one
// line at every width (for a headline shorter than TRENDING PIECES, whose
// CSS size already fills the line).

type Props = {
  id: string;
  words: string[];
  label: string;          // accessible name of the headline
  arTitle: string;
  count: number;
  link: { href: string; label: string; onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void };
  fit?: boolean;
};

export default function TrendEditorialHead({ id, words, label, arTitle, count, link, fit = false }: Props) {
  const ref = useRef<HTMLElement>(null);
  const lineRef = useRef<HTMLHeadingElement>(null);

  // Reveal once, as the header comes into view.
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
    }, { threshold: 0.15 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Fitted headline: measure at a reference size, scale to the line width.
  useLayoutEffect(() => {
    const line = lineRef.current;
    if (!fit || !line) return;
    const size = () => {
      const avail = line.parentElement?.clientWidth ?? 0;
      if (!avail) return;
      line.style.width = "max-content";
      line.style.fontSize = "100px";
      const w = line.getBoundingClientRect().width;
      line.style.width = "";
      line.style.fontSize = w ? `${Math.floor((100 * avail) / w * 100) / 100}px` : "";
    };
    size();
    const ro = new ResizeObserver(size);
    if (line.parentElement) ro.observe(line.parentElement);
    document.fonts?.ready.then(size).catch(() => undefined);
    return () => ro.disconnect();
  }, [fit]);

  return (
    <header ref={ref} className="tp-head">
      <div className="tp-head-top">
        <span className="tp-mask"><span className="tp-label tp-r1">VIA PRESENTS</span></span>
        <span className="tp-mask"><span className="tp-label tp-r1">WINTER 2026</span></span>
      </div>
      <h2 id={id} ref={lineRef} className="tp-headline" data-fit={fit ? "" : undefined} aria-label={label}>
        {words.map((w, i) => (
          <span key={w} className="tp-mask" aria-hidden="true"><span className={i === 0 ? "tp-r2" : "tp-r3"}>{w}</span></span>
        ))}
      </h2>
      <div className="tp-head-foot">
        <span className="tp-mask tp-ar-wrap"><span className="tp-ar-title tp-r4">{arTitle}</span></span>
        <span className="tp-mask tp-count-wrap">
          <span className="tp-count tp-r5"><span>عدد القطع</span><bdi>({String(count).padStart(2, "0")})</bdi></span>
        </span>
        <span className="tp-mask tp-all-wrap">
          <Link href={link.href} className="tp-all tp-r5" onClick={link.onClick}>{link.label} <span aria-hidden="true">↗</span></Link>
        </span>
      </div>
    </header>
  );
}
