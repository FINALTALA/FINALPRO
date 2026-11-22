"use client";

import Image from "next/image";
import Link from "next/link";
import { Cormorant_Garamond, Inter, Noto_Naskh_Arabic } from "next/font/google";
import type { CSSProperties } from "react";
import { registerTranslations } from "@/lib/i18n";
import { useLang, useT } from "@/lib/useLang";
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
    "cats.women.alt": "عارضة بقميص أبيض وبنطال أبيض واسع في استوديو رمادي فاتح.",
    "cats.men.alt": "عارض بقميص كريمي قصير الأكمام وبنطال كريمي ونظارة شمسية وصندل.",
    "cats.kids.alt": "طفلة بقميص أبيض وجينز أزرق واسع وحذاء رياضي أبيض.",
  },
  en: {
    "cats.title": "Shop by Category",
    "cats.women": "Women",
    "cats.men": "Men",
    "cats.kids": "Kids",
    "cats.women.alt": "A model in a white shirt and wide white trousers in a light grey studio.",
    "cats.men.alt": "A model in a cream short-sleeve shirt, cream trousers, sunglasses and sandals.",
    "cats.kids.alt": "A girl in a white shirt, wide blue jeans and white sneakers.",
  },
});

/**
 * One panel per category, in reading order (Arabic: women on the right).
 * Routes are the site's own department pages - /women, /men and /kids, as
 * the header links them. Framing is per photo: `focus` is the object-position; `zoom` (kids
 * only) brings in a subject who stands low in a tall, mostly empty frame.
 * `wide` is the framing once a panel expands (wider than tall): it keeps
 * the face in view where the resting crop would cut it.
 */
const CATEGORIES = [
  {
    key: "women",
    href: "/women",
    image: { src: "/images/women.png", width: 1050, height: 1400 },
    focus: { desktop: "50% 18%", mobile: "50% 16%", wide: "50% 16%" },
    // Phones: the tall panel, cover-scaled to its height (~0.84 of the screen wide).
    mobileSizes: "85vw",
    zoom: 1,
    zoomWide: 1,
    zoomOrigin: "50% 50%",
  },
  {
    key: "men",
    href: "/men",
    image: { src: "/images/men.png", width: 1024, height: 1536 },
    // He spans ~7.5% (hair) to ~92.5% (sandals) of the photo's height:
    // centred framing keeps head and feet in the card.
    focus: { desktop: "50% 46%", mobile: "50% 40%", wide: "50% 46%" },
    mobileSizes: "50vw",
    zoom: 1,
    zoomWide: 1,
    zoomOrigin: "50% 50%",
  },
  {
    key: "kids",
    href: "/kids",
    image: { src: "/images/kids.png", width: 1199, height: 1596 },
    // She stands from ~25% to ~96% down, slightly right of centre.
    focus: { desktop: "52% 78%", mobile: "54% 64%", wide: "52% 36%" },
    // Half the screen, enlarged by the zoom.
    mobileSizes: "60vw",
    zoom: 1.18,
    zoomWide: 1,
    zoomOrigin: "52% 70%",
  },
] as const;

export default function HomeCategories() {
  const lang = useLang();
  const t = useT();

  return (
    <section className={`${styles.root} ${FONT_VARS}`} data-lang={lang} dir={lang === "ar" ? "rtl" : "ltr"} aria-labelledby="home-categories-title">
      <header className={styles.head}>
        <h2 id="home-categories-title" className={styles.title}>{t("cats.title")}</h2>
      </header>

      <div className={styles.gallery}>
        {CATEGORIES.map((c) => (
          <Link
            key={c.key}
            href={c.href}
            className={styles.panel}
            data-key={c.key}
            style={{
              "--focus": c.focus.desktop,
              "--focus-m": c.focus.mobile,
              "--focus-wide": c.focus.wide,
              "--zoom-wide": c.zoomWide,
              "--zoom": c.zoom,
              "--zoom-origin": c.zoomOrigin,
            } as CSSProperties}
          >
            <Image
              src={c.image.src}
              alt={t(`cats.${c.key}.alt`)}
              fill
              // Desktop: widest when expanded (~58% of a 1240px row).
              sizes={`(max-width: 899px) ${c.mobileSizes}, 720px`}
              quality={90}
              className={styles.image}
            />
            <span className={styles.caption}>
              <span className={styles.name}>{t(`cats.${c.key}`)}</span>
              <svg className={styles.arrow} viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
