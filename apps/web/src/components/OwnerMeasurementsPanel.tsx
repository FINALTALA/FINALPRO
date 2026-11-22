"use client";

import { useEffect, useState } from "react";
import { ErrorBanner } from "@/components/States";
import { apiFetch, ApiError } from "@/lib/api";
import { MEASURE_LIMITS_CM, type DraftMeasurements, type MeasureKey } from "@/lib/offerWizard";
import { fill } from "@/lib/offerWizardText";
import "@/lib/offerWizardText";
import { useTaxonomy } from "@/lib/taxonomy";
import { useT } from "@/lib/useLang";

interface OfferMeasurementsView {
  offer_id: string;
  allowed_keys: MeasureKey[];
  sizes: string[];
  product_guide_applies: boolean;
  version: number | null;
  published_at: string | null;
  measurements: DraftMeasurements | null;
}

const ERRORS: Record<string, string> = {
  SIZE_GUIDE_INCOMPLETE: "wz.p.MEASUREMENTS",
  MEASUREMENT_NOT_FOR_CATEGORY: "wz.p.MEASUREMENTS.MEASUREMENT_NOT_FOR_CATEGORY",
  SIZE_VALUES_NOT_MONOTONIC: "wz.p.MEASUREMENTS.SIZE_VALUES_NOT_MONOTONIC",
  SIZE_VALUE_OUT_OF_RANGE: "wz.p.MEASUREMENTS.SIZE_VALUE_OUT_OF_RANGE",
};

/**
 * Phase A+: the product's own measurements table (cm) on its page - for a
 * published product, one created but not published, or an imported one.
 * Every save is a new version on the server (orders keep the version they
 * were bought under); removing it brings back the category's guide.
 */
export default function OwnerMeasurementsPanel({ vendorId, offerId, onSaved }: { vendorId: string; offerId: string; onSaved?: () => void }) {
  const t = useT();
  const taxonomy = useTaxonomy();
  const url = `/vendors/${vendorId}/offers/${offerId}/measurements`;
  const [view, setView] = useState<OfferMeasurementsView | null>(null);
  const [hidden, setHidden] = useState(false);
  const [keys, setKeys] = useState<MeasureKey[]>([]);
  const [cells, setCells] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function take(v: OfferMeasurementsView) {
    setView(v);
    // Nothing pre-chosen: the seller picks the measurements that matter for this piece.
    setKeys(v.allowed_keys.filter((k) => (v.measurements?.keys ?? []).includes(k)));
    const next: Record<string, string> = {};
    for (const [size, row] of Object.entries(v.measurements?.values ?? {})) for (const [k, n] of Object.entries(row)) next[`${size}|${k}`] = String(n);
    setCells(next);
  }

  // Loaded once per product (never again on a re-render: that would wipe what is being typed).
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    apiFetch<OfferMeasurementsView>(url)
      .then(take)
      .catch((err) => {
        if (err instanceof ApiError && (err.status === 403 || err.status === 404)) setHidden(true);
        else setLoadFailed(true);
      });
  }, [url]);

  if (hidden || !view) return loadFailed ? <ErrorBanner message={t("wz.err.generic")} /> : null;
  if (view.allowed_keys.length === 0 || view.sizes.length === 0) return null;

  const order = (code: string) => taxonomy.data?.sizes.find((x) => x.code === code)?.sort_order ?? 0;
  const label = (code: string) => taxonomy.data?.sizes.find((x) => x.code === code)?.label ?? code;
  const sizes = [...view.sizes].sort((a, b) => order(a) - order(b));
  const parse = (raw: string | undefined) => {
    const text = (raw ?? "").replace(",", ".").trim();
    return text === "" || !/^\d+(\.\d)?$/.test(text) ? null : Number(text);
  };

  async function save(remove: boolean) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const values: DraftMeasurements["values"] = {};
    const none = remove || keys.length === 0;
    if (!none) {
      for (const size of sizes) {
        const row: Partial<Record<MeasureKey, number>> = {};
        for (const k of keys) {
          const n = parse(cells[`${size}|${k}`]);
          if (n !== null) row[k] = n;
        }
        if (Object.keys(row).length) values[size] = row;
      }
    }
    try {
      const v = await apiFetch<OfferMeasurementsView>(url, {
        method: "PUT",
        body: { measurements: none ? null : { keys, values } },
      });
      take(v);
      setNotice(v.version ? fill(t("owner.measure.saved"), { v: v.version }) : t("owner.measure.removed"));
      onSaved?.();
    } catch (err) {
      setError(err instanceof ApiError && ERRORS[err.code] ? t(ERRORS[err.code]) : t("wz.err.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card owner-measure" style={{ maxWidth: 760, marginTop: 16 }} id="measurements" aria-labelledby="owner-measure-h" data-testid="owner-measure">
      <h3 id="owner-measure-h" style={{ marginTop: 0 }}>{t("wz.measure")}</h3>
      <p className="muted">{t("owner.measure.note")}</p>
      {view.product_guide_applies && <p className="muted">{t("owner.measure.product_guide")}</p>}
      {view.version !== null && <p className="muted" data-testid="owner-measure-version">{fill(t("owner.measure.version"), { v: view.version })}</p>}
      {error && <ErrorBanner message={error} />}
      {notice && <p className="muted" role="status" data-testid="owner-measure-notice">{notice}</p>}
      <div className="wz-chip-row" style={{ marginBottom: 8 }}>
        {view.allowed_keys.map((k) => {
          const on = keys.includes(k);
          return (
            <button key={k} type="button" className={`wz-chip${on ? " wz-chip-on" : ""}`} aria-pressed={on} disabled={busy}
              onClick={() => setKeys(on ? keys.filter((x) => x !== k) : view.allowed_keys.filter((x) => x === k || keys.includes(x)))}
              data-testid={`owner-measure-key-${k}`}>
              {t(`wz.key.${k}`)}
            </button>
          );
        })}
      </div>
      {keys.length === 0 ? (
        <p className="muted" data-testid="owner-measure-choose">{t("wz.measure.choose_first")}</p>
      ) : (
      <div className="wz-grid-wrap">
        <table className="wz-grid wz-measure-grid" data-testid="owner-measure-grid">
          <thead>
            <tr>
              <th scope="col" className="wz-grid-colorhead">{t("wz.measure.size")}</th>
              {keys.map((k) => (
                <th key={k} scope="col" title={fill(t("wz.measure.range"), { min: MEASURE_LIMITS_CM[k][0], max: MEASURE_LIMITS_CM[k][1] })}>{t(`wz.key.${k}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sizes.map((size) => (
              <tr key={size}>
                <th scope="row">{label(size)}</th>
                {keys.map((k) => (
                  <td key={k}>
                    <input type="text" inputMode="decimal" dir="ltr" className="wz-cell-input" disabled={busy}
                      aria-label={fill(t("wz.measure.cell"), { key: t(`wz.key.${k}`), size: label(size) })}
                      value={cells[`${size}|${k}`] ?? ""}
                      onChange={(e) => setCells((c) => ({ ...c, [`${size}|${k}`]: e.target.value }))}
                      data-testid={`owner-measure-${size}-${k}`} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
        <button type="button" className="button" onClick={() => void save(false)} disabled={busy} data-testid="owner-measure-save">{t("owner.measure.save")}</button>
        {view.version !== null && (
          <button type="button" className="button-link" onClick={() => { if (window.confirm(t("wz.measure.clear_confirm"))) void save(true); }} disabled={busy} data-testid="owner-measure-remove">
            {t("wz.measure.clear")}
          </button>
        )}
      </div>
    </section>
  );
}
