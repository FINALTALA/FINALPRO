"use client";

import { useEffect, type RefObject } from "react";

// Scroll-triggered reveal for the homepage, in the Trending / Advertising
// pages' manner: a short fade and rise as content scrolls into view, cards
// staggered. One observer for the whole page - the sections' own markup is
// untouched; the targets are found by the selectors below, and new ones
// (Discover More, a tab switch) are picked up as they appear.
//
// - Nothing is hidden until JS has armed the page ([data-motion="on"]).
// - What is already on screen when the page arms stays as it is (no flash);
//   only content met while scrolling, or added later, is animated.
// - prefers-reduced-motion: nothing is armed at all.
// The hero keeps its own motion and is not a target.

const TARGETS = [
  // Section headings (title + subtitle) and the products filter bar.
  "section[aria-labelledby] > header",
  '[aria-labelledby="home-products-title"] [role="toolbar"]',
  // Shop by Category: the gallery as one block (its panels animate on
  // hover themselves, so they are not touched individually).
  '[aria-labelledby="home-categories-title"] > header + div',
  // Cards, staggered: products, stores, How VIA works steps.
  '[aria-labelledby="home-products-title"] ul > li',
  '[aria-labelledby="home-stories-title"] ul > li',
  '[aria-labelledby="home-stores-title"] [class*="track"] > *',
  '[aria-labelledby="home-how-title"] ol > li',
  // Footer: its columns block and its bottom line.
  "footer[aria-label] > div",
].join(",");

const STAGGER_MS = 70;
const MAX_STAGGER = 6;

export function useHomeReveal(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const io = new IntersectionObserver(
      (entries) => {
        // Everything entering together is staggered in reading order.
        const entering = entries
          .filter((e) => e.isIntersecting)
          .map((e) => e.target as HTMLElement)
          .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
        entering.forEach((t, i) => {
          t.style.setProperty("--hr-d", `${Math.min(i, MAX_STAGGER) * STAGGER_MS}ms`);
          t.dataset.hrIn = "";
          io.unobserve(t);
        });
      },
      // Any visible part counts (a store card peeking at the row's edge must
      // not stay blank); the bottom margin makes things rise once they are
      // properly in view.
      { rootMargin: "0px 0px -8% 0px", threshold: 0 },
    );

    // Tracked per run (not by the data attributes), so a re-run of this
    // effect - React's dev double-mount included - picks everything up again.
    const seen = new WeakSet<HTMLElement>();
    let first = true;
    const scan = () => {
      const fresh = Array.from(el.querySelectorAll<HTMLElement>(TARGETS)).filter((t) => !seen.has(t));
      for (const t of fresh) {
        seen.add(t);
        if ("hrIn" in t.dataset) continue; // already revealed by an earlier run
        t.dataset.hr = "";
        if (first) {
          // Already painted on screen: keep it shown.
          const r = t.getBoundingClientRect();
          if (r.top < window.innerHeight && r.bottom > 0) {
            t.dataset.hrIn = "";
            continue;
          }
        }
        io.observe(t);
      }
      first = false;
    };

    scan();
    el.setAttribute("data-motion", "on");

    let frame = 0;
    const mo = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        scan();
      });
    });
    mo.observe(el, { childList: true, subtree: true });

    return () => {
      io.disconnect();
      mo.disconnect();
      if (frame) cancelAnimationFrame(frame);
      el.removeAttribute("data-motion");
    };
  }, [root]);
}
