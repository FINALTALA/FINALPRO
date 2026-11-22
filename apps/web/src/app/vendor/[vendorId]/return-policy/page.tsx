"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorBanner } from "@/components/States";
import { apiFetch, newIdempotencyKey } from "@/lib/api";
import { isUnauthorized } from "@/lib/apiErrors";
import { useLang, useT } from "@/lib/useLang";
import { useSessionExpiredRedirect } from "@/lib/useSessionExpiredRedirect";
import { type UiError, fmt, formatDateTime, uiErrorText } from "@/lib/returns";
import { useHydrated, useSessionToken, useWorkspaces } from "@/lib/useSession";
import { loginRedirectHref } from "@/lib/loginRedirect";

type ReturnMode = "NO_RETURN" | "REFUND_ONLY" | "EXCHANGE_ONLY" | "BOTH";
const MODES: ReturnMode[] = ["NO_RETURN", "REFUND_ONLY", "EXCHANGE_ONLY", "BOTH"];

interface PolicyDto {
  mode: ReturnMode;
  window_days: number | null;
  fee_ils: number | null;
  exchange_fee_ils: number | null;
  updated_at: string | null;
}

// Sprint 21/21b (PDR-030): the LATER-update half of the return policy -
// the initial selection happens at vendor registration
// (CreateVendorDto). EXCHANGE_ONLY/BOTH are real as of Sprint 21b -
// exchange within the store's own real branches only, no PickupPoint.
// TB-16.2: Arabic and English.
export default function ReturnPolicyPage() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const lang = useLang();
  const t = useT();
  const onExpired = useSessionExpiredRedirect();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const workspaces = useWorkspaces(token);
  const membership = workspaces?.find(
    (w) => w.type === "vendor" && w.vendor_id === params.vendorId,
  );
  const isOwner = membership?.type === "vendor" && membership.role === "OWNER";

  const [policy, setPolicy] = useState<PolicyDto | null>(null);
  const [mode, setMode] = useState<ReturnMode>("NO_RETURN");
  const [windowDays, setWindowDays] = useState<number | "">("");
  const [feeIls, setFeeIls] = useState<number | "">("");
  const [exchangeFeeIls, setExchangeFeeIls] = useState<number | "">("");
  const [error, setError] = useState<UiError | null>(null);
  // The key of the notice, not its words - it follows a language switch.
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const needsWindow = mode !== "NO_RETURN";
  const needsReturnFee = mode === "REFUND_ONLY" || mode === "BOTH";
  const needsExchangeFee = mode === "EXCHANGE_ONLY" || mode === "BOTH";

  function load() {
    apiFetch<PolicyDto>(`/vendors/${params.vendorId}/return-policy`)
      .then((res) => {
        setPolicy(res);
        setMode(res.mode);
        setWindowDays(res.window_days ?? "");
        setFeeIls(res.fee_ils ?? "");
        setExchangeFeeIls(res.exchange_fee_ils ?? "");
      })
      .catch((err) => (isUnauthorized(err) ? onExpired() : setError({ api: err })));
  }

  useEffect(() => {
    if (!hydrated) return;
    if (!token) {
      router.replace(loginRedirectHref());
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, token, params.vendorId]);

  async function save() {
    if (needsWindow && windowDays === "") {
      setError({ key: "ret.policy.need_window" });
      return;
    }
    if (needsReturnFee && feeIls === "") {
      setError({ key: "ret.policy.need_fee" });
      return;
    }
    if (needsExchangeFee && exchangeFeeIls === "") {
      setError({ key: "ret.policy.need_exchange_fee" });
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/vendors/${params.vendorId}/return-policy`, {
        method: "PUT",
        body: {
          mode,
          ...(needsWindow ? { window_days: Number(windowDays) } : {}),
          ...(needsReturnFee ? { fee_ils: Number(feeIls) } : {}),
          ...(needsExchangeFee
            ? { exchange_fee_ils: Number(exchangeFeeIls) }
            : {}),
        },
        idempotencyKey: newIdempotencyKey("return-policy-update"),
      });
      setNotice("ret.policy.saved");
      load();
    } catch (err) {
      if (isUnauthorized(err)) {
        onExpired();
        return;
      }
      setError({ api: err });
    } finally {
      setSaving(false);
    }
  }

  if (!hydrated || !token) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 560 }} />
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="top-bar">
        <h1 className="page-title" style={{ margin: 0 }}>{t("ret.policy.title")}</h1>
        <Link href={`/vendor/${params.vendorId}`} className="button-link">{t("ret.store_dashboard")}</Link>
      </div>
      {error && <ErrorBanner message={uiErrorText(error, lang)} />}
      {notice && <p className="muted">{t(notice)}</p>}

      {!policy && !error && (
        <div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 560 }} />
      )}

      {policy && (
        <div className="card" style={{ maxWidth: 560 }}>
          <p className="muted" style={{ marginTop: 0 }}>
            {t("ret.policy.hint")}
          </p>
          <div className="field">
            <label>{t("ret.policy.label")}</label>
            <select
              value={mode}
              disabled={!isOwner}
              onChange={(e) => setMode(e.target.value as ReturnMode)}
            >
              {MODES.map((m) => (
                <option key={m} value={m}>{t(`ret.policy.mode.${m}`)}</option>
              ))}
            </select>
          </div>
          {needsWindow && (
            <div className="field">
              <label>{t("ret.policy.window")}</label>
              <input
                type="number"
                min={1}
                disabled={!isOwner}
                value={windowDays}
                onChange={(e) => setWindowDays(e.target.value === "" ? "" : Number(e.target.value))}
              />
            </div>
          )}
          {needsReturnFee && (
            <div className="field">
              <label>{t("ret.policy.fee")}</label>
              <input
                type="number"
                min={0}
                disabled={!isOwner}
                value={feeIls}
                onChange={(e) => setFeeIls(e.target.value === "" ? "" : Number(e.target.value))}
              />
            </div>
          )}
          {needsExchangeFee && (
            <div className="field">
              <label>{t("ret.policy.exchange_fee")}</label>
              <input
                type="number"
                min={0}
                disabled={!isOwner}
                value={exchangeFeeIls}
                onChange={(e) =>
                  setExchangeFeeIls(e.target.value === "" ? "" : Number(e.target.value))
                }
              />
            </div>
          )}
          <div className="muted">{fmt(t("ret.policy.last_changed"), { date: formatDateTime(policy.updated_at, lang) })}</div>
          {isOwner && (
            <button className="button" disabled={saving} onClick={save} style={{ marginTop: 10 }}>
              {saving ? t("common.saving") : t("common.save")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
