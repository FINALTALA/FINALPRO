"use client";

import Image from "next/image";
import { Cormorant_Garamond, Inter, Noto_Naskh_Arabic } from "next/font/google";
import { useRef } from "react";
import { registerTranslations } from "@/lib/i18n";
import { useLang, useT } from "@/lib/useLang";
import { HOME_STORIES, type HomeStory } from "./storyData";
import HomeSectionHead from "@/components/home-section-head/HomeSectionHead";
import styles from "./home-stories.module.css";

// VIA STORIES: an editorial row of six portrait images, each captioned
// below with a small category label and a headline - a magazine's "top
// stories", not a product grid. Square corners, no shadows, no overlays.

// The hero's editorial faces (same next/font settings, so the same files).
const arDisplay = Noto_Naskh_Arabic({ subsets: ["arabic"], weight: ["400"], variable: "--hst-ar-display" });
const enDisplay = Cormorant_Garamond({ subsets: ["latin"], weight: ["500"], variable: "--hst-en-display", preload: false });
const enText = Inter({ subsets: ["latin"], weight: ["400", "500"], variable: "--hst-en-text" });
const FONT_VARS = [arDisplay.variable, enDisplay.variable, enText.variable].join(" ");

registerTranslations({
  ar: {
    "hst.title": "قصص VIA",
    "hst.denim.cat": "دنيم",
    "hst.denim.title": "٥ أساليب دنيم تستحق الاكتشاف",
    "hst.bags.cat": "إكسسوارات",
    "hst.bags.title": "حقائب تستحق نظرة أقرب",
    "hst.shoes.cat": "أحذية",
    "hst.shoes.title": "أحذية تستحق الاكتشاف",
    "hst.new.cat": "وصل حديثاً",
    "hst.new.title": "اكتشفي الجديد في VIA",
    "hst.essentials.cat": "أناقة كل يوم",
    "hst.essentials.title": "قطع يومية ستحبينها",
    "hst.loved.cat": "الأكثر إعجابًا",
    "hst.loved.title": "الأكثر رواجًا بين متسوقي VIA",
    "hst.prev": "القصص السابقة",
    "hst.next": "القصص التالية",
  },
  en: {
    "hst.title": "VIA Stories",
    "hst.denim.cat": "Denim",
    "hst.denim.title": "5 Denim Styles Worth Discovering",
    "hst.bags.cat": "Accessories",
    "hst.bags.title": "Bags That Deserve a Closer Look",
    "hst.shoes.cat": "Footwear",
    "hst.shoes.title": "Shoes Worth Discovering",
    "hst.new.cat": "New Arrivals",
    "hst.new.title": "Discover What's New at VIA",
    "hst.essentials.cat": "Everyday Style",
    "hst.essentials.title": "Everyday Pieces You'll Love",
    "hst.loved.cat": "Most Loved",
    "hst.loved.title": "Trending Among VIA Shoppers",
    "hst.prev": "Previous stories",
    "hst.next": "Next stories",
  },
});

function StoryCard({ story }: { story: HomeStory }) {
  const t = useT();
  return (
    <li className={styles.card}>
      <article>
        <span className={styles.media}>
          <Image
            src={story.image.src}
            alt=""
            fill
            sizes="(max-width: 599px) 50vw, (max-width: 899px) 32vw, (max-width: 1279px) 24vw, 20vw"
            style={{ objectPosition: story.focus }}
            className={styles.img}
          />
        </span>
        <div className={styles.caption}>
          <p className={styles.cat}>{t(`${story.key}.cat`)}</p>
          <h3 className={styles.headline}>{t(`${story.key}.title`)}</h3>
        </div>
      </article>
    </li>
  );
}

export default function HomeStories() {
  const lang = useLang();
  const t = useT();
  const track = useRef<HTMLUListElement>(null);
  // Scroll by one card (+ its 4px gap); in RTL the track scrolls in negative x.
  const step = (dir: 1 | -1) => {
    const el = track.current;
    if (!el) return;
    const card = el.firstElementChild as HTMLElement | null;
    el.scrollBy({ left: dir * ((card?.offsetWidth ?? 260) + 4) * (lang === "ar" ? -1 : 1), behavior: "smooth" });
  };

  if (HOME_STORIES.length === 0) return null;
  return (
    <section
      className={`${styles.root} ${FONT_VARS}`}
      data-lang={lang}
      dir={lang === "ar" ? "rtl" : "ltr"}
      aria-labelledby="home-stories-title"
    >
      <HomeSectionHead id="home-stories-title" title={t("hst.title")} />
      <div className={styles.strip}>
        <button type="button" className={`${styles.nav} ${styles.navPrev}`} onClick={() => step(-1)} aria-label={t("hst.prev")}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>
        </button>
        <ul ref={track} className={styles.track}>
          {HOME_STORIES.map((s) => <StoryCard key={s.id} story={s} />)}
        </ul>
        <button type="button" className={`${styles.nav} ${styles.navNext}`} onClick={() => step(1)} aria-label={t("hst.next")}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        </button>
      </div>
    </section>
  );
}
