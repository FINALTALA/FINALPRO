"use client";

import { useEffect, useState } from "react";
import { DiscountFields } from "@/components/DiscountFields";
import { ErrorBanner } from "@/components/States";
import { apiFetch, ApiError } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiErrors";
import { discountFields, discountProblem, type DraftDiscount } from "@/lib/discountWindow";
import "@/lib/offerWizardText";
import { useLang, useT } from "@/lib/useLang";

interface VariantPrice {
  base_price: string;
  sale_price: string | null;
  discount_percent: string | null;
  discount_start_at: string | null;
  discount_end_at: string | null;
}

/**
 * Phase A++ (item 7): the ONE place a classified product's price and
 * discount are edited after creation - the existing PUT .../offers/:id/price
 * (every version rewritten together, price history, followers notified).
 * The per-version screen shows the price read-only for such a product.
 */
export default function OfferPriceCard({ vendorId, offerId, onSaved }: { vendorId: string; offerId: string; onSaved?: () => void }) {
  const t = useT();
  const lang = useLang();
  const [price, setPrice] = useState<number | null>(null);
  const [discount, setDiscount] = useState<DraftDiscount | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showProblems, setShowProblems] = useState(false);

  useEffect(() => {
    apiFetch<VariantPrice[]>(`/vendors/${vendorId}/offers/${offerId}/variants`)
      .then((vs) => {
        const v = vs[0];
        if (v) {
          setPrice(Number(v.base_price));
          setDiscount(
            v.discount_percent
              ? { mode: "window", percent: Number(v.discount_percent), start_at: v.discount_start_at, end_at: v.discount_end_at }
              : v.sale_price
                ? { mode: "sale", sale_price: Number(v.sale_price) }
                : null,
          );
        }
        setLoaded(true);
      })
      .catch((err) => setError(apiErrorMessage(err, lang)));
  }, [vendorId, offerId, lang]);

  if (!loaded) return error ? <ErrorBanner message={error} /> : null;
  const problem = discountProblem(price, discount);

  async function save() {
    setShowProblems(true);
    setError(null);
    setNotice(null);
    if (!price || problem) return;
    setBusy(true);
    try {
      await apiFetch(`/vendors/${vendorId}/offers/${offerId}/price`, {
        method: "PUT",
        body: { base_price: price, ...discountFields(discount) },
      });
      setNotice(t("discount.saved"));
      onSaved?.();
    } catch (err) {
      setError(err instanceof ApiError && err.code ? apiErrorMessage(err, lang) : t("wz.err.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" style={{ maxWidth: 560, marginTop: 16 }} id="price" aria-labelledby="offer-price-h" data-testid="offer-price-card">
      <h3 id="offer-price-h" style={{ marginTop: 0 }}>{t("discount.card_title")}</h3>
      <p className="muted">{t("wz.price.one_note")}</p>
      <div className="field">
        <label htmlFor="offer-price-base">{t("wz.price.one")}</label>
        <input id="offer-price-base" type="number" inputMode="decimal" min={0} step="0.5" value={price ?? ""} onChange={(e) => setPrice(e.target.value === "" ? null : Number(e.target.value))} data-testid="offer-price-base" />
      </div>
      <DiscountFields price={price} value={discount} onChange={setDiscount} t={t} error={showProblems && problem ? t(`wz.p.DISCOUNT.${problem}`) : null} />
      {error && <ErrorBanner message={error} />}
      {notice && <p className="muted" role="status" data-testid="offer-price-notice">{notice}</p>}
      <button type="button" className="button" onClick={() => void save()} disabled={busy} data-testid="offer-price-save">
        {t("discount.save")}
      </button>
    </section>
  );
}
