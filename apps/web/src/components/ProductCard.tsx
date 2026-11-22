"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import SafeImage from "./SafeImage";
import StoreCircle from "./StoreCircle";
import { ComparisonCardDto } from "@/lib/types";
import { swatchFor } from "@/lib/colors";
import BestsellerBadge from "@/components/BestsellerBadge";
import { useLang } from "@/lib/useLang";
import { translate, type Lang } from "@/lib/i18n";
import { useTaxonomy, type TaxonomyDto } from "@/lib/taxonomy";
import { colorName, pickText } from "@/lib/localized";
import { availabilityLabel, fmt, storeCountLabel } from "@/lib/shopText";

const MAX_OPTION_PILLS = 4;

/** TB-25: a card's colours - by taxonomy code (named in the interface
 * language, with the taxonomy swatch) when the API sends codes, otherwise
 * the catalogue's own colour text as before. */
export function cardColors(
  card: ComparisonCardDto,
  taxonomy: TaxonomyDto | null,
  lang: Lang,
): { key: string; label: string; hex: string | null }[] {
  if (card.color_codes && card.color_codes.length > 0) {
    return card.color_codes.map((code) => ({
      key: code,
      label: colorName(taxonomy, code, lang) ?? code,
      hex: taxonomy?.colors.find((c) => c.code === code)?.hex ?? null,
    }));
  }
  return card.colors.map((c) => ({ key: c, label: c, hex: swatchFor(c) }));
}

// Sprint 13: the global product card used by Home, Discovery, search
// and Following. Every field shown comes from real API data - a card
// with no image shows a neutral "no image" tile, and colours/sizes/
// brand appear only when the product actually has them. TB-25: names,
// category, colours and the card's own words follow the interface language.
interface ProductCardProps {
  card: ComparisonCardDto;
  editorial?: boolean;
  presentation?: "default" | "women";
  favorited?: boolean;
  favoritePending?: boolean;
  onToggleFavorite?: (card: ComparisonCardDto) => void;
  /**
   * Where opening the card leads. "compare" (default, every public list):
   * the product's comparison, where the shopper picks a store's offer.
   * "offer": straight to the cheapest offer's page - only for a card shown
   * inside one store's own page.
   */
  navigationMode?: "compare" | "offer";
  /** Link for the image, name and cart button instead of the place
   *  navigationMode picks (a card for a piece that has no Via offer yet). */
  href?: string;
  /** Extra badges drawn over the image (women presentation). */
  overlay?: ReactNode;
  /** Women presentation: a piece with no VIA product behind it yet. The
   *  card links nowhere and shows this label where the cart control goes -
   *  nothing on it pretends to be shoppable. */
  unavailableLabel?: string;
  /** Optional, off by default (women presentation): a small "watch it in a
   *  reel" action in the card's action row, for a product that has its own
   *  reel. It only calls `onOpen` - it never follows the card's links. */
  reelAction?: { label: string; onOpen: () => void };
}

export default function ProductCard({
  card,
  editorial = false,
  presentation = "default",
  favorited = false,
  favoritePending = false,
  onToggleFavorite,
  navigationMode = "compare",
  href,
  overlay,
  unavailableLabel,
  reelAction,
}: ProductCardProps) {
  const lang = useLang();
  const t = (key: string) => translate(lang, key);
  const taxonomy = useTaxonomy().data;
  const name = pickText(lang, card.canonical_name_en, card.canonical_name_ar);
  const colors = cardColors(card, taxonomy, lang);
  const compareHref = `/compare/${card.canonical_product_id}`;
  // The image, the name and the cart icon all open the same place; the
  // heart and the small store logos keep their own behaviour.
  const openHref =
    href ??
    (navigationMode === "offer"
      ? `/store/${card.cheapest_offer.vendor_slug}/products/${card.cheapest_offer.offer_id}`
      : compareHref);
  const options = [...colors.map((c) => c.label), ...card.sizes];
  const category = card.category_name ? pickText(lang, card.category_name_en, card.category_name) : null;
  const meta = [card.brand_name, category].filter(Boolean).join(" · ");
  const visibleStores = card.store_logos.slice(0, 3);
  // "420.00" -> "420"; keeps real decimals ("99.50").
  const displayPrice = String(Number.parseFloat(card.lowest_price) || card.lowest_price);
  const discountStores = card.discounted_store_count ?? 1;
  const discountTitle = fmt(t("shop.discount_at"), {
    n: discountStores,
    stores: t(card.discounted_store_count === 1 ? "shop.store_word_one" : "shop.store_word_many"),
  });
  // The card's own links - plain text for a piece that is not in VIA yet.
  const linkOrSpan = (className: string, children: ReactNode, label?: string) =>
    unavailableLabel ? (
      <span className={className}>{children}</span>
    ) : (
      <Link href={openHref} className={className} aria-label={label}>{children}</Link>
    );

  if (presentation === "women") {
    return (
      <article className="product-card women-product-card" data-testid="product-card" data-product-id={card.canonical_product_id}>
        <div className="product-card-media women-product-card-media">
          {linkOrSpan(
            "women-product-card-image",
            card.image_url ? (
              <SafeImage src={card.image_url} alt={name} loading="lazy" />
            ) : (
              <span className="product-card-noimage">{t("shop.no_image")}</span>
            ),
            name,
          )}
          {card.bestseller && <BestsellerBadge mark={card.bestseller} />}

          {card.store_count > 0 && <Link
            href={compareHref}
            className="women-product-card-stores"
            aria-label={fmt(t("shop.compare_between"), { stores: storeCountLabel(lang, card.store_count) })}
            title={t("shop.compare_title")}
          >
            <span className="women-product-card-store-count" aria-hidden="true">{card.store_count}+</span>
            {visibleStores.map((logo) => (
              <StoreCircle key={logo.vendor_id} name={logo.display_name} logoUrl={logo.logo_url} size={22} />
            ))}
          </Link>}

          <span className="women-product-card-ai" title={t("shop.style_look")} role="img" aria-label={t("shop.style_look")}>
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="m10 1.8 1.65 5.05L16.7 8.5l-5.05 1.65L10 15.2l-1.65-5.05L3.3 8.5l5.05-1.65L10 1.8Z" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
              <path d="m16 12.5.8 2.2 2.2.8-2.2.8L16 18.5l-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" fill="currentColor" />
            </svg>
          </span>

          {onToggleFavorite && <button
            className={`women-product-card-favorite${favorited ? " is-favorited" : ""}`}
            type="button"
            aria-label={favorited ? t("shop.fav_remove") : t("shop.fav_add")}
            aria-pressed={favorited}
            disabled={favoritePending}
            onClick={() => onToggleFavorite(card)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M20.8 4.7a5.5 5.5 0 0 0-7.8 0L12 5.8l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.4 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z" />
            </svg>
          </button>}

          {card.has_discount && (
            <span className="women-product-card-discount" title={discountTitle}>
              {t("shop.discount")}
            </span>
          )}

          {colors.length > 0 && (
            <div className="women-product-card-swatches" aria-label={t("shop.colors_available")}>
              {colors.slice(0, 3).map((color) =>
                color.hex ? (
                  <span
                    key={color.key}
                    className="women-product-card-swatch"
                    style={{ backgroundColor: color.hex }}
                    role="img"
                    aria-label={color.label}
                    title={color.label}
                  />
                ) : (
                  <span key={color.key} className="women-product-card-swatch-label" title={color.label}>
                    {color.label}
                  </span>
                ),
              )}
              {colors.length > 3 && (
                <span className="women-product-card-swatch-more">+{colors.length - 3}</span>
              )}
            </div>
          )}
          {overlay}
        </div>

        <div className="product-card-body women-product-card-body">
          {linkOrSpan("product-card-name women-product-card-name", name)}
          <div className="women-product-card-price-row">
            {card.lowest_price ? <span className="product-card-price women-product-card-price">₪ {displayPrice}</span> : <span />}
            <span
              className="women-product-card-rating"
              aria-label={typeof card.rating !== "number" ? t("shop.no_rating") : fmt(t("shop.rating_of"), { r: card.rating.toFixed(1) })}
            >
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
            <span className="women-product-card-sizes" aria-label={t("shop.sizes_available")}>
              {card.sizes.slice(0, 5).join(" · ")}
              {card.sizes.length > 5 ? ` +${card.sizes.length - 5}` : ""}
            </span>
            {reelAction && (
              <button
                type="button"
                className="women-product-card-reel"
                dir="auto"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  reelAction.onOpen();
                }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" /></svg>
                <span>{reelAction.label}</span>
              </button>
            )}
            {unavailableLabel ? (
              <span className="women-product-card-unavailable">{unavailableLabel}</span>
            ) : (
              <Link
                href={openHref}
                className="women-product-card-cart"
                aria-label={t("shop.pick_size_add")}
                title={t("shop.pick_size_add")}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 4h2.5l2 11h10l2-8H6.5" />
                  <circle cx="9.5" cy="19" r="1.4" />
                  <circle cx="16.5" cy="19" r="1.4" />
                </svg>
              </Link>
            )}
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className="product-card" data-testid="product-card" data-product-id={card.canonical_product_id}>
      <Link href={openHref} className="product-card-media" aria-label={name}>
        {card.image_url ? (
          <SafeImage src={card.image_url} alt={name} loading="lazy" />
        ) : (
          <span className="product-card-noimage">{t("shop.no_image")}</span>
        )}
        {card.bestseller && <BestsellerBadge mark={card.bestseller} />}
      </Link>

      <div className="product-card-body">
        {meta && <div className="product-card-meta">{meta}</div>}
        {card.has_discount && <span className="product-card-discount-badge">{discountTitle}</span>}
        <Link href={openHref} className="product-card-name" style={{ textDecoration: "none", color: "inherit" }}>
          {name}
        </Link>

        {!editorial && options.length > 0 && (
          <div className="product-card-options" aria-label={t("shop.colors_and_sizes")}>
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
          <small>{t("shop.starts_from")}</small>
          {card.lowest_price} ₪
        </div>
        <span className={`availability-badge availability-${card.lowest_price_availability}`}>
          {availabilityLabel(lang, card.lowest_price_availability)}
        </span>

        {editorial && options.length > 0 && <div className="home-product-options" aria-label={t("shop.colors_and_sizes_available")}>
          {colors.slice(0, 4).map((color) =>
            color.hex ? (
              <span key={color.key} className="home-color-swatch" style={{ backgroundColor: color.hex }} role="img" aria-label={fmt(t("shop.color_of"), { color: color.label })} title={color.label} />
            ) : (
              <span key={color.key} className="option-pill">{color.label}</span>
            ),
          )}
          {colors.length > 4 && <span className="option-pill">{fmt(t("shop.more_colors"), { n: colors.length - 4 })}</span>}
          {card.sizes.slice(0, 4).map((size) => <span className="option-pill" key={`size-${size}`}>{size}</span>)}
          {card.sizes.length > 4 && <span className="option-pill">{fmt(t("shop.more_sizes"), { n: card.sizes.length - 4 })}</span>}
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
          <span>{storeCountLabel(lang, card.store_count)}</span>
        </div>
      </div>

      <div className="product-card-actions">
        <Link
          href={compareHref}
          className="button button-block button-secondary"
        >
          {t("shop.compare_prices")}
        </Link>
      </div>
    </article>
  );
}
