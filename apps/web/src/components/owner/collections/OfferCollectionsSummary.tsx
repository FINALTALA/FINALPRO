"use client";

import { useEffect, useState } from "react";
import { IconCollections } from "@/components/product-wizard/wizardIcons";
import { collectionName, collectionsApi, type StoreCollection } from "@/lib/collections";
import "@/lib/collectionsText";
import { useLang, useT } from "@/lib/useLang";

/**
 * The owner's product details page: the product's «المجموعات» READ ONLY, as
 * chips - no field, no save. «إدارة المجموعات» (a quiet secondary action)
 * opens the product's collections screen in the same management window
 * (`onManage`), or - outside the window - the products page there (`manageHref`).
 */
export function OfferCollectionsSummary({
  vendorId,
  offerId,
  onManage,
  manageHref,
}: {
  vendorId: string;
  offerId: string;
  onManage?: () => void;
  manageHref?: string;
}) {
  const t = useT();
  const lang = useLang();
  const [mine, setMine] = useState<StoreCollection[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([collectionsApi.list(vendorId), collectionsApi.ofOffer(vendorId, offerId)])
      .then(([all, of]) => {
        if (!cancelled) setMine(all.filter((c) => of.section_ids.includes(c.id)));
      })
      .catch(() => {
        if (!cancelled) setMine([]);
      });
    return () => {
      cancelled = true;
    };
  }, [vendorId, offerId]);

  return (
    <div className="offer-collections offer-collections-read" data-testid="offer-collections-summary">
      <h3>{t("offer.collections")}</h3>
      {mine === null ? (
        <div className="skeleton" style={{ height: 32 }} />
      ) : mine.length === 0 ? (
        <p className="muted">{t("col.none_for_offer")}</p>
      ) : (
        <ul className="owner-chips offer-collections-chips">
          {mine.map((c) => (
            <li key={c.id} className="owner-chip owner-chip-quiet">
              {collectionName(c, lang)}
              {!c.visible && <span className="visually-hidden"> ({t("col.hidden")})</span>}
            </li>
          ))}
        </ul>
      )}
      {onManage ? (
        <button type="button" className="owner-quiet-link offer-collections-manage" onClick={onManage} data-testid="offer-collections-manage">
          <IconCollections /> {t("col.manage")}
        </button>
      ) : manageHref ? (
        <a href={manageHref} className="owner-quiet-link offer-collections-manage" data-testid="offer-collections-manage">
          <IconCollections /> {t("col.manage")}
        </a>
      ) : null}
    </div>
  );
}
