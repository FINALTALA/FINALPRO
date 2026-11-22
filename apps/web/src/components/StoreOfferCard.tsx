"use client";

import Link from "next/link";
import { HeartIcon } from "@/components/Icons";
import SafeImage from "@/components/SafeImage";
import type { Availability } from "@/lib/types";
import { useLang } from "@/lib/useLang";
import { registerTranslations, translate } from "@/lib/i18n";
import { pickText } from "@/lib/localized";
import { availabilityLabel, fmt } from "@/lib/shopText";

registerTranslations({ ar: { "shop.sold_out_badge": "نفد" }, en: { "shop.sold_out_badge": "Sold out" } });

/** The store's own product card fields (store page catalogue, «نسّقي معه»). */
export interface StoreOfferCardDto {
  id: string;
  title_ar: string;
  title_en: string;
  min_price: string | null;
  availability: Availability;
  image_url: string | null;
  favorite_variant_id: string | null;
  original_price: string | null;
  discount_percent: number | null;
}

/**
 * The store-offer card: links to that store's own product page. Shared by
 * the store page and the product page's «نسّقي معه» (PD-5.4), so both
 * show the same card and navigate the same way. The heart shows only
 * where favourites are wired (`onToggleFavorite`).
 */
export default function StoreOfferCard<T extends StoreOfferCardDto>({
  slug,
  offer,
  favorited = false,
  busy = false,
  onToggleFavorite,
}: {
  slug: string;
  offer: T;
  favorited?: boolean;
  busy?: boolean;
  onToggleFavorite?: (offer: T) => void;
}) {
  const lang = useLang();
  const t = (key: string) => translate(lang, key);
  const title = pickText(lang, offer.title_en, offer.title_ar);
  const soldOut = offer.availability === "sold_out";
  return (
    <div className={`product-card${soldOut ? " is-sold-out" : ""}`}>
      <Link href={`/store/${slug}/products/${offer.id}`} className="store-card-link">
        <div className="product-card-media">
          {offer.image_url ? (
            <SafeImage src={offer.image_url} alt={title} loading="lazy" />
          ) : (
            <span className="product-card-noimage">{t("shop.no_image")}</span>
          )}
          {soldOut ? (
            <span className="store-soldout-badge">{t("shop.sold_out_badge")}</span>
          ) : (
            offer.discount_percent !== null && (
              <span className="store-discount-badge" dir="ltr">-{offer.discount_percent}%</span>
            )
          )}
        </div>
        <div className="product-card-body">
          <div className="product-card-name">{title}</div>
          {offer.min_price && (
            <div className="product-card-price">
              {offer.min_price} ₪
              {offer.original_price && (
                <s className="store-price-old" aria-label={fmt(t("shop.was"), { price: offer.original_price })}>
                  {offer.original_price} ₪
                </s>
              )}
            </div>
          )}
          {!soldOut && (
            <span className={`availability-badge availability-${offer.availability}`}>
              {availabilityLabel(lang, offer.availability)}
            </span>
          )}
        </div>
      </Link>
      {offer.favorite_variant_id && onToggleFavorite && (
        <button
          type="button"
          className={`store-heart${favorited ? " on" : ""}`}
          disabled={busy}
          aria-pressed={favorited}
          aria-label={favorited ? t("shop.fav_remove") : t("shop.fav_add")}
          onClick={() => onToggleFavorite(offer)}
        >
          <HeartIcon />
        </button>
      )}
    </div>
  );
}

