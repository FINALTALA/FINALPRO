"use client";

import Image from "next/image";
import { Cormorant_Garamond, Inter, Noto_Naskh_Arabic } from "next/font/google";
import { registerTranslations } from "@/lib/i18n";
import { useLang, useT } from "@/lib/useLang";
import HomeSectionHead from "@/components/home-section-head/HomeSectionHead";
import { mediaOf, mediaUrl, overlayItems, pickText, useManagedSection } from "@/lib/contentStudio";
import styles from "./home-how-via.module.css";

// How VIA works: three steps, each shown with a real screenshot of VIA
// itself (public/images/how-via, captured from this site on 22 Nov 2026):
//   discover.jpg - the homepage's "Pieces Worth Discovering", All tab;
//   compare.jpg  - a product's price comparison page (/compare/...);
//   follow.jpg   - a storefront's header with its Follow button. Its stats
//                  line was left out of the capture: the storefront API
//                  does not send follower_count yet, so it reads "NaN".

const arDisplay = Noto_Naskh_Arabic({ subsets: ["arabic"], weight: ["400"], variable: "--hv-ar-display" });
const enDisplay = Cormorant_Garamond({ subsets: ["latin"], weight: ["500"], variable: "--hv-en-display", preload: false });
const enText = Inter({ subsets: ["latin"], weight: ["400", "500"], variable: "--hv-en-text" });
const FONT_VARS = [arDisplay.variable, enDisplay.variable, enText.variable].join(" ");

registerTranslations({
  ar: {
    "hv.title": "كيف تعمل VIA؟",
    "hv.subtitle": "ثلاث خطوات بسيطة لتلاقي قطعتك بأفضل سعر.",
    "hv.1.title": "اكتشف المنتجات",
    "hv.1.body": "تصفّح قطعاً من متاجر مختلفة في مكان واحد، وصفِّها حسب الفئة.",
    "hv.1.alt": "لقطة من VIA: شبكة القطع في قسم «قطع تستاهل الاكتشاف» مع تبويباته.",
    "hv.2.title": "قارن الأسعار بين المتاجر",
    "hv.2.body": "شوف عروض القطعة نفسها عند كل متجر: السعر والمقاس والتوفّر.",
    "hv.2.alt": "لقطة من VIA: صفحة مقارنة أسعار قطعة واحدة بين عروض عدة متاجر.",
    "hv.3.title": "تابع متاجرك المفضلة",
    "hv.3.body": "اضغط «متابعة» في صفحة المتجر، وتابع قطعه في «أتابعه».",
    "hv.3.alt": "لقطة من VIA: رأس صفحة متجر مع زر «متابعة».",
  },
  en: {
    "hv.title": "How VIA Works",
    "hv.subtitle": "Three simple steps to find your piece at the best price.",
    "hv.1.title": "Discover products",
    "hv.1.body": "Browse pieces from different stores in one place, and filter them by category.",
    "hv.1.alt": "VIA screenshot: the pieces grid of “Pieces Worth Discovering” with its tabs.",
    "hv.2.title": "Compare prices across stores",
    "hv.2.body": "See every store's offer for the same piece: price, size and availability.",
    "hv.2.alt": "VIA screenshot: one piece's price comparison across several stores' offers.",
    "hv.3.title": "Follow your favourite stores",
    "hv.3.body": "Tap “Follow” on a store's page, and keep up with its pieces in “Following”.",
    "hv.3.alt": "VIA screenshot: a store page header with its Follow button.",
  },
});

export const STEPS = [
  { n: 1, image: { src: "/images/how-via/discover.jpg", width: 1520, height: 1140 }, focus: "100% 0%" },
  { n: 2, image: { src: "/images/how-via/compare.jpg", width: 1420, height: 1066 }, focus: "100% 0%" },
  { n: 3, image: { src: "/images/how-via/follow.jpg", width: 1200, height: 900 }, focus: "0% 0%" },
] as const;

export default function HomeHowVia() {
  const lang = useLang();
  const t = useT();
  // VIA phase 6: the Content Studio may manage this section (same steps).
  const managed = useManagedSection("home.how");
  const builtIn = STEPS.map((s) => ({
    id: `step-${s.n}`,
    src: s.image.src as string,
    focus: s.focus as string,
    alt: t(`hv.${s.n}.alt`),
    title: t(`hv.${s.n}.title`),
    body: t(`hv.${s.n}.body`),
  }));
  const steps = overlayItems(managed, builtIn, (s) => s.id, (base, it) => {
    const src = mediaUrl(it.fields.image, null);
    if (!src) return null;
    return {
      ...base,
      id: it.id,
      src,
      alt: pickText(mediaOf(it.fields.image)?.alt, lang, base.alt),
      title: pickText(it.fields.title, lang, base.title),
      body: pickText(it.fields.text, lang, base.body),
    };
  });
  const heading =
    managed.mode === "managed" ? pickText(managed.section.fields.heading, lang, t("hv.title")) : t("hv.title");
  if (steps.length === 0) return null;
  return (
    <section className={`${styles.root} ${FONT_VARS}`} data-lang={lang} dir={lang === "ar" ? "rtl" : "ltr"} aria-labelledby="home-how-title">
      <HomeSectionHead id="home-how-title" title={heading} aside={t("hv.subtitle")} className={styles.head} />

      <ol className={styles.steps}>
        {steps.map((s, i) => (
          <li key={s.id} className={styles.step}>
            <div className={styles.frame}>
              <span className={styles.chrome} aria-hidden="true"><i /><i /><i /></span>
              <span className={styles.shot}>
                <Image
                  src={s.src}
                  alt={s.alt}
                  fill
                  sizes="(max-width: 899px) 92vw, 440px"
                  style={{ objectPosition: s.focus }}
                  className={styles.img}
                  unoptimized={/^https?:/.test(s.src)}
                />
              </span>
            </div>
            <div className={styles.text}>
              <span className={styles.num} aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
              <h3 className={styles.stepTitle}>{s.title}</h3>
              <p className={styles.body}>{s.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
