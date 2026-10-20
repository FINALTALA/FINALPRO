"use client";

import Image from "next/image";
import Link from "next/link";
import ProductCard from "@/components/ProductCard";
import StoreCircle from "@/components/StoreCircle";
import Footer from "@/components/Footer";
import { EmptyState, ErrorBanner, SkeletonGrid } from "@/components/States";
import { useFetch } from "@/lib/useFetch";
import { CardsPageDto, StoreSummaryDto } from "@/lib/types";
import { BagIcon, CompassIcon, UserIcon } from "@/components/Icons";
import styles from "./home-via.module.css";

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

const FEATURED_CATEGORIES = [
  { key: "women", label: "نساء", image: "/images/home-category-women.webp" },
  { key: "men", label: "رجال", image: "/images/home-category-men.webp" },
  { key: "kids", label: "أطفال", image: "/images/home-category-kids.webp" },
  { key: "accessories", label: "إكسسوارات", image: "/images/category-accessories.png" },
  { key: "watches", label: "ساعات", image: "/images/category-watches.png" },
  { key: "shoes", label: "أحذية", image: "/images/category-shoes.png" },
] as const;

function segmentHref(key: string): string {
  return key === "women" ? "/women" : `/discovery?segment=${key}`;
}

export default function Home() {
  const products = useFetch<CardsPageDto>("/discovery/all?page_size=4");
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
      <section className={styles.hero} aria-labelledby="home-hero-title">
        {/* TODO: replace this existing local image with the approved VIA family
            campaign asset once it is added to public/images. Product cards
            below continue to come from the live API. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={styles.heroImage} src="/images/via-hero.png" alt="" fetchPriority="high" width={1248} height={848} />
        <Image
          className={styles.heroWordmark}
          src="/images/Via_transparent.svg"
          alt=""
          width={800}
          height={379}
          priority
        />
        <div className={styles.heroContent}>
          <div className={styles.heroText}>
            <p className={styles.heroKicker}>✧&nbsp; تسوّق محلي، بخيارات أوضح &nbsp;✧</p>
            <h1 id="home-hero-title" className={styles.heroTitle}>
              <span className={styles.heroTitleLine}>قارني، اختاري،</span><br />
              <span className={styles.heroTitleLine}>واطلبي بثقة.</span>
            </h1>
            <p className={styles.heroCopy}>
              اكتشفي أزياء المتاجر المحلية في مكان واحد، وقارني الأسعار والتفاصيل بسهولة.
            </p>
          </div>
          <div className={styles.heroActions}>
            <Link href="/discovery" className={styles.heroPrimary}>
              ابدئي المقارنة
            </Link>
            <a href="#how-to-compare" className={styles.heroSecondary}>كيف تعمل المقارنة؟</a>
          </div>
        </div>
      </section>

      <div className={`wide-shell ${styles.categoryIntro}`}>
        <div className={`section-heading ${styles.categoryHeading}`}>
          <div><h2>لكل ذوق، عالمه</h2><p>ستة فئات رئيسية، تجربة شراء واحدة ومتنوعة.</p></div>
        </div>
        <section className={styles.categoryCarousel} aria-label="تسوّقي حسب الفئة">
          <div className={styles.categoryTrack}>
            {FEATURED_CATEGORIES.map((category) => (
              <Link
                key={category.key}
                href={segmentHref(category.key)}
                className={styles.categoryCircle}
                aria-label={`استكشفي ${category.label}`}
              >
                <span className={styles.categoryImage}>
                  <Image src={category.image} alt="" fill sizes="(max-width: 760px) 26vw, 150px" />
                </span>
                <span className={styles.categoryLabel}>{category.label}</span>
              </Link>
            ))}
          </div>
        </section>

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

        <div className="section-heading">
          <div><h2>وصل حديثاً</h2><p>مختارات من المتاجر، مع أقل سعر متاح لكل منتج.</p></div>
          <Link href="/discovery" className="button-link">
            عرض الكل
          </Link>
        </div>
        {products.error && <><ErrorBanner message={products.error} /><button className="button button-secondary" onClick={() => window.location.reload()}>إعادة المحاولة</button></>}
        {products.loading && <SkeletonGrid count={4} />}
        {products.data && products.data.items.length === 0 && (
          <EmptyState
            title="لا توجد منتجات متاحة للمقارنة بعد"
            message="ستظهر هنا المنتجات فور نشر المتاجر لعروضها."
          />
        )}
        {products.data && products.data.items.length > 0 && (
          <div className="product-grid">
            {products.data.items.map((card) => (
              <ProductCard key={card.canonical_product_id} card={card} editorial />
            ))}
          </div>
        )}

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
