"use client";

import { Amiri, Cairo, Inter_Tight, Playfair_Display, Plus_Jakarta_Sans } from "next/font/google";
import { useEffect, type ReactNode } from "react";
import { useAdsLang } from "./adsCopy";
import "./ads.css";

// Typography of the Advertising page (the AI Studio design), scoped to the
// page through these CSS variables - Via's global fonts are not touched.
//  - Cairo: Arabic text
//  - Amiri: Arabic editorial titles (hero, ad cards) - the serif Via's
//    own editorial headings use, here in its regular weight
//  - Playfair Display: editorial English titles (hero, cards)
//  - Plus Jakarta Sans: English UI text
//  - Inter Tight 900: the large display headings, the same face and options
//    the Trending page uses for TRENDING PIECES (shared files).
const cairo = Cairo({ subsets: ["arabic", "latin"], weight: ["400", "500", "600", "700", "800"], variable: "--ads-font-ar" });
const amiri = Amiri({ subsets: ["arabic", "latin"], weight: ["400", "700"], variable: "--ads-font-ar-serif" });
const playfair = Playfair_Display({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--ads-font-serif" });
const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], variable: "--ads-font-ui" }); // variable font (200-800)
const interTight = Inter_Tight({ subsets: ["latin"], weight: ["600", "900"], variable: "--tp-font-display" });
const ADS_FONT_VARS = [cairo.variable, amiri.variable, playfair.variable, jakarta.variable, interTight.variable].join(" ");

/** The Advertising page root: its own fonts, language and direction. */
export default function AdsPageShell({ children }: { children: ReactNode }) {
  const { lang, dir } = useAdsLang();

  // The site header is fixed over the hero. Past the hero it glides up and
  // fades, the way it does on the home and trend pages (same CSS variable),
  // so it never sits on the sections below. Page-scoped; undone on leave.
  useEffect(() => {
    const header = document.querySelector<HTMLElement>("header");
    const hero = document.querySelector<HTMLElement>(".ads .ah");
    if (!header || !hero) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const end = hero.getBoundingClientRect().top + window.scrollY + hero.offsetHeight;
      const start = end - Math.min(340, hero.offsetHeight * 0.34);
      const p = Math.min(Math.max((window.scrollY - start) / 230, 0), 1);
      header.style.setProperty("--via-home-header-scroll", String(p));
      header.style.pointerEvents = p >= 1 ? "none" : "";
      header.style.visibility = p >= 1 ? "hidden" : "";
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(frame);
      header.style.removeProperty("--via-home-header-scroll");
      header.style.removeProperty("pointer-events");
      header.style.removeProperty("visibility");
    };
  }, []);

  return (
    <div className={`ads ${ADS_FONT_VARS}`} lang={lang} dir={dir}>
      {children}
    </div>
  );
}
