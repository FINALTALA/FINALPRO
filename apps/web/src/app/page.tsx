"use client";

import Image from "next/image";
import Link from "next/link";
import CollectionShowcase from "@/components/CollectionShowcase";
import promoStyles from "./home-page.module.css";
import HomeHero from "@/components/home-hero/HomeHero";
import HomeSteps from "@/components/home-steps/HomeSteps";
import HomeCategories from "@/components/home-categories/HomeCategories";
import HomeProducts from "@/components/home-products/HomeProducts";
import HomeStories from "@/components/home-stories/HomeStories";
import HomeStores from "@/components/home-stores/HomeStores";
import HomeHowVia from "@/components/home-how-via/HomeHowVia";
import HomeFooter from "@/components/home-footer/HomeFooter";
import { useHomeReveal } from "@/components/home-motion/useHomeReveal";
import "@/components/home-motion/home-motion.css";
import { useRef } from "react";
import styles from "./home-editorial.module.css";

export default function Home() {
  // Scroll-in reveal for every section below the hero (useHomeReveal.ts).
  const root = useRef<HTMLDivElement>(null);
  useHomeReveal(root);

  return (
    <div ref={root} className={`${styles.home} page-shell home-editorial`}>
      <HomeHero />

      {/* How shopping on VIA works: right under the hero. */}
      <HomeSteps />

      {/* id: the hero CTA's scroll target. */}
      <div id="shop-by-category" className={`wide-shell ${styles.categoryIntro}`}>
        <HomeCategories />
        <HomeStories />
        <HomeProducts />

        {/* Static promo banner - placeholder pending a real CMS (FR-CMS-001, Phase 2). */}
        <div className={`${promoStyles.promoFrame} ${promoStyles.trendingPromoFrame}`}>
          <Link href="/trending" className={promoStyles.womenPromo}>
            <div className={promoStyles.womenPromoCopy}>
              <span className={promoStyles.womenPromoEyebrow}>الأكثر رواجًا</span>
              <h2>قطع تخطف الأنظار</h2>
              <p>اكتشفي التصاميم التي تتصدر اختيارات الموسم، حيث تلتقي الأناقة بالتفاصيل المميزة.</p>
              <span className={promoStyles.womenPromoCta}><span aria-hidden="true">←</span> تصفّحي الأكثر رواجًا</span>
            </div>
            <div className={promoStyles.womenPromoFigures} aria-hidden="true">
              <Image src="/images/Joyful Mother and Baby Portrait.png" alt="" fill sizes="(max-width: 760px) 82vw, 430px" />
            </div>
          </Link>
        </div>

        <div className={`${promoStyles.promoFrame} ${promoStyles.salesPromoFrame}`}>
          <Link href="/sales" className={`${promoStyles.womenPromo} ${promoStyles.salesPromo}`}>
            <div className={promoStyles.womenPromoCopy}>
              <span className={promoStyles.womenPromoEyebrow}>تنزيلات الموسم</span>
              <h2>أسعار أخف، اختيارات أجمل</h2>
              <p>اكتشفي التخفيضات من المتاجر المحلية، وقارني الأسعار لتجدي ما يناسبك بسعرٍ أفضل.</p>
              <span className={promoStyles.womenPromoCta}><span aria-hidden="true">←</span> تصفّحي التنزيلات</span>
            </div>
            <div className={promoStyles.womenPromoFigures} aria-hidden="true">
              <Image src="/images/Seated Man in Keffiyeh and Olive Jacket (1).png" alt="" fill sizes="(max-width: 760px) 82vw, 430px" />
            </div>
          </Link>
        </div>

        {/* PD-5b: the platform's live home collections, right after the banners. */}
        <CollectionShowcase placement="HOME" />
        <HomeStores />
        <HomeHowVia />
      </div>

      <HomeFooter />
    </div>
  );
}
