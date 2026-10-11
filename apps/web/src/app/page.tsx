"use client";

import Link from "next/link";
import ProductCard from "@/components/ProductCard";
import StoreCircle from "@/components/StoreCircle";
import Footer from "@/components/Footer";
import { EmptyState, ErrorBanner, SkeletonGrid } from "@/components/States";
import { useFetch } from "@/lib/useFetch";
import { CardsPageDto, SEGMENTS, StoreSummaryDto } from "@/lib/types";
import { BagIcon, CompassIcon, UserIcon } from "@/components/Icons";

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

const HOME_SEGMENT_COPY: Record<string, string> = {
  women: "بساطة جميلة",
  men: "أناقة في كل تفصيل",
  kids: "لحظات صغيرة، وفرحة كبيرة",
  accessories: "لمسة أخيرة، إطلالة كاملة",
  watches: "دقة تبدو في كل لحظة",
  shoes: "توازن بين الراحة والهوية",
};

function segmentHref(key: string): string {
  return key === "women" ? "/women" : `/discovery?segment=${key}`;
}

export default function Home() {
  const products = useFetch<CardsPageDto>("/discovery/all?page_size=4");
  const stores = useFetch<{ items: StoreSummaryDto[] }> ("/discovery/stores?limit=12");
  const segments = SEGMENTS.filter((s) => s.key !== "all");
  const featuredStores = stores.data?.items.slice(0, 3) ?? [];

  return (
    <div className="page-shell home-editorial">
      <nav className="home-category-nav" aria-label="تسوّقي حسب الفئة">
        <Link className="home-category-link home-category-link-all" href="/discovery">جميع المنتجات</Link>
        {SEGMENTS.filter((s) => s.key !== "all").map((s) => (
          <Link key={s.key} className={"home-category-link home-category-link-" + s.key} href={segmentHref(s.key)}>
            <span className="home-category-dot" aria-hidden="true" />
            {s.label}
          </Link>
        ))}
      </nav>
      <section className="hero" aria-labelledby="home-hero-title">
        {/* Decorative campaign photography; product photos remain API data. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="home-hero-image" src="/images/home-hero.webp" alt="" fetchPriority="high" width={1248} height={848} />
        <div className="hero-content">
          <span className="home-eyebrow">نساء · رجال · أطفال · إكسسوارات · ساعات · أحذية</span>
          <h1 id="home-hero-title">أناقة أصيلة، تُختار بثقة.</h1>
          <p>
            اكتشفي العبايات والأزياء الراقية من متاجر الضفة المحلية، وقارني
            التصاميم والأسعار لتجدي ما يلائم ذوقكِ بسهولة.
          </p>
          <div className="hero-cta">
            <Link href="/discovery" className="button">
              استكشف المنتجات
            </Link>
            <a href="#how-to-compare" className="button button-secondary">كيف نقارن الأسعار؟</a>
          </div>
        </div>
        <span className="hero-note">صورة ترويجية</span>
      </section>

      <div className="wide-shell">
        <div className="section-heading">
          <div><h2>لكل ذوق، عالمه</h2><p>ستة فئات رئيسية، تجربة شراء واحدة ومتنوعة.</p></div>
        </div>
        <div className="home-segment-grid">
          {segments.map((s) => (
            <Link key={s.key} href={segmentHref(s.key)} className={`segment-tile segment-tile-${s.key}`}>
              <div className={`editorial-photo editorial-photo-${s.key}`} />
              <div className="home-category-caption">
                <div>
                  <span className="segment-tile-label">{s.label}</span>
                  <p>{HOME_SEGMENT_COPY[s.key] ?? "اختيارك يبدأ هنا"}</p>
                </div>
                <span className="button button-secondary">استكشف</span>
              </div>
            </Link>
          ))}
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

        {/* Static promo banner - placeholder pending a real CMS (FR-CMS-001, Phase 2). */}
        <Link href={segmentHref(SEGMENT_PROMOS[0].key)} className="promo-banner promo-banner-women">
          <div className="promo-banner-text">
            <span className="home-eyebrow">تجدد الموسم، أسلوبك</span><h2>حين تكون البساطة أجمل التفاصيل.</h2>
            <p>{SEGMENT_PROMOS[0].body}</p>
            <span className="button">{SEGMENT_PROMOS[0].cta}</span>
          </div><div className="editorial-photo editorial-photo-women" role="img" aria-label="صورة ترويجية لأزياء النساء" />
        </Link>

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
