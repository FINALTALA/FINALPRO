import Link from "next/link";
import StoreCircle from "./StoreCircle";
import { AVAILABILITY_LABEL, ComparisonCardDto } from "@/lib/types";

const MAX_OPTION_PILLS = 4;

// Sprint 13: the global product card used by Home, Discovery, search
// and Following. Every field shown comes from real API data - a card
// with no image shows a neutral "no image" tile, and colours/sizes/
// brand appear only when the product actually has them.
export default function ProductCard({ card }: { card: ComparisonCardDto }) {
  const offerHref = `/store/${card.cheapest_offer.vendor_slug}/products/${card.cheapest_offer.offer_id}`;
  const options = [...card.colors, ...card.sizes];
  const meta = [card.brand_name, card.category_name].filter(Boolean).join(" · ");

  return (
    <article className="product-card" data-testid="product-card">
      <Link href={offerHref} className="product-card-media" aria-label={card.canonical_name_ar}>
        {card.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={card.image_url} alt={card.canonical_name_ar} loading="lazy" />
        ) : (
          <span className="product-card-noimage">لا توجد صورة</span>
        )}
      </Link>

      <div className="product-card-body">
        {meta && <div className="product-card-meta">{meta}</div>}
        <Link href={offerHref} className="product-card-name" style={{ textDecoration: "none", color: "inherit" }}>
          {card.canonical_name_ar}
        </Link>

        {options.length > 0 && (
          <div className="product-card-options" aria-label="الألوان والمقاسات">
            {options.slice(0, MAX_OPTION_PILLS).map((o) => (
              <span key={o} className="option-pill">
                {o}
              </span>
            ))}
            {options.length > MAX_OPTION_PILLS && (
              <span className="option-pill">+{options.length - MAX_OPTION_PILLS}</span>
            )}
          </div>
        )}

        <div className="product-card-price">
          <small>يبدأ من </small>
          {card.lowest_price} ₪
        </div>
        <span className={`availability-badge availability-${card.lowest_price_availability}`}>
          {AVAILABILITY_LABEL[card.lowest_price_availability]}
        </span>

        <div className="product-card-stores">
          <div className="product-card-logos">
            {card.store_logos.map((logo) => (
              <StoreCircle
                key={logo.vendor_id}
                name={logo.display_name}
                logoUrl={logo.logo_url}
                href={`/store/${logo.vendor_slug}/products/${logo.offer_id}`}
                size={30}
              />
            ))}
          </div>
          <span>
            {card.store_count === 1 ? "متجر واحد" : `${card.store_count} متاجر`}
          </span>
        </div>
      </div>

      <div className="product-card-actions">
        <Link
          href={`/compare/${card.canonical_product_id}`}
          className="button button-block button-secondary"
        >
          قارني الأسعار
        </Link>
      </div>
    </article>
  );
}
