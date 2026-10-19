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

// Home-page v2 (visual refresh over the Sprint 13 home). Everything
// under the hero that looks like a real product/store is still real
// API data - nothing invented. Three sections are explicitly static,
// decorative placeholders pending a real CMS (out of FYP scope, see
// docs/approved-product-decisions-2026-09.md §6, FR-CMS-001): the
// three segment-promo banners and the "how comparison works" example
// card below, which uses generic placeholder store names and is
// labelled as an example rather than presented as real data.
const SEGMENT_PROMOS: {
  key: string;
  title: string;
  body: string;
  cta: string;
}[] = [
  {
    key: "women",
    title: "تشكيلة النساء",
    body: "فساتين وعبايات وبلوزات من متاجر محلية متعددة، مع أسعار واضحة للمقارنة.",
    cta: "تصفّحي تشكيلة النساء",
  },
  {
    key: "accessories",
    title: "لمسة أخيرة",
    body: "شنط وإكسسوارات تكمل إطلالتك، قارني أسعارها بين المتاجر قبل ما تختاري.",
    cta: "اكتشفي الإكسسوارات",
  },
  {
    key: "kids",
    title: "عالم الأطفال",
    body: "ملابس ومستلزمات للأطفال من متاجر موثوقة على المنصّة.",
    cta: "تصفّحي تشكيلة الأطفال",
  },
];

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
        <Link href={segmentHref(SEGMENT_PROMOS[0].key)} className={styles.womenPromo}>
          <div className={styles.womenPromoCopy}>
            <span className={styles.womenPromoEyebrow}>أناقة تُحكى</span>
            <h2>لكِ ولصغيركِ، إطلالة من القلب.</h2>
            <p>اختاري قطعًا محلية تجمع الراحة والجمال، وقارني الأسعار بكل وضوح.</p>
            <span className={styles.womenPromoCta}>تصفّحي تشكيلة النساء</span>
          </div>
          <div className={styles.womenPromoFigures} aria-hidden="true">
            <Image src="/images/via_woman_child_transparent.svg" alt="" fill sizes="(max-width: 760px) 82vw, 430px" />
          </div>
        </Link>

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

        {/* Static promo banner - placeholder pending a real CMS (FR-CMS-001, Phase 2). */}
        <Link href={`/discovery?segment=${SEGMENT_PROMOS[1].key}`} className="promo-banner promo-banner-accessories">
          <div className="promo-banner-text">
            <h2>لمسة أخيرة، فرق جميل.</h2>
            <p>{SEGMENT_PROMOS[1].body}</p>
            <span className="button">{SEGMENT_PROMOS[1].cta}</span>
          </div><div className="editorial-photo editorial-photo-accessories" role="img" aria-label="صورة ترويجية للإكسسوارات" />
        </Link>

        {/* Illustrative example only - generic placeholder names, not real stores/prices. */}
        <section id="how-to-compare" className="home-comparison"><div className="home-comparison-copy"><span className="home-eyebrow">قارني نفس المنتج، مع نفس الاختيار</span><h2>الأسلوب لك، والسعر أمامك بوضوح.</h2><p>حددي اللون والمقاس للمقارنة بين عروض المنتج نفسه. راجعي السعر والتوفر والفرع قبل اختيار المتجر المناسب.</p><Link href="/discovery" className="button">جرّبي مقارنة الأسعار</Link></div><div className="compare-example">
          <span className="compare-example-tag">مثال توضيحي · أسعار غير فعلية</span>
          <h3>نفس المنتج · نفس اللون · مقاس M</h3>
          <div className="compare-example-row">
            <span className="home-example-avatar home-example-avatar-a" aria-hidden="true">أ</span><span>متجر أ</span>
            <strong>240 ₪</strong>
            <span className="badge badge-active">الأقل سعراً</span>
          </div>
          <div className="compare-example-row">
            <span className="home-example-avatar home-example-avatar-b" aria-hidden="true">ب</span><span>متجر ب</span>
            <strong>255 ₪</strong>
          </div>
          <div className="compare-example-row">
            <span className="home-example-avatar home-example-avatar-c" aria-hidden="true">ج</span><span>متجر ج</span>
            <strong>270 ₪</strong>
          </div>
          <Link href="/discovery" className="button button-block">
            جرّبي مقارنة حقيقية
          </Link>
        </div></section>

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

        <div className="info-row">
          {INFO_BLOCKS.map((b) => (
            <div key={b.title} className="info-block">
              <span className="home-info-icon">{b.icon}</span>
              <strong>{b.title}</strong>
              <p>{b.body}</p>
            </div>
          ))}
        </div>

        {/* Static promo banner - placeholder pending a real CMS (FR-CMS-001, Phase 2). */}
        <Link href={`/discovery?segment=${SEGMENT_PROMOS[2].key}`} className="promo-banner promo-banner-kids">
          <div className="promo-banner-text">
            <h2>راحة صغيرة، فرحة كبيرة</h2>
            <p>{SEGMENT_PROMOS[2].body}</p>
            <span className="button">{SEGMENT_PROMOS[2].cta}</span>
          </div><div className="editorial-photo editorial-photo-kids" role="img" aria-label="صورة ترويجية لأزياء الأطفال" />
        </Link>
      </div>

      <Footer />
    </div>
  );
}
