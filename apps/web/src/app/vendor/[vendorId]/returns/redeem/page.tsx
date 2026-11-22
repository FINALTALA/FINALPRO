"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorBanner } from "@/components/States";
import { apiFetch, newIdempotencyKey } from "@/lib/api";
import { isUnauthorized } from "@/lib/apiErrors";
import { useLang, useT } from "@/lib/useLang";
import { useSessionExpiredRedirect } from "@/lib/useSessionExpiredRedirect";
import {
  ITEM_CONDITIONS,
  type UiError,
  fmt,
  formatDateTime,
  formatMoney,
  itemConditionLabel,
  returnStatusLabel,
  uiErrorText,
} from "@/lib/returns";
import { useHydrated, useSessionToken } from "@/lib/useSession";
import { loginRedirectHref } from "@/lib/loginRedirect";

interface BranchDto {
  id: string;
  name: string;
  archived_at: string | null;
}

interface SettlementDto {
  net_amount: number;
  direction: "COLLECT_CASH" | "REFUND_CASH" | "NONE";
}

interface RedeemResult {
  id: string;
  status: string;
  receiving_branch_id: string;
  received_at: string;
  item_condition: string;
  desired_outcome: "RETURN" | "EXCHANGE";
  settlement: SettlementDto | null;
}

// Sprint 21 (PDR-031, review-round point 1/4): deliberately vendor-wide,
// not under a :branchId route - any employee/owner of this vendor can
// redeem a customer's code at whichever branch they're actually
// standing in (see VendorReturnsController's own comment). The
// response is the privacy-safe redeemResultDto() only - never
// reason_note/photo_urls/rejection_reason/code, since the redeeming
// employee may belong to a DIFFERENT branch than the one that
// originally decided this return. TB-16.2: Arabic and English.
export default function RedeemReturnPage() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const lang = useLang();
  const t = useT();
  const onExpired = useSessionExpiredRedirect();
  const hydrated = useHydrated();
  const token = useSessionToken();

  const [branches, setBranches] = useState<BranchDto[] | null>(null);
  const [code, setCode] = useState("");
  const [branchId, setBranchId] = useState("");
  const [condition, setCondition] = useState<"RESELLABLE" | "DAMAGED">("RESELLABLE");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const [result, setResult] = useState<RedeemResult | null>(null);

  useEffect(() => {
    if (!hydrated) return;
    if (!token) {
      router.replace(loginRedirectHref());
      return;
    }
    apiFetch<BranchDto[]>(`/vendors/${params.vendorId}/branches`)
      .then((data) => {
        const active = data.filter((b) => !b.archived_at);
        setBranches(active);
        if (active.length > 0) setBranchId(active[0].id);
      })
      .catch((err) => (isUnauthorized(err) ? onExpired() : setError({ api: err })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, token, params.vendorId]);

  if (!hydrated || !token) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 560 }} />
      </div>
    );
  }

  async function redeem() {
    if (code.trim().length !== 6) {
      setError({ key: "ret.redeem.code_invalid" });
      return;
    }
    if (!branchId) {
      setError({ key: "ret.redeem.branch_required" });
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await apiFetch<RedeemResult>(`/vendors/${params.vendorId}/returns/redeem`, {
        method: "POST",
        body: { code: code.trim(), receiving_branch_id: branchId, item_condition: condition },
        idempotencyKey: newIdempotencyKey("return-redeem"),
      });
      setResult(res);
      setCode("");
    } catch (err) {
      if (isUnauthorized(err)) {
        onExpired();
        return;
      }
      setError({ api: err });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-shell">
      <div className="top-bar">
        <h1 className="page-title" style={{ margin: 0 }}>{t("ret.redeem.title")}</h1>
        <Link href={`/vendor/${params.vendorId}`} className="button-link">{t("ret.store_dashboard")}</Link>
      </div>
      {error && <ErrorBanner message={uiErrorText(error, lang)} />}

      {!branches && !error && (
        <div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 560 }} />
      )}

      {branches && (
        <div className="card" style={{ maxWidth: 560 }}>
          <p className="muted" style={{ marginTop: 0 }}>
            {t("ret.redeem.hint")}
          </p>
          <div className="field">
            <label>{t("ret.redeem.code_label")}</label>
            <input
              value={code}
              disabled={busy}
              maxLength={6}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </div>
          <div className="field">
            <label>{t("ret.redeem.branch_label")}</label>
            <select value={branchId} disabled={busy} onChange={(e) => setBranchId(e.target.value)}>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>{t("ret.redeem.condition_label")}</label>
            <select
              value={condition}
              disabled={busy}
              onChange={(e) => setCondition(e.target.value as "RESELLABLE" | "DAMAGED")}
            >
              {ITEM_CONDITIONS.map((v) => (
                <option key={v} value={v}>{itemConditionLabel(v, lang)}</option>
              ))}
            </select>
          </div>
          <button className="button" disabled={busy} onClick={redeem}>
            {busy ? t("ret.redeem.submitting") : t("ret.redeem.submit")}
          </button>
        </div>
      )}

      {result && (
        <div className="notice-banner" style={{ marginTop: 14, maxWidth: 560 }} role="status">
          {t(`ret.redeem.done.${result.desired_outcome}`)}{" "}
          {fmt(t("ret.redeem.summary"), {
            status: returnStatusLabel(result.status, lang),
            date: formatDateTime(result.received_at, lang),
          })}
          {result.settlement && result.settlement.direction === "COLLECT_CASH" && (
            <> {fmt(t("ret.redeem.collect"), { amount: formatMoney(result.settlement.net_amount, lang) })}</>
          )}
          {result.settlement && result.settlement.direction === "REFUND_CASH" && (
            <> {fmt(t("ret.redeem.refund"), { amount: formatMoney(result.settlement.net_amount, lang) })}</>
          )}
          {result.settlement && result.settlement.direction === "NONE" && <> {t("ret.no_difference")}</>}
        </div>
      )}
    </div>
  );
}
