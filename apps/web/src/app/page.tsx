"use client";

import Image from "next/image";
import Link from "next/link";
import StoreCircle from "@/components/StoreCircle";
import Footer from "@/components/Footer";
import HomeHero from "@/components/home-hero/HomeHero";
import HomeCategories from "@/components/home-categories/HomeCategories";
import HomeProducts from "@/components/home-products/HomeProducts";
import { EmptyState, ErrorBanner, SkeletonGrid } from "@/components/States";
import { useFetch } from "@/lib/useFetch";
import { StoreSummaryDto } from "@/lib/types";
import { BagIcon, CompassIcon, UserIcon } from "@/components/Icons";
import CollectionShowcase from "@/components/CollectionShowcase";
import styles from "./home-page.module.css";

const INFO_BLOCKS = [
  {
    icon: <UserIcon />,
    title: "تواصل مباشر",
    body: "كل متجر له وسيلة تواصل خارجية واضحة على صفحته (واتساب، إنستغرام، أو فيسبوك).",
  },
  {
    icon: <CompassIcon />,
    title: "الاختيار حسب الفرع",
    body: "عند الطلب، تختارين الفرع الأقرب أو أي فرع آخر متوفر فيه مقاسك.",
  },
  {
    icon: <BagIcon />,
    title: "صفحة خاصة لكل متجر",
    body: "تعرّفي إلى المتجر وتابعي منتجاته، مع توضيح حالة إتاحته.",
  },
];

export default function Home() {
  const stores = useFetch<{ items: StoreSummaryDto[] }> ("/discovery/stores?limit=12");
  const featuredStores = stores.data?.items.slice(0, 3) ?? [];

  return (
    <div className={`${styles.home} page-shell home-editorial`}>
      {/*<nav className="home-category-nav" aria-label="تسوّقي حسب الفئة">
        <Link className="home-category-link home-category-link-all" href="/discovery">جميع المنتجات</Link>
        {SEGMENTS.filter((s) => s.key !== "all").map((s) => (
          <Link key={s.key} className={"home-category-link home-category-link-" + s.key} href={segmentHref(s.key)}>
            <span className="home-category-dot" aria-hidden="true" />
            {s.label}
          </Link>
        ))}
      </nav>*/}  {/*this was a nav in the top for women and men we thought we dont want it but may change our mindes later */}
      <HomeHero />

      {/* id: the hero CTA's scroll target. */}
      <div id="shop-by-category" className={`wide-shell ${styles.categoryIntro}`}>
        <HomeCategories />
        <HomeProducts />

        {/* Static promo banner - placeholder pending a real CMS (FR-CMS-001, Phase 2). */}
        <div className={`${styles.promoFrame} ${styles.trendingPromoFrame}`}>
          <Link href="/trending" className={styles.womenPromo}>
            <div className={styles.womenPromoCopy}>
              <span className={styles.womenPromoEyebrow}>الأكثر رواجًا</span>
              <h2>قطع تخطف الأنظار</h2>
              <p>اكتشفي التصاميم التي تتصدر اختيارات الموسم، حيث تلتقي الأناقة بالتفاصيل المميزة.</p>
              <span className={styles.womenPromoCta}><span aria-hidden="true">←</span> تصفّحي الأكثر رواجًا</span>
            </div>
            <div className={styles.womenPromoFigures} aria-hidden="true">
              <Image src="/images/Joyful Mother and Baby Portrait.png" alt="" fill sizes="(max-width: 760px) 82vw, 430px" />
            </div>
          </Link>
        </div>

        <div className={`${styles.promoFrame} ${styles.salesPromoFrame}`}>
          <Link href="/sales" className={`${styles.womenPromo} ${styles.salesPromo}`}>
            <div className={styles.womenPromoCopy}>
              <span className={styles.womenPromoEyebrow}>تنزيلات الموسم</span>
              <h2>أسعار أخف، اختيارات أجمل</h2>
              <p>اكتشفي التخفيضات من المتاجر المحلية، وقارني الأسعار لتجدي ما يناسبك بسعرٍ أفضل.</p>
              <span className={styles.womenPromoCta}><span aria-hidden="true">←</span> تصفّحي التنزيلات</span>
            </div>
            <div className={styles.womenPromoFigures} aria-hidden="true">
              <Image src="/images/Seated Man in Keffiyeh and Olive Jacket (1).png" alt="" fill sizes="(max-width: 760px) 82vw, 430px" />
            </div>
          </Link>
        </div>

        {/* PD-5b: the platform's live home collections, right after the banners. */}
        <CollectionShowcase placement="HOME" />

        <div className="info-row">
          {INFO_BLOCKS.map((b) => (
            <div key={b.title} className="info-block">
              <span className="home-info-icon">{b.icon}</span>
              <strong>{b.title}</strong>
              <p>{b.body}</p>
            </div>
          ))}
        </div>

        {stores.loading && <SkeletonGrid count={3} />}
        {stores.error && <><ErrorBanner message={stores.error} /><button className="button button-secondary" onClick={() => window.location.reload()}>إعادة المحاولة</button></>}
        {stores.data && featuredStores.length === 0 && <EmptyState title="لا توجد متاجر متاحة حاليًا" message="عودي لاحقًا لاكتشاف المتاجر المنشورة." />}
        {featuredStores.length > 0 && (
          <>
            <div className="section-heading">
              <h2>تعرّف إلى المتاجر</h2>
              <Link href="/discovery" className="button-link">
                كل المتاجر
              </Link>
            </div>
            <div className="store-feature-grid">
              {featuredStores.map((s) => (
                <Link key={s.slug} href={`/store/${s.slug}`} className="store-feature-card">
                  <StoreCircle name={s.display_name} logoUrl={s.logo_url} size={64} />
                  <strong>{s.display_name}</strong>
                  <p>{s.bio ? s.bio.slice(0, 70) : "متجر على المنصّة"}</p>
                  <span className="button-link">زيارة المتجر</span>
                </Link>
              ))}
            </div>
          </>
        )}

      </div>

      <Footer />
    </div>
  );
}
