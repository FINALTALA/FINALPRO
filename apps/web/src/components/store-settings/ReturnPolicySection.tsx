"use client";

import { useEffect, useState } from "react";
import { ErrorBanner } from "@/components/States";
import { apiFetch, newIdempotencyKey } from "@/lib/api";
import { isUnauthorized } from "@/lib/apiErrors";
import { type UiError, fmt, formatDateTime, uiErrorText } from "@/lib/returns";
import "@/lib/storeSettingsText";
import { useLang, useT } from "@/lib/useLang";
import { useSessionExpiredRedirect } from "@/lib/useSessionExpiredRedirect";

export type ReturnMode = "NO_RETURN" | "REFUND_ONLY" | "EXCHANGE_ONLY" | "BOTH";
const MODES: ReturnMode[] = ["NO_RETURN", "REFUND_ONLY", "EXCHANGE_ONLY", "BOTH"];
export interface ReturnPolicyDto {
  mode: ReturnMode;
  window_days: number | null;
  fee_ils: number | null;
  exchange_fee_ils: number | null;
  updated_at: string | null;
}

/**
 * «سياسة الإرجاع» inside «إعدادات المتجر» (moved from its own page; same
 * API and rule - Sprint 21/21b, PDR-030): one store-wide policy. The owner
 * edits; the page around it is owner only.
 */
export default function ReturnPolicySection({ vendorId }: { vendorId: string }) {
  const lang = useLang();
  const t = useT();
  const onExpired = useSessionExpiredRedirect();
  const [policy, setPolicy] = useState<ReturnPolicyDto | null>(null);
  const [mode, setMode] = useState<ReturnMode>("NO_RETURN");
  const [windowDays, setWindowDays] = useState<number | "">("");
  const [feeIls, setFeeIls] = useState<number | "">("");
  const [exchangeFeeIls, setExchangeFeeIls] = useState<number | "">("");
  const [error, setError] = useState<UiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState(0);

  const needsWindow = mode !== "NO_RETURN";
  const needsReturnFee = mode === "REFUND_ONLY" || mode === "BOTH";
  const needsExchangeFee = mode === "EXCHANGE_ONLY" || mode === "BOTH";

  useEffect(() => {
    let alive = true;
    apiFetch<ReturnPolicyDto>(`/vendors/${vendorId}/return-policy`).then(
      (res) => {
        if (!alive) return;
        setPolicy(res);
        setMode(res.mode);
        setWindowDays(res.window_days ?? "");
        setFeeIls(res.fee_ils ?? "");
        setExchangeFeeIls(res.exchange_fee_ils ?? "");
      },
      (err: unknown) => {
        if (!alive) return;
        if (isUnauthorized(err)) onExpired();
        else setError({ api: err });
      },
    );
    return () => {
      alive = false;
    };
  }, [vendorId, version, onExpired]);

  async function save() {
    if (needsWindow && windowDays === "") return setError({ key: "ret.policy.need_window" });
    if (needsReturnFee && feeIls === "") return setError({ key: "ret.policy.need_fee" });
    if (needsExchangeFee && exchangeFeeIls === "") return setError({ key: "ret.policy.need_exchange_fee" });
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/vendors/${vendorId}/return-policy`, {
        method: "PUT",
        body: {
          mode,
          ...(needsWindow ? { window_days: Number(windowDays) } : {}),
          ...(needsReturnFee ? { fee_ils: Number(feeIls) } : {}),
          ...(needsExchangeFee ? { exchange_fee_ils: Number(exchangeFeeIls) } : {}),
        },
        idempotencyKey: newIdempotencyKey("return-policy-update"),
      });
      setNotice("ret.policy.saved");
      setVersion((v) => v + 1);
    } catch (err) {
      if (isUnauthorized(err)) return onExpired();
      setError({ api: err });
    } finally {
      setSaving(false);
    }
  }

  const num = (set: (v: number | "") => void) => (e: { target: { value: string } }) => set(e.target.value === "" ? "" : Number(e.target.value));
  return (
    <section className="br-card ss-section" id="returns" aria-labelledby="ss-returns-title" tabIndex={-1} data-testid="ss-returns">
      <h2 id="ss-returns-title">{t("ss.returns")}</h2>
      <p className="muted ss-lead">{t("ret.policy.hint")}</p>
      {error && <ErrorBanner message={uiErrorText(error, lang)} />}
      {!policy && !error && <div className="skeleton" style={{ height: 140, width: "100%" }} />}
      {policy && (
        <form
          className="ss-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="ss-field">
            <span className="ss-field-label">{t("ret.policy.label")}</span>
            <select className="ss-input ss-select" value={mode} onChange={(e) => setMode(e.target.value as ReturnMode)} data-testid="ss-policy-mode">
              {MODES.map((m) => (
                <option key={m} value={m}>{t(`ret.policy.mode.${m}`)}</option>
              ))}
            </select>
          </label>
          {needsWindow && (
            <label className="ss-field">
              <span className="ss-field-label">{t("ret.policy.window")}</span>
              <input type="number" min={1} dir="ltr" className="ss-input" value={windowDays} onChange={num(setWindowDays)} data-testid="ss-policy-window" />
            </label>
          )}
          {needsReturnFee && (
            <label className="ss-field">
              <span className="ss-field-label">{t("ret.policy.fee")}</span>
              <input type="number" min={0} dir="ltr" className="ss-input" value={feeIls} onChange={num(setFeeIls)} data-testid="ss-policy-fee" />
            </label>
          )}
          {needsExchangeFee && (
            <label className="ss-field">
              <span className="ss-field-label">{t("ret.policy.exchange_fee")}</span>
              <input type="number" min={0} dir="ltr" className="ss-input" value={exchangeFeeIls} onChange={num(setExchangeFeeIls)} data-testid="ss-policy-exchange-fee" />
            </label>
          )}
          <p className="muted ss-meta">{fmt(t("ret.policy.last_changed"), { date: formatDateTime(policy.updated_at, lang) })}</p>
          <div className="ss-actions">
            <button type="submit" className="ss-btn" disabled={saving} aria-busy={saving} data-testid="ss-policy-save">
              {saving ? t("common.saving") : t("ss.returns.save")}
            </button>
            {notice && <span className="muted" role="status" data-testid="ss-policy-saved">{t(notice)}</span>}
          </div>
        </form>
      )}
    </section>
  );
}
