"use client";

import { useEffect, useRef, useState } from "react";
import DwDialog from "@/components/branch-delivery/DwDialog";
import "@/components/branch-delivery/deliveryBoard.css";
import { ErrorBanner } from "@/components/States";
import { apiFetch, newIdempotencyKey } from "@/lib/api";
import { isUnauthorized } from "@/lib/apiErrors";
import { registerTranslations } from "@/lib/i18n";
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
import { useLang, useT } from "@/lib/useLang";
import { useSessionExpiredRedirect } from "@/lib/useSessionExpiredRedirect";
import type { ReturnPolicyDto } from "@/components/store-settings/ReturnPolicySection";

registerTranslations({
  ar: {
    "rt.policy": "سياسة المتجر",
    "rt.policy.window": "خلال {n} يوماً من الاستلام",
    "rt.policy.fee": "رسوم الإرجاع {amount}",
    "rt.policy.exchange_fee": "رسوم التبديل {amount}",
    "rt.policy.fee_free": "بلا رسوم إرجاع",
    "rt.policy.exchange_fee_free": "بلا رسوم تبديل",
    "rt.policy.owner_link": "تعديلها من «إعدادات المتجر»",
    "rt.redeem.open": "استبدال كود إرجاع",
    "rt.redeem.at": "يُستلم في: {branch}",
    "rt.redeem.at_owner_note": "لاستلامه في فرع آخر، يُختار الفرع من أعلى الصفحة.",
    "rt.redeem.done": "تم",
    "rt.redeem.cancel": "إلغاء",
    "rt.redeem.another": "استبدال كود آخر",
  },
  en: {
    "rt.policy": "Store policy",
    "rt.policy.window": "within {n} days of receipt",
    "rt.policy.fee": "return fee {amount}",
    "rt.policy.exchange_fee": "exchange fee {amount}",
    "rt.policy.fee_free": "no return fee",
    "rt.policy.exchange_fee_free": "no exchange fee",
    "rt.policy.owner_link": "edit it in «Store settings»",
    "rt.redeem.open": "Redeem a return code",
    "rt.redeem.at": "Received at: {branch}",
    "rt.redeem.at_owner_note": "To receive it at another branch, choose that branch at the top of the page.",
    "rt.redeem.done": "Done",
    "rt.redeem.cancel": "Cancel",
    "rt.redeem.another": "Redeem another code",
  },
});

/** «سياسة المتجر» in one quiet read-only line (owner and the branch's employee). */
export function ReturnPolicySummary({ vendorId, isOwner }: { vendorId: string; isOwner: boolean }) {
  const lang = useLang();
  const t = useT();
  const [policy, setPolicy] = useState<ReturnPolicyDto | null>(null);
  useEffect(() => {
    let alive = true;
    apiFetch<ReturnPolicyDto>(`/vendors/${vendorId}/return-policy`).then(
      (p) => {
        if (alive) setPolicy(p);
      },
      () => undefined, // a summary only: the queue below says what failed
    );
    return () => {
      alive = false;
    };
  }, [vendorId]);
  if (!policy) return null;
  const parts = [t(`ret.policy.mode.${policy.mode}`)];
  if (policy.mode !== "NO_RETURN" && policy.window_days) parts.push(fmt(t("rt.policy.window"), { n: policy.window_days }));
  if (policy.mode === "REFUND_ONLY" || policy.mode === "BOTH")
    parts.push(policy.fee_ils ? fmt(t("rt.policy.fee"), { amount: formatMoney(policy.fee_ils, lang) }) : t("rt.policy.fee_free"));
  if (policy.mode === "EXCHANGE_ONLY" || policy.mode === "BOTH")
    parts.push(policy.exchange_fee_ils ? fmt(t("rt.policy.exchange_fee"), { amount: formatMoney(policy.exchange_fee_ils, lang) }) : t("rt.policy.exchange_fee_free"));
  return (
    <p className="rt-policy" data-testid="rt-policy">
      <strong>{t("rt.policy")}:</strong> <span>{parts.join(" · ")}</span>
      {isOwner && (
        <>
          {" "}
          <a href={`/vendor/${vendorId}/settings#returns`} className="rt-policy-link" data-testid="rt-policy-link">{t("rt.policy.owner_link")}</a>
        </>
      )}
    </p>
  );
}

interface RedeemResult {
  id: string;
  status: string;
  received_at: string;
  desired_outcome: "RETURN" | "EXCHANGE";
  settlement: { net_amount: number; direction: "COLLECT_CASH" | "REFUND_CASH" | "NONE" } | null;
}

/**
 * «استبدال كود إرجاع» as an action of the branch's returns (it used to be a
 * store-level card). The receiving branch is THIS branch - the owner picks
 * another one with the branch picker at the top, never a second list here.
 * Same vendor-wide API (any branch of the store may receive a return; an
 * exchange must be received at its replacement branch - the server says so).
 */
export function RedeemDialog({ vendorId, branchId, branchName, isOwner, onClose, onRedeemed }: {
  vendorId: string;
  branchId: string;
  branchName: string;
  isOwner: boolean;
  onClose: () => void;
  onRedeemed: () => void;
}) {
  const lang = useLang();
  const t = useT();
  const onExpired = useSessionExpiredRedirect();
  const [code, setCode] = useState("");
  const [condition, setCondition] = useState<"RESELLABLE" | "DAMAGED">("RESELLABLE");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const [result, setResult] = useState<RedeemResult | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  async function redeem() {
    if (code.trim().length !== 6) {
      setError({ key: "ret.redeem.code_invalid" });
      codeRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<RedeemResult>(`/vendors/${vendorId}/returns/redeem`, {
        method: "POST",
        body: { code: code.trim(), receiving_branch_id: branchId, item_condition: condition },
        idempotencyKey: newIdempotencyKey("return-redeem"),
      });
      setResult(res);
      setCode("");
      onRedeemed();
    } catch (err) {
      if (isUnauthorized(err)) return onExpired();
      setError({ api: err });
    } finally {
      setBusy(false);
    }
  }

  return (
    <DwDialog title={t("ret.redeem.title")} onClose={onClose} busy={busy} testId="rt-redeem-dialog">
      {result ? (
        <div className="dw-form">
          <p className="notice-banner" role="status" data-testid="rt-redeem-result">
            {t(`ret.redeem.done.${result.desired_outcome}`)}{" "}
            {fmt(t("ret.redeem.summary"), { status: returnStatusLabel(result.status, lang), date: formatDateTime(result.received_at, lang) })}
            {result.settlement?.direction === "COLLECT_CASH" && <> {fmt(t("ret.redeem.collect"), { amount: formatMoney(result.settlement.net_amount, lang) })}</>}
            {result.settlement?.direction === "REFUND_CASH" && <> {fmt(t("ret.redeem.refund"), { amount: formatMoney(result.settlement.net_amount, lang) })}</>}
            {result.settlement?.direction === "NONE" && <> {t("ret.no_difference")}</>}
          </p>
          <div className="dw-dialog-actions">
            <button type="button" className="dw-btn" onClick={onClose} data-testid="rt-redeem-done">{t("rt.redeem.done")}</button>
            <button type="button" className="dw-btn dw-btn-quiet" onClick={() => setResult(null)}>{t("rt.redeem.another")}</button>
          </div>
        </div>
      ) : (
        <form
          className="dw-form"
          onSubmit={(e) => {
            e.preventDefault();
            void redeem();
          }}
        >
          {error && <ErrorBanner message={uiErrorText(error, lang)} />}
          <p className="rt-at" data-testid="rt-redeem-branch">
            <strong>{fmt(t("rt.redeem.at"), { branch: branchName })}</strong>
            {isOwner && <span className="dw-muted"> {t("rt.redeem.at_owner_note")}</span>}
          </p>
          <label className="dw-field">
            {t("ret.redeem.code_label")}
            <input
              ref={codeRef}
              className="dw-input rt-code"
              value={code}
              inputMode="numeric"
              autoComplete="off"
              dir="ltr"
              maxLength={6}
              disabled={busy}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              data-testid="rt-redeem-code"
            />
          </label>
          <label className="dw-field">
            {t("ret.redeem.condition_label")}
            <select className="dw-input" value={condition} disabled={busy} onChange={(e) => setCondition(e.target.value as "RESELLABLE" | "DAMAGED")} data-testid="rt-redeem-condition">
              {ITEM_CONDITIONS.map((v) => (
                <option key={v} value={v}>{itemConditionLabel(v, lang)}</option>
              ))}
            </select>
          </label>
          <div className="dw-dialog-actions">
            <button type="submit" className="dw-btn" disabled={busy} aria-busy={busy} data-testid="rt-redeem-submit">
              {busy ? t("ret.redeem.submitting") : t("ret.redeem.submit")}
            </button>
            <button type="button" className="dw-btn dw-btn-quiet" onClick={onClose} disabled={busy}>{t("rt.redeem.cancel")}</button>
          </div>
        </form>
      )}
    </DwDialog>
  );
}
