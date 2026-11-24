"use client";

import { Cormorant_Garamond, Inter, Noto_Naskh_Arabic } from "next/font/google";
import type { ReactNode } from "react";
import { registerTranslations } from "@/lib/i18n";
import { useLang, useT } from "@/lib/useLang";
import styles from "./home-steps.module.css";

// How shopping on VIA works, in four quiet steps right under the hero: a
// numbered ring on one thin gold line, a small line icon, a short title and
// a line of explanation. No heading, no cards - an editorial strip.

// The homepage's faces (same next/font settings as the other sections, so
// the same files).
const arDisplay = Noto_Naskh_Arabic({ subsets: ["arabic"], weight: ["400"], variable: "--hsp-ar-display" });
const enDisplay = Cormorant_Garamond({ subsets: ["latin"], weight: ["500"], variable: "--hsp-en-display", preload: false });
const enText = Inter({ subsets: ["latin"], weight: ["400", "500"], variable: "--hsp-en-text" });
const FONT_VARS = [arDisplay.variable, enDisplay.variable, enText.variable].join(" ");

registerTranslations({
  ar: {
    "hsp.label": "خطوات التسوق في VIA",
    "hsp.1.title": "اكتشفي القطعة",
    "hsp.1.text": "تصفحي منتجات من متاجر متعددة في مكان واحد.",
    "hsp.2.title": "قارني بين المتاجر",
    "hsp.2.text": "شاهدي الأسعار والعروض المتاحة للقطعة.",
    "hsp.3.title": "اختاري الأنسب لك",
    "hsp.3.text": "اختاري المنتج والعرض الذي يناسبك.",
    "hsp.4.title": "أكملي التسوق",
    "hsp.4.text": "انتقلي لإتمام عملية الشراء بسهولة.",
  },
  en: {
    "hsp.label": "How shopping on VIA works",
    "hsp.1.title": "Discover the piece",
    "hsp.1.text": "Browse products from many stores in one place.",
    "hsp.2.title": "Compare the stores",
    "hsp.2.text": "See the prices and offers available for the piece.",
    "hsp.3.title": "Choose what suits you",
    "hsp.3.text": "Pick the product and the offer that fit you best.",
    "hsp.4.title": "Complete your order",
    "hsp.4.text": "Go on to finish your purchase with ease.",
  },
});

// Small line icons (24px grid, stroke only, currentColor).
const ICONS: ReactNode[] = [
  // Discover: a magnifier.
  <svg key="1" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 5 5" /></svg>,
  // Compare: two price tags side by side.
  <svg key="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 8.5v-4h4l6 6-4 4-6-6Z" /><circle cx="6" cy="7" r=".9" /><path d="M11 4.5h2.5l6 6-4 4" /></svg>,
  // Choose: a check in a circle.
  <svg key="3" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="m8.5 12.2 2.4 2.4 4.6-4.8" /></svg>,
  // Complete: a shopping bag.
  <svg key="4" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14l-1 12H6L5 8Z" /><path d="M9 10V7a3 3 0 0 1 6 0v3" /></svg>,
];

export default function HomeSteps() {
  const lang = useLang();
  const t = useT();
  return (
    <section
      className={`${styles.root} ${FONT_VARS} wide-shell`}
      data-lang={lang}
      dir={lang === "ar" ? "rtl" : "ltr"}
      aria-label={t("hsp.label")}
    >
      <ol className={styles.steps}>
        {[1, 2, 3, 4].map((n, i) => (
          <li key={n} className={styles.step}>
            <span className={styles.num} aria-hidden="true">{String(n).padStart(2, "0")}</span>
            <div className={styles.body}>
              <span className={styles.icon}>{ICONS[i]}</span>
              <h3 className={styles.title}>{t(`hsp.${n}.title`)}</h3>
              <p className={styles.text}>{t(`hsp.${n}.text`)}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
