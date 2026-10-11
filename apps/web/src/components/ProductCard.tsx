import Link from "next/link";
import SafeImage from "./SafeImage";
import StoreCircle from "./StoreCircle";
import { AVAILABILITY_LABEL, ComparisonCardDto } from "@/lib/types";

const MAX_OPTION_PILLS = 4;
const COLOR_SWATCHES: Record<string, string> = {
  "أبيض": "#ffffff", "ابيض": "#ffffff", white: "#ffffff",
  "أسود": "#1c1416", "اسود": "#1c1416", black: "#1c1416",
  "أزرق": "#47698b", "ازرق": "#47698b", blue: "#47698b",
  "كحلي": "#1f2c3e", navy: "#1f2c3e",
  "وردي": "#e8c8c4", pink: "#e8c8c4",
  "خمري": "#4a1626", "نبيذي": "#4a1626", burgundy: "#4a1626",
  "بيج": "#d7c6ad", beige: "#d7c6ad",
  "بني": "#78533b", brown: "#78533b",
  "رمادي": "#88827f", gray: "#88827f", grey: "#88827f",
  "أخضر": "#50755e", "اخضر": "#50755e", green: "#50755e",
  "أحمر": "#a33437", "احمر": "#a33437", red: "#a33437",
};

// Sprint 13: the global product card used by Home, Discovery, search
// and Following. Every field shown comes from real API data - a card
// with no image shows a neutral "no image" tile, and colours/sizes/
// brand appear only when the product actually has them.
export default function ProductCard({ card, editorial = false }: { card: ComparisonCardDto; editorial?: boolean }) {
  const offerHref = `/store/${card.cheapest_offer.vendor_slug}/products/${card.cheapest_offer.offer_id}`;
  const options = [...card.colors, ...card.sizes];
  const meta = [card.brand_name, card.category_name].filter(Boolean).join(" · ");

  return (
    <article className="product-card" data-testid="product-card">
      <Link href={offerHref} className="product-card-media" aria-label={card.canonical_name_ar}>
        {card.image_url ? (
          <SafeImage src={card.image_url} alt={card.canonical_name_ar} loading="lazy" />
        ) : (
          <span className="product-card-noimage">لا توجد صورة</span>
        )}
      </Link>

      <div className="product-card-body">
        {meta && <div className="product-card-meta">{meta}</div>}
        <Link href={offerHref} className="product-card-name" style={{ textDecoration: "none", color: "inherit" }}>
          {card.canonical_name_ar}
        </Link>

        {!editorial && options.length > 0 && (
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

        {editorial && options.length > 0 && <div className="home-product-options" aria-label="الألوان والمقاسات المتاحة">
          {card.colors.slice(0, 4).map((color) => {
            const swatch = COLOR_SWATCHES[color.trim().toLowerCase()];
            return swatch ? <span key={color} className="home-color-swatch" style={{ backgroundColor: swatch }} role="img" aria-label={`لون ${color}`} title={color} /> : <span key={color} className="option-pill">{color}</span>;
          })}
          {card.colors.length > 4 && <span className="option-pill">+{card.colors.length - 4} ألوان</span>}
          {card.sizes.slice(0, 4).map((size) => <span className="option-pill" key={`size-${size}`}>{size}</span>)}
          {card.sizes.length > 4 && <span className="option-pill">+{card.sizes.length - 4} مقاسات</span>}
        </div>}

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
