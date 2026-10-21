import Link from "next/link";
import SafeImage from "./SafeImage";
import StoreCircle from "./StoreCircle";
import { AVAILABILITY_LABEL, ComparisonCardDto } from "@/lib/types";
import { swatchFor } from "@/lib/colors";

const MAX_OPTION_PILLS = 4;

// Sprint 13: the global product card used by Home, Discovery, search
// and Following. Every field shown comes from real API data - a card
// with no image shows a neutral "no image" tile, and colours/sizes/
// brand appear only when the product actually has them.
interface ProductCardProps {
  card: ComparisonCardDto;
  editorial?: boolean;
  presentation?: "default" | "women";
  favorited?: boolean;
  favoritePending?: boolean;
  onToggleFavorite?: (card: ComparisonCardDto) => void;
}

export default function ProductCard({
  card,
  editorial = false,
  presentation = "default",
  favorited = false,
  favoritePending = false,
  onToggleFavorite,
}: ProductCardProps) {
  const offerHref = `/store/${card.cheapest_offer.vendor_slug}/products/${card.cheapest_offer.offer_id}`;
  const options = [...card.colors, ...card.sizes];
  const meta = [card.brand_name, card.category_name].filter(Boolean).join(" · ");
  const visibleStores = card.store_logos.slice(0, 3);
  // "420.00" -> "420"; keeps real decimals ("99.50").
  const displayPrice = String(Number.parseFloat(card.lowest_price) || card.lowest_price);

  if (presentation === "women") {
    return (
      <article className="product-card women-product-card" data-testid="product-card">
        <div className="product-card-media women-product-card-media">
          <Link href={offerHref} className="women-product-card-image" aria-label={card.canonical_name_ar}>
            {card.image_url ? (
              <SafeImage src={card.image_url} alt={card.canonical_name_ar} loading="lazy" />
            ) : (
              <span className="product-card-noimage">لا توجد صورة</span>
            )}
          </Link>

          <Link
            href={`/compare/${card.canonical_product_id}`}
            className="women-product-card-stores"
            aria-label={`قارني الأسعار بين ${card.store_count === 1 ? "متجر واحد" : `${card.store_count} متاجر`}`}
            title="مقارنة الأسعار"
          >
            <span className="women-product-card-store-count" aria-hidden="true">{card.store_count}+</span>
            {visibleStores.map((logo) => (
              <StoreCircle key={logo.vendor_id} name={logo.display_name} logoUrl={logo.logo_url} size={22} />
            ))}
          </Link>

          <span className="women-product-card-ai" title="تنسيق الإطلالة" role="img" aria-label="تنسيق الإطلالة">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="m10 1.8 1.65 5.05L16.7 8.5l-5.05 1.65L10 15.2l-1.65-5.05L3.3 8.5l5.05-1.65L10 1.8Z" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
              <path d="m16 12.5.8 2.2 2.2.8-2.2.8L16 18.5l-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" fill="currentColor" />
            </svg>
          </span>

          <button
            className={`women-product-card-favorite${favorited ? " is-favorited" : ""}`}
            type="button"
            aria-label={favorited ? "إزالة من المفضلة" : "إضافة إلى المفضلة"}
            aria-pressed={favorited}
            disabled={favoritePending}
            onClick={() => onToggleFavorite?.(card)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M20.8 4.7a5.5 5.5 0 0 0-7.8 0L12 5.8l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.4 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z" />
            </svg>
          </button>

          {card.has_discount && (
            <span
              className="women-product-card-discount"
              title={`خصم لدى ${card.discounted_store_count ?? 1} ${card.discounted_store_count === 1 ? "متجر" : "متاجر"}`}
            >
              خصم
            </span>
          )}

          {card.colors.length > 0 && (
            <div className="women-product-card-swatches" aria-label="الألوان المتاحة">
              {card.colors.slice(0, 3).map((color) => {
                const swatch = swatchFor(color);
                return swatch ? (
                  <span
                    key={color}
                    className="women-product-card-swatch"
                    style={{ backgroundColor: swatch }}
                    role="img"
                    aria-label={color}
                    title={color}
                  />
                ) : (
                  <span key={color} className="women-product-card-swatch-label" title={color}>
                    {color}
                  </span>
                );
              })}
              {card.colors.length > 3 && (
                <span className="women-product-card-swatch-more">+{card.colors.length - 3}</span>
              )}
            </div>
          )}
        </div>

        <div className="product-card-body women-product-card-body">
          <Link href={offerHref} className="product-card-name women-product-card-name">
            {card.canonical_name_ar}
          </Link>
          <div className="women-product-card-price-row">
            <span className="product-card-price women-product-card-price">₪ {displayPrice}</span>
            <span className="women-product-card-rating" aria-label={typeof card.rating !== "number" ? "لا يوجد تقييم بعد" : `التقييم ${card.rating.toFixed(1)} من 5`}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="m8 1.3 2.05 4.16 4.6.67-3.32 3.24.78 4.58L8 11.78l-4.11 2.17.78-4.58L1.35 6.13l4.6-.67L8 1.3Z" />
              </svg>
              {typeof card.rating !== "number" ? "—" : card.rating.toFixed(1)}
              {typeof card.rating === "number" && card.rating_count ? (
                <span className="women-product-card-rating-count">({card.rating_count})</span>
              ) : null}
            </span>
          </div>
          <div className="women-product-card-actions">
            <span className="women-product-card-sizes" aria-label="المقاسات المتاحة">
              {card.sizes.slice(0, 5).join(" · ")}
              {card.sizes.length > 5 ? ` +${card.sizes.length - 5}` : ""}
            </span>
            <Link
              href={offerHref}
              className="women-product-card-cart"
              aria-label="اختاري المقاس وأضيفي إلى السلة"
              title="اختاري المقاس وأضيفي إلى السلة"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 4h2.5l2 11h10l2-8H6.5" />
                <circle cx="9.5" cy="19" r="1.4" />
                <circle cx="16.5" cy="19" r="1.4" />
              </svg>
            </Link>
          </div>
        </div>
      </article>
    );
  }

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
        {card.has_discount && (
          <span className="product-card-discount-badge">
            خصم لدى {card.discounted_store_count ?? 1} {card.discounted_store_count === 1 ? "متجر" : "متاجر"}
          </span>
        )}
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
            const swatch = swatchFor(color);
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
