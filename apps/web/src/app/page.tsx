"use client";

import Link from "next/link";
import ProductCard from "@/components/ProductCard";
import { EmptyState, ErrorBanner, SkeletonGrid } from "@/components/States";
import { useFetch } from "@/lib/useFetch";
import { CardsPageDto, SEGMENTS, StoreSummaryDto } from "@/lib/types";

// Sprint 13: the home page. Everything below the hero is real API
// data (GET /discovery/all and /discovery/stores) - nothing invented.
// The hero image is the approved demo banner, used only as a banner.
export default function Home() {
  const products = useFetch<CardsPageDto>("/discovery/all?page_size=10");
  const stores = useFetch<{ items: StoreSummaryDto[] }>("/discovery/stores?limit=12");

  return (
    <div className="page-shell">
      <section className="hero" aria-label="مقارنة الأسعار">
        <div className="hero-content">
          <h1>اكتشفي المنتج، وقارني الأسعار بين المتاجر</h1>
          <p>
            كل المتاجر المحلية في مكان واحد: شاهدي أقل سعر وعدد المتاجر التي
            تبيع المنتج، ثم اشتري من المتجر الأنسب لك.
          </p>
          <div className="hero-cta">
            <Link href="/discovery" className="button">
              اكتشفي المنتجات
            </Link>
            <Link href="/discovery" className="button button-secondary">
              قارني الأسعار
            </Link>
          </div>
        </div>
        <span className="hero-note">صورة تجريبية للعرض فقط</span>
      </section>

      <div className="category-strip" style={{ marginTop: 18 }} aria-label="الفئات">
        {SEGMENTS.map((s) => (
          <Link
            key={s.key}
            href={s.key === "all" ? "/discovery" : `/discovery?segment=${s.key}`}
            className="category-chip"
          >
            {s.label}
          </Link>
        ))}
      </div>

      <div className="wide-shell">
        <div className="section-heading">
          <h2>وصل حديثاً</h2>
          <Link href="/discovery" className="button-link">
            عرض الكل
          </Link>
        </div>
        {products.error && <ErrorBanner message={products.error} />}
        {products.loading && <SkeletonGrid count={5} />}
        {products.data && products.data.items.length === 0 && (
          <EmptyState
            title="لا توجد منتجات متاحة للمقارنة بعد"
            message="ستظهر هنا المنتجات فور نشر المتاجر لعروضها."
          />
        )}
        {products.data && products.data.items.length > 0 && (
          <div className="product-grid">
            {products.data.items.map((card) => (
              <ProductCard key={card.canonical_product_id} card={card} />
            ))}
          </div>
        )}

        {stores.data && stores.data.items.length > 0 && (
          <>
            <div className="section-heading">
              <h2>متاجر على المنصّة</h2>
            </div>
            <div className="follow-strip">
              {stores.data.items.map((s) => (
                <Link key={s.slug} href={`/store/${s.slug}`} className="follow-item">
                  <div className="follow-item-circle">
                    {s.logo_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={s.logo_url} alt={s.display_name} />
                    ) : (
                      <span>{s.display_name.slice(0, 1)}</span>
                    )}
                  </div>
                  <span>{s.display_name}</span>
                </Link>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
