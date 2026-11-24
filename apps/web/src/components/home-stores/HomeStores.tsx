"use client";

import Image from "next/image";
import Link from "next/link";
import { Cormorant_Garamond, Inter, Noto_Naskh_Arabic } from "next/font/google";
import type { CSSProperties, ReactNode } from "react";
import { useRef } from "react";
import { registerTranslations } from "@/lib/i18n";
import { useLang, useT } from "@/lib/useLang";
import { HOME_STORES, type HomeStore } from "./storeData";
import { EmptyState, ErrorBanner, SkeletonGrid } from "@/components/States";
import type { StoreSummaryDto } from "@/lib/types";
import { useFetch } from "@/lib/useFetch";
import HomeSectionHead from "@/components/home-section-head/HomeSectionHead";
import styles from "./home-stores.module.css";

// Browse Stores: the store cards of the advertising page's Discover Stores
// strip (cover, monogram + name, categories, "Browse store"), adapted to
// the homepage - one scrolling row, no "sponsored" badge.

// The hero's editorial faces (same next/font settings, so the same files).
const arDisplay = Noto_Naskh_Arabic({ subsets: ["arabic"], weight: ["400"], variable: "--hs-ar-display" });
const enDisplay = Cormorant_Garamond({ subsets: ["latin"], weight: ["500"], variable: "--hs-en-display", preload: false });
const enText = Inter({ subsets: ["latin"], weight: ["400", "500"], variable: "--hs-en-text" });
const FONT_VARS = [arDisplay.variable, enDisplay.variable, enText.variable].join(" ");

registerTranslations({
  ar: {
    "hs.title": "تصفح المتاجر",
    "hs.subtitle": "متاجر مختلفة، كل واحد بأسلوبه.",
    "hs.browse": "تصفح المتجر",
    "hs.soon": "صفحة المتجر قريباً",
    "hs.card": "متجر {name}",
    "hs.prev": "المتاجر السابقة",
    "hs.next": "المتاجر التالية",
  },
  en: {
    "hs.title": "Browse Stores",
    "hs.subtitle": "Different stores, each with its own style.",
    "hs.browse": "Browse store",
    "hs.soon": "Store page coming soon",
    "hs.card": "{name} store",
    "hs.empty": "No published stores yet",
    "hs.prev": "Previous stores",
    "hs.next": "Next stores",
  },
});

const Arrow = ({ flip }: { flip?: boolean }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" style={flip ? { transform: "scaleX(-1)" } : undefined}>
    <path d="M7 17 17 7M9 7h8v8" />
  </svg>
);

function StoreCard({ store }: { store: HomeStore }) {
  const lang = useLang();
  const t = useT();
  const label = t("hs.card").replace("{name}", store.name);
  const body: ReactNode = (
    <>
      <span className={styles.cover}>
        <Image
          src={store.image.src}
          alt=""
          fill
          sizes="(max-width: 599px) 62vw, (max-width: 1099px) 32vw, 280px"
          style={{ objectPosition: store.focus }}
          className={styles.coverImg}
        />
        <span className={styles.shade} aria-hidden="true" />
      </span>
      <span className={styles.id}>
        <span className={styles.nameRow}>
          <span className={styles.mono} aria-hidden="true">{store.name.slice(0, 1)}</span>
          <span className={styles.name} dir="ltr">{store.name}</span>
        </span>
        <span className={styles.cats}>{store.categories[lang].join(" • ")}</span>
        <span className={styles.browse} data-unavailable={store.slug ? undefined : "true"} title={store.slug ? undefined : t("hs.soon")}>
          <span>{t("hs.browse")}</span>
          <Arrow flip={lang === "ar"} />
        </span>
      </span>
    </>
  );
  return store.slug ? (
    <Link href={`/store/${store.slug}`} className={styles.card} aria-label={label}>{body}</Link>
  ) : (
    <article className={`${styles.card} ${styles.static}`} aria-label={label}>{body}</article>
  );
}

export default function HomeStores() {
  const lang = useLang();
  const t = useT();
  const track = useRef<HTMLDivElement>(null);
  // Scroll by about one card; in RTL the track scrolls in negative x.
  const step = (dir: 1 | -1) => {
    const el = track.current;
    if (!el) return;
    const card = el.firstElementChild as HTMLElement | null;
    const by = (card?.offsetWidth ?? 260) + 4;
    el.scrollBy({ left: dir * by * (lang === "ar" ? -1 : 1), behavior: "smooth" });
  };

  const stores = useFetch<{ items: StoreSummaryDto[] }>("/discovery/stores?limit=12");
  const liveStores = stores.data?.items ?? [];
  const cardCount = liveStores.length + HOME_STORES.length;
  return (
    <section className={`${styles.root} ${FONT_VARS}`} data-lang={lang} dir={lang === "ar" ? "rtl" : "ltr"} aria-labelledby="home-stores-title">
      <HomeSectionHead id="home-stores-title" title={t("hs.title")} aside={t("hs.subtitle")} />

      {stores.loading && <SkeletonGrid count={3} />}
      {stores.error && <ErrorBanner message={stores.error} />}
      {stores.data && liveStores.length === 0 && <EmptyState title={t("hs.empty")} />}
      <div className={styles.strip}>
        <button type="button" className={`${styles.nav} ${styles.navPrev}`} onClick={() => step(-1)} aria-label={t("hs.prev")}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>
        </button>
        <div ref={track} className={styles.track} style={{ "--count": cardCount } as CSSProperties}>
          {liveStores.map((store) => (
            <Link key={store.slug} href={`/store/${store.slug}`} className={styles.card}>
              <span className={`${styles.cover} ${styles.liveCover}`} aria-hidden="true">
                <span className={styles.mono}>{store.display_name.slice(0, 1)}</span>
              </span>
              <span className={styles.id}>
                <span className={styles.name}>{store.display_name}</span>
                {store.bio && <span className={styles.cats}>{store.bio.slice(0, 70)}</span>}
                <span className={styles.browse}>
                  <span>{t("hs.browse")}</span>
                  <Arrow flip={lang === "ar"} />
                </span>
              </span>
            </Link>
          ))}
          {HOME_STORES.map((s) => <StoreCard key={s.id} store={s} />)}
        </div>
        <button type="button" className={`${styles.nav} ${styles.navNext}`} onClick={() => step(1)} aria-label={t("hs.next")}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        </button>
      </div>
    </section>
  );
}
