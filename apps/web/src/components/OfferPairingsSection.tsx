"use client";

import StoreOfferCard, { StoreOfferCardDto } from "@/components/StoreOfferCard";
import { useFetch } from "@/lib/useFetch";
import { registerTranslations } from "@/lib/i18n";
import { useT } from "@/lib/useLang";

registerTranslations({
  ar: { "pair.title": "نسّقي معه", "pair.note": "قطع يقترحها المتجر لتنسيقها مع هذا المنتج" },
  en: { "pair.title": "Style it with", "pair.note": "Pieces the store suggests pairing with this product" },
});

/**
 * PD-5.4 «نسّقي معه»: the store owner's own picks for this offer. The API
 * decides what is shown (only offers you can buy now, for the chosen
 * zone or your default address zone, at least two) - this component only
 * renders what it gets, and nothing at all when there is nothing to show.
 */
export default function OfferPairingsSection({
  slug,
  offerId,
  zone,
}: {
  slug: string;
  offerId: string;
  /** The zone the product page itself uses ("" = default address / none). */
  zone: string;
}) {
  const pairings = useFetch<{ items: StoreOfferCardDto[] }>(
    `/storefronts/${slug}/offers/${offerId}/pairings${zone ? `?zone=${zone}` : ""}`,
    // Signed in: the API uses your default address zone (never GPS).
    true,
  );
  const t = useT();
  const items = pairings.data?.items ?? [];
  if (items.length < 2) return null;
  return (
    <section className="pdp-pairings" aria-labelledby="pdp-pairings-title">
      <h2 id="pdp-pairings-title">{t("pair.title")}</h2>
      <p className="pdp-pairings-note">{t("pair.note")}</p>
      <div className="product-grid pdp-pairings-grid">
        {items.map((o) => (
          <StoreOfferCard key={o.id} slug={slug} offer={o} />
        ))}
      </div>
    </section>
  );
}
