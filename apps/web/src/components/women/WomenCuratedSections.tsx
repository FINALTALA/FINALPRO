import Link from "next/link";
import { EmptyState, SkeletonGrid } from "@/components/States";
import ProductCard from "@/components/ProductCard";
import Reveal from "@/components/Reveal";
import { ComparisonCardDto } from "@/lib/types";

export default function WomenCuratedSections({
  loading,
  hasData,
  latestCards,
  discountedCards,
  onShowDiscounts,
}: {
  loading: boolean;
  hasData: boolean;
  latestCards: ComparisonCardDto[];
  discountedCards: ComparisonCardDto[];
  onShowDiscounts: () => void;
}) {
  return (
    <div className="women-curated-grid" id="women-trends">
      <Reveal>
        <section className="women-curated-panel women-discounts" aria-labelledby="women-discounts-title">
          <div className="women-section-heading">
            <div>
              <span className="women-section-kicker">خصومات فعّالة من المتاجر</span>
              <h2 id="women-discounts-title">عروض تستحق الاكتشاف</h2>
              <p>الخصومات المعروضة حسب بيانات الأسعار الحالية من المتاجر.</p>
            </div>
            <button className="women-text-link women-discount-filter-link" type="button" onClick={onShowDiscounts}>
              كل العروض <span aria-hidden="true">←</span>
            </button>
          </div>
          {loading && <SkeletonGrid count={2} />}
          {hasData && !loading && discountedCards.length > 0 && (
            <div className="women-curated-product-grid">
              {discountedCards.slice(0, 2).map((card) => (
                <ProductCard key={card.canonical_product_id} card={card} editorial />
              ))}
            </div>
          )}
          {hasData && !loading && discountedCards.length === 0 && (
            <p className="women-no-discounts">لا توجد خصومات فعّالة معلنة حاليًا.</p>
          )}
        </section>
      </Reveal>

      <Reveal>
        <section className="women-curated-panel women-arrivals" aria-labelledby="women-latest-title">
          <div className="women-section-heading">
            <div>
              <span className="women-section-kicker">أحدث ما وصل للمتاجر</span>
              <h2 id="women-latest-title">وصل حديثًا</h2>
              <p>تصفحي أحدث المنتجات المنشورة في تشكيلة النساء.</p>
            </div>
            <Link href="/discovery?segment=women" className="women-text-link">
              جميع المنتجات <span aria-hidden="true">←</span>
            </Link>
          </div>
          {loading && <SkeletonGrid count={2} />}
          {hasData && !loading && latestCards.length > 0 && (
            <div className="women-curated-product-grid">
              {latestCards.slice(0, 2).map((card) => (
                <ProductCard key={card.canonical_product_id} card={card} editorial />
              ))}
            </div>
          )}
          {hasData && !loading && latestCards.length === 0 && (
            <EmptyState
              title="لا توجد منتجات نسائية متاحة حاليًا"
              message="ستظهر المنتجات هنا عند نشر المتاجر لعروضها."
            />
          )}
        </section>
      </Reveal>
    </div>
  );
}
