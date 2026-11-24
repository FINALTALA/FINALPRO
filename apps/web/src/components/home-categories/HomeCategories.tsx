"use client";

import Image from "next/image";
import Link from "next/link";
import { Cormorant_Garamond, Inter, Noto_Naskh_Arabic } from "next/font/google";
import type { CSSProperties } from "react";
import { registerTranslations } from "@/lib/i18n";
import { useLang, useT } from "@/lib/useLang";
import HomeSectionHead from "@/components/home-section-head/HomeSectionHead";
import styles from "./home-categories.module.css";

// The hero's editorial faces (same next/font settings, so the same files):
// Noto Naskh Arabic and Cormorant Garamond for headings, Inter for labels.
const arDisplay = Noto_Naskh_Arabic({ subsets: ["arabic"], weight: ["400"], variable: "--cat-ar-display" });
const enDisplay = Cormorant_Garamond({ subsets: ["latin"], weight: ["500"], variable: "--cat-en-display", preload: false });
const enText = Inter({ subsets: ["latin"], weight: ["400", "500"], variable: "--cat-en-text" });
const FONT_VARS = [arDisplay.variable, enDisplay.variable, enText.variable].join(" ");

registerTranslations({
  ar: {
    "cats.title": "تسوّق حسب الفئة",
    "cats.women": "نساء",
    "cats.men": "رجال",
    "cats.kids": "أطفال",
    "cats.women.cta": "تسوّقي النساء",
    "cats.men.cta": "تسوّق الرجال",
    "cats.kids.cta": "تسوّق الأطفال",
    "cats.women.alt": "عارضة تبتسم بكنزة زرقاء محبوكة ترفع كمّيها أمام وجهها.",
    "cats.men.alt": "عارض بكنزة بيضاء محبوكة بسحّاب عند الرقبة، يضمّ ذراعيه.",
    "cats.kids.alt": "طفلة بكارديغان صوف كريمي كبير وجوارب طويلة أمام خلفية زرقاء.",
  },
  en: {
    "cats.title": "Shop by Category",
    "cats.women": "Women",
    "cats.men": "Men",
    "cats.kids": "Kids",
    "cats.women.cta": "Shop Women",
    "cats.men.cta": "Shop Men",
    "cats.kids.cta": "Shop Kids",
    "cats.women.alt": "A smiling model in a blue rib-knit sweater, pulling the sleeves up to her face.",
    "cats.men.alt": "A model in a cream half-zip knit sweater with his arms crossed.",
    "cats.kids.alt": "A girl in an oversized cream hand-knit cardigan and tall socks against a blue backdrop.",
  },
});

/**
 * One panel per category, in reading order (Arabic: women on the right).
 * Routes are the site's department pages. `focus` is the object-position per layout (desktop / tablet
 * panels, and the phone's 3:4 card): faces and knitwear stay in frame.
 */
const CATEGORIES = [
  {
    key: "women",
    href: "/women",
    image: { src: "/images/home-categories/women.jpg", width: 735, height: 919 },
    focus: { desktop: "50% 35%", mobile: "50% 35%" },
    mobileSizes: "75vw",
  },
  {
    key: "men",
    href: "/men",
    image: { src: "/images/home-categories/men.jpg", width: 604, height: 821 },
    focus: { desktop: "50% 30%", mobile: "50% 25%" },
    mobileSizes: "75vw",
  },
  {
    key: "kids",
    href: "/kids",
    image: { src: "/images/home-categories/kids.jpg", width: 735, height: 985 },
    focus: { desktop: "50% 30%", mobile: "50% 25%" },
    mobileSizes: "75vw",
  },
] as const;

export default function HomeCategories() {
  const lang = useLang();
  const t = useT();

  return (
    <section className={`${styles.root} ${FONT_VARS}`} data-lang={lang} dir={lang === "ar" ? "rtl" : "ltr"} aria-labelledby="home-categories-title">
      <HomeSectionHead id="home-categories-title" title={t("cats.title")} />

      <div className={styles.gallery}>
        {CATEGORIES.map((c) => (
          <Link
            key={c.key}
            href={c.href}
            className={styles.panel}
            data-key={c.key}
            style={{ "--focus": c.focus.desktop, "--focus-m": c.focus.mobile } as CSSProperties}
          >
            <Image
              src={c.image.src}
              alt={t(`cats.${c.key}.alt`)}
              fill
              sizes={`(max-width: 599px) ${c.mobileSizes}, (max-width: 899px) 34vw, 34vw`}
              quality={90}
              className={styles.image}
            />
            <span className={styles.cta}>{t(`cats.${c.key}.cta`)}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
