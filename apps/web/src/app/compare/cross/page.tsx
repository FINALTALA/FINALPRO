"use client";

import Link from "next/link";
import { useState } from "react";
import { ErrorBanner, SkeletonGrid } from "@/components/States";
import { Availability } from "@/lib/types";
import { useFetch } from "@/lib/useFetch";
import { translate } from "@/lib/i18n";
import { useLang } from "@/lib/useLang";
import { apiErrorMessage } from "@/lib/apiErrors";
import { pickText } from "@/lib/localized";
import { fmt } from "@/lib/shopText";
import "@/lib/compareSetsText";
import { availabilityLabel } from "@/lib/shopText";
import "@/lib/pdpText";

// TB-25: "" = no area; the others are zone.* (lib/pdpText).
const ZONES = ["", "WEST_BANK", "JERUSALEM", "INSIDE"];

interface CrossProductDto {
  canonical_product_id: string;
  canonical_name_ar: string;
  canonical_name_en: string;
  brand_name: string | null;
  category_name: string | null;
  available: boolean;
  store_count?: number;
  price?: string;
  availability?: Availability;
  condition?: string;
  warranty_period?: string;
  warranty_type?: string;
  delivery_fee?: number | null;
  delivery_fee_status?: "NO_ZONE_SELECTED" | "AVAILABLE" | "NOT_AVAILABLE_IN_ZONE";
  rating?: number | null;
  rating_count?: number;
  is_price_stale?: boolean;
  is_cheapest?: boolean;
  cheapest_reason?: string;
}

interface DiffFieldDto {
  field: string;
  values: (string | number | boolean | null)[];
  all_same: boolean;
}

interface CrossComparisonDto {
  products: CrossProductDto[];
  diff: DiffFieldDto[];
}

// TB-25: field names are cross.field.<field>.

// Sprint 24 (FR-COMP-002 mode 2, FR-COMP-004/005/006): comparing 2-4
// DIFFERENT, competing canonical products side by side - each
// product represented by its own cheapest eligible offer.
export default function CrossComparisonPage() {
  const lang = useLang();
  const t = (key: string) => translate(lang, key);
  const [ids, setIds] = useState<string[]>(["", ""]);
  const [zone, setZone] = useState("");
  const [submitted, setSubmitted] = useState<{ ids: string[]; zone: string } | null>(null);

  const query = submitted
    ? (() => {
        const qs = new URLSearchParams({ products: submitted.ids.join(",") });
        if (submitted.zone) qs.set("zone", submitted.zone);
        return `/comparison/cross?${qs.toString()}`;
      })()
    : null;
  const result = useFetch<CrossComparisonDto>(query, false);

  function setId(index: number, value: string) {
    setIds((prev) => prev.map((v, i) => (i === index ? value : v)));
  }

  function addSlot() {
    if (ids.length < 4) setIds((prev) => [...prev, ""]);
  }

  function removeSlot(index: number) {
    if (ids.length > 2) setIds((prev) => prev.filter((_, i) => i !== index));
  }

  function submit() {
    const cleaned = ids.map((v) => v.trim()).filter(Boolean);
    if (cleaned.length < 2) return;
    setSubmitted({ ids: cleaned, zone });
  }

  return (
    <div className="page-shell">
      <div className="wide-shell">
        <h1 className="page-title">{t("cross.title")}</h1>
        <p className="page-subtitle">{t("cross.subtitle")}</p>

        <div className="card" style={{ marginBottom: 20 }}>
          {ids.map((id, i) => (
            <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <input
                type="text"
                placeholder={fmt(t("cross.id_n"), { n: i + 1 })}
                value={id}
                onChange={(e) => setId(i, e.target.value)}
                style={{ flex: 1 }}
              />
              {ids.length > 2 && (
                <button className="button-link" onClick={() => removeSlot(i)}>{t("cross.remove")}</button>
              )}
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {ids.length < 4 && (
              <button className="button-link" onClick={addSlot}>{t("cross.add")}</button>
            )}
            <select value={zone} onChange={(e) => setZone(e.target.value)}>
              {ZONES.map((z) => (
                <option key={z} value={z}>{z ? t(`zone.${z}`) : t("cross.zone_none")}</option>
              ))}
            </select>
            <button className="button" onClick={submit}>{t("cross.compare")}</button>
          </div>
        </div>

        {result.error && (
          <ErrorBanner message={result.status === 404 ? t("cross.not_found") : apiErrorMessage(result.apiError, lang)} />
        )}
        {result.loading && <SkeletonGrid count={2} />}

        {result.data && (
          <>
            <div className="compare-grid">
              {result.data.products.map((p) => (
                <div key={p.canonical_product_id} className={`compare-card${p.is_cheapest ? " best" : ""}`}>
                  {p.is_cheapest && <span className="compare-rank">{lang === "en" ? (p.cheapest_reason ? t("cross.cheapest_reason") : t("cross.cheapest")) : (p.cheapest_reason ?? t("cross.cheapest"))}</span>}
                  <Link href={`/compare/${p.canonical_product_id}`}>
                    <strong>{pickText(lang, p.canonical_name_en, p.canonical_name_ar)}</strong>
                  </Link>
                  {p.brand_name && <div className="muted">{p.brand_name}</div>}
                  {!p.available ? (
                    <span className="muted">{t("cross.no_offers")}</span>
                  ) : (
                    <>
                      <div className="product-card-price">{p.price} ₪</div>
                      {p.availability && (
                        <span className={`availability-badge availability-${p.availability}`}>
                          {availabilityLabel(lang, p.availability)}
                        </span>
                      )}
                      {p.is_price_stale && (
                        <span className="muted" style={{ fontSize: 12 }}>{t("cross.stale")}</span>
                      )}
                      {p.warranty_period && (
                        <div className="muted" style={{ fontSize: 13 }}>{fmt(t("cross.warranty"), { w: p.warranty_period })}</div>
                      )}
                      {p.delivery_fee_status === "AVAILABLE" && (
                        <div className="muted" style={{ fontSize: 13 }}>{fmt(t("cross.delivery_fee"), { fee: p.delivery_fee ?? 0 })}</div>
                      )}
                      {p.delivery_fee_status === "NOT_AVAILABLE_IN_ZONE" && (
                        <div className="muted" style={{ fontSize: 13 }}>{t("cross.no_delivery")}</div>
                      )}
                      {typeof p.rating === "number" && (
                        <div className="muted" style={{ fontSize: 13 }}>
                          {fmt(t("cross.rating"), { r: p.rating.toFixed(1), n: p.rating_count ?? 0 })}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>

            {result.data.diff.some((d) => !d.all_same) && (
              <div className="card" style={{ marginTop: 16 }}>
                <strong style={{ display: "block", marginBottom: 8 }}>{t("cross.differences")}</strong>
                {result.data.diff
                  .filter((d) => !d.all_same)
                  .map((d) => (
                    <div key={d.field} className="muted" style={{ fontSize: 13 }}>
                      {t(`cross.field.${d.field}`) === `cross.field.${d.field}` ? d.field : t(`cross.field.${d.field}`)}: {d.values.map((v) => String(v ?? t("cross.unavailable"))).join(" / ")}
                    </div>
                  ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
