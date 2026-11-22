"use client";

import Link from "next/link";
import ProductCard from "@/components/ProductCard";
import { collectionDescription, collectionTitle, PublicCollection } from "@/lib/publicCollections";
import type { ComparisonCardDto } from "@/lib/types";
import { useFetch } from "@/lib/useFetch";
import { useLang } from "@/lib/useLang";

/**
 * PD-5b.4: the platform's editorial collections on the home page (up to
 * two) or a department page (one). Exactly what GET /collections returns
 * - live collections with their first buyable products for the shopper's
 * zone (a signed-in shopper's default address; never GPS) - each with
 * «عرض الكل». Nothing at all while loading, on error, or when the API
 * returns none: no empty box.
 */
export default function CollectionShowcase({
  placement,
  audience,
  presentation = "default",
  favoriteIds,
  favoritePendingIds,
  favoritesLoading,
  onToggleFavorite,
}: {
  placement: "HOME" | "AUDIENCE";
  audience?: "WOMEN" | "MEN" | "KIDS";
  /** The card style of the page it sits on (the department pages use "women"). */
  presentation?: "default" | "women";
  favoriteIds?: ReadonlySet<string>;
  favoritePendingIds?: ReadonlySet<string>;
  favoritesLoading?: boolean;
  onToggleFavorite?: (card: ComparisonCardDto) => void;
}) {
  const lang = useLang();
  const query = `/collections?placement=${placement}${audience ? `&audience=${audience}` : ""}`;
  // Signed in: the API applies the default address zone.
  const collections = useFetch<{ items: PublicCollection[] }>(query, true);
  const items = collections.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <div className="collection-showcase">
      {items.map((c) => {
        const description = collectionDescription(c, lang);
        return (
          <section key={c.slug} className="collection-showcase-section" aria-labelledby={`collection-${c.slug}`}>
            <div className="section-heading">
              <div>
                <h2 id={`collection-${c.slug}`}>{collectionTitle(c, lang)}</h2>
                {description && <p>{description}</p>}
              </div>
              <Link href={`/collections/${c.slug}`} className="button-link">
                {lang === "en" ? "View all" : "عرض الكل"}
              </Link>
            </div>
            <div className="product-grid collection-showcase-grid">
              {c.products.map((card) => (
                <ProductCard
                  key={card.canonical_product_id}
                  card={card}
                  presentation={presentation}
                  editorial={presentation === "default"}
                  favorited={favoriteIds?.has(card.canonical_product_id) ?? false}
                  favoritePending={favoritesLoading || (favoritePendingIds?.has(card.canonical_product_id) ?? false)}
                  onToggleFavorite={onToggleFavorite}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
