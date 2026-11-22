"use client";

import { Amiri, Cairo, Inter_Tight, Playfair_Display, Plus_Jakarta_Sans } from "next/font/google";
import type { ReactNode } from "react";
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

  // The site header (AppShell) stays fixed over the hero and turns into a
  // light sticky bar on scroll - nothing page-specific to do here.
  return (
    <div className={`ads ${ADS_FONT_VARS}`} lang={lang} dir={dir}>
      {children}
    </div>
  );
}
