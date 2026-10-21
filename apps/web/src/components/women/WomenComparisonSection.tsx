import Link from "next/link";
import Reveal from "@/components/Reveal";
import StoreCircle from "@/components/StoreCircle";
import { ComparisonCardDto } from "@/lib/types";

export default function WomenComparisonSection({ card }: { card: ComparisonCardDto | undefined }) {
  if (!card) return null;

  return (
    <Reveal>
      <section className="women-comparison" aria-labelledby="women-comparison-title">
        <div className="women-comparison-copy">
          <span className="women-section-kicker">المنتج نفسه، عروض متعددة</span>
          <h2 id="women-comparison-title">قارني قبل ما تختاري</h2>
          <p>
            {card.canonical_name_ar} متوفر لدى {card.store_count} محلات.
            شاهدي الأسعار والمقاسات والألوان للعروض المؤهلة.
          </p>
          <Link href={`/compare/${card.canonical_product_id}`} className="button">
            قارني الأسعار
          </Link>
        </div>
        <div className="women-comparison-card">
          {card.image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={card.image_url} alt={card.canonical_name_ar} loading="lazy" />
          ) : (
            <div className="women-comparison-placeholder" aria-hidden="true">Via</div>
          )}
          <div className="women-comparison-details">
            <strong>{card.canonical_name_ar}</strong>
            <span>يبدأ من {card.lowest_price} ₪</span>
            <div className="women-comparison-stores" aria-label="المحلات ذات الأسعار الأقل">
              {card.store_logos.map((item) => (
                <StoreCircle
                  key={item.vendor_id}
                  name={item.display_name}
                  logoUrl={item.logo_url}
                  href={`/store/${item.vendor_slug}/products/${item.offer_id}`}
                  size={36}
                />
              ))}
            </div>
          </div>
        </div>
      </section>
    </Reveal>
  );
}
