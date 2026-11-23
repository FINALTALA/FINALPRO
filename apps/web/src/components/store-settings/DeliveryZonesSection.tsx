"use client";

import { useEffect, useState } from "react";
import { ErrorBanner } from "@/components/States";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { isUnauthorized } from "@/lib/apiErrors";
import "@/lib/storeSettingsText";
import { useT } from "@/lib/useLang";
import { useSessionExpiredRedirect } from "@/lib/useSessionExpiredRedirect";

type Region = "WEST_BANK" | "JERUSALEM" | "INSIDE";
const REGIONS: Region[] = ["WEST_BANK", "JERUSALEM", "INSIDE"];
interface ZoneDto {
  region: Region;
  enabled: boolean;
  fee: number | null;
}
interface Row {
  region: Region;
  enabled: boolean;
  fee: number | null;
  minimum: number | null;
}
interface Draft {
  enabled: boolean;
  fee: string;
  minimum: string;
}

const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? "");
const toDraft = (r: Row): Draft => ({ enabled: r.enabled, fee: r.fee === null ? "" : String(r.fee), minimum: r.minimum === null ? "" : String(r.minimum) });

/**
 * «مناطق ورسوم التوصيل» inside «إعدادات المتجر» (moved from its own page;
 * same API and rule - Sprint 10 / 20b): per zone, delivery on/off, its fee
 * (no fee = not offered), and an optional minimum of its own (empty = each
 * branch's minimum). One explicit «حفظ» per zone.
 */
export default function DeliveryZonesSection({ vendorId }: { vendorId: string }) {
  const t = useT();
  const onExpired = useSessionExpiredRedirect();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ region: Region; text: string } | null>(null);
  const [saved, setSaved] = useState<Region | null>(null);
  const [busy, setBusy] = useState<Region | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    Promise.all([
      apiFetch<ZoneDto[]>(`/vendors/${vendorId}/delivery-zones`),
      Promise.all(
        REGIONS.map((region) =>
          apiFetch<{ minimum_order_value: number | null }>(`/vendors/${vendorId}/delivery-zones/${region}/minimum-order`).then(
            (res) => [region, res.minimum_order_value] as const,
          ),
        ),
      ),
    ]).then(
      ([zones, minimums]) => {
        if (!alive) return;
        const min = Object.fromEntries(minimums) as Record<Region, number | null>;
        const list = REGIONS.map((region) => {
          const z = zones.find((x) => x.region === region);
          return { region, enabled: z?.enabled ?? true, fee: z?.fee ?? null, minimum: min[region] ?? null };
        });
        setRows(list);
        setDrafts(Object.fromEntries(list.map((r) => [r.region, toDraft(r)])));
        setError(null);
      },
      (err: unknown) => {
        if (!alive) return;
        if (isUnauthorized(err)) return onExpired();
        setError(err instanceof ApiError && err.message ? err.message : t("ss.zone.load_failed"));
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorId, version, onExpired]);

  async function save(row: Row) {
    const d = drafts[row.region];
    setRowError(null);
    setSaved(null);
    const fee = d.fee.trim() === "" ? null : Number(d.fee);
    const minimum = d.minimum.trim() === "" ? null : Number(d.minimum);
    if ((fee !== null && (!Number.isFinite(fee) || fee < 0)) || (minimum !== null && (!Number.isFinite(minimum) || minimum < 0))) {
      setRowError({ region: row.region, text: t("ss.zone.invalid") });
      return;
    }
    setBusy(row.region);
    try {
      if (d.enabled !== row.enabled || (fee !== null && fee !== row.fee)) {
        await apiFetch(`/vendors/${vendorId}/delivery-zones/${row.region}`, {
          method: "PUT",
          body: fee === null ? { enabled: d.enabled } : { enabled: d.enabled, fee },
        });
      }
      if (minimum !== row.minimum) {
        await apiFetch(`/vendors/${vendorId}/delivery-zones/${row.region}/minimum-order`, {
          method: "PUT",
          body: { minimum_order_value: minimum },
          idempotencyKey: newIdempotencyKey("zone-minimum-order"),
        });
      }
      setSaved(row.region);
      setVersion((v) => v + 1);
    } catch (err) {
      if (isUnauthorized(err)) return onExpired();
      setRowError({ region: row.region, text: err instanceof ApiError && err.message ? err.message : t("ss.zone.save_failed") });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="br-card ss-section" id="delivery" aria-labelledby="ss-delivery-title" tabIndex={-1} data-testid="ss-delivery">
      <h2 id="ss-delivery-title">{t("ss.delivery")}</h2>
      <p className="muted ss-lead">{t("ss.delivery.lead")}</p>
      {error && <ErrorBanner message={error} />}
      {!rows && !error && <div className="skeleton" style={{ height: 140, width: "100%" }} />}
      {rows && (
        <ul className="ss-zones">
          <li className="ss-zone ss-zone-head" aria-hidden="true">
            <span>{t("ss.zone.region")}</span>
            <span>{t("ss.zone.enabled")}</span>
            <span>{t("ss.zone.fee")}</span>
            <span>{t("ss.zone.minimum")}</span>
            <span />
          </li>
          {rows.map((row) => {
            const d = drafts[row.region] ?? toDraft(row);
            const name = t(`ss.zone.${row.region}`);
            const set = (patch: Partial<Draft>) => {
              setSaved(null);
              setDrafts((all) => ({ ...all, [row.region]: { ...d, ...patch } }));
            };
            const id = `ss-zone-${row.region}`;
            return (
              <li key={row.region} className="ss-zone" data-testid={`ss-zone-${row.region}`}>
                <strong className="ss-zone-name" id={`${id}-name`}>{name}</strong>
                <label className="ss-check">
                  <input type="checkbox" checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} aria-describedby={`${id}-name`} data-testid={`ss-zone-enabled-${row.region}`} />
                  <span>{t("ss.zone.enabled")}</span>
                </label>
                <label className="ss-field">
                  <span className="ss-field-label">{t("ss.zone.fee")}</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    dir="ltr"
                    className="ss-input"
                    value={d.fee}
                    placeholder={t("ss.zone.fee_unset")}
                    onChange={(e) => set({ fee: e.target.value })}
                    aria-describedby={`${id}-name`}
                    data-testid={`ss-zone-fee-${row.region}`}
                  />
                </label>
                <label className="ss-field">
                  <span className="ss-field-label">{t("ss.zone.minimum")}</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    dir="ltr"
                    className="ss-input"
                    value={d.minimum}
                    placeholder={t("ss.zone.minimum_none")}
                    onChange={(e) => set({ minimum: e.target.value })}
                    aria-describedby={`${id}-name`}
                    data-testid={`ss-zone-min-${row.region}`}
                  />
                </label>
                <button type="button" className="ss-btn ss-save" disabled={busy !== null} aria-busy={busy === row.region} onClick={() => void save(row)} data-testid={`ss-zone-save-${row.region}`}>
                  {fill(t("ss.zone.save"), { zone: name })}
                </button>
                {row.fee === null && <p className="muted ss-zone-note">{t("ss.zone.not_offered")}</p>}
                {rowError?.region === row.region && <p className="ss-zone-note ss-error" role="alert">{rowError.text}</p>}
                {saved === row.region && <p className="muted ss-zone-note" role="status" data-testid={`ss-zone-saved-${row.region}`}>{fill(t("ss.zone.saved"), { zone: name })}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
