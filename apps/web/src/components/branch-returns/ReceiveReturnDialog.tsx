"use client";

import { useEffect, useRef, useState } from "react";
import DwDialog from "@/components/branch-delivery/DwDialog";
import SafeImage from "@/components/SafeImage";
import { ApiError } from "@/lib/api";
import { isUnauthorized } from "@/lib/apiErrors";
import {
  itemColor,
  itemTitle,
  lookupReturn,
  redeemReturn,
  type RedeemResult,
  type ReturnItem,
  type ReturnMoney,
  type ReturnPreview,
} from "@/lib/branchReturns";
import { fillRb } from "@/lib/branchReturnsText";
import type { Lang } from "@/lib/i18n";
import { formatDateTime, formatMoney, itemConditionLabel, uiErrorText, type UiError } from "@/lib/returns";
import { useSessionExpiredRedirect } from "@/lib/useSessionExpiredRedirect";
import ReturnCodeField from "./ReturnCodeField";
import "../branch-delivery/deliveryBoard.css";

/** The money of a return in one line («استرداد نقدي 95 ₪», «تحصيل فرق 23 ₪»…). */
export function moneyLine(m: ReturnMoney, lang: Lang, t: (k: string) => string): string | null {
  if (!m) return null;
  const amount = formatMoney(m.amount, lang);
  if (m.kind === "refund") return fillRb(t(m.method === "COD_CASH" ? "rb.money.refund_cash" : "rb.money.refund_online"), { amount });
  if (m.direction === "NONE") return t("rb.money.none");
  return fillRb(t(m.direction === "COLLECT_CASH" ? "rb.money.collect" : "rb.money.give"), { amount });
}

/** What the counter does now, after the receipt - the amount and how. */
function resultLines(r: RedeemResult, lang: Lang, t: (k: string) => string): string[] {
  const lines = [fillRb(t("rb.result.received"), { condition: itemConditionLabel(r.item_condition, lang) })];
  if (r.refund) {
    const amount = formatMoney(r.refund.amount, lang);
    lines.push(fillRb(t(r.refund.method === "COD_CASH" ? "rb.result.cash" : "rb.result.online"), { amount }));
  } else if (r.settlement) {
    const amount = formatMoney(r.settlement.net_amount, lang);
    lines.push(
      r.settlement.direction === "NONE"
        ? t("rb.result.none")
        : fillRb(t(r.settlement.direction === "COLLECT_CASH" ? "rb.result.collect" : "rb.result.give"), { amount }),
    );
  }
  return lines;
}

export function ItemLine({ item, lang, t, testId }: { item: ReturnItem & { quantity?: number }; lang: Lang; t: (k: string) => string; testId?: string }) {
  const color = itemColor(item, lang);
  return (
    <div className="rb-item" data-testid={testId}>
      <span className="rb-item-img" aria-hidden="true">
        {item.image_url ? <SafeImage src={item.image_url} alt="" width={56} height={56} /> : <span className="rb-item-ph" />}
      </span>
      <span className="rb-item-text">
        <strong dir="auto">{itemTitle(item, lang)}</strong>
        <span className="rb-item-meta">
          {color && (
            <span>
              {item.color_hex && <span className="bo-swatch" style={{ background: item.color_hex }} aria-hidden="true" />} {t("rb.f.color")}: <span dir="auto">{color}</span>
            </span>
          )}
          {item.size_label && (
            <span>
              {t("rb.f.size")}: <span dir="auto">{item.size_label}</span>
            </span>
          )}
          {item.quantity !== undefined && <span dir="ltr">{fillRb(t("rb.qty"), { n: item.quantity })}</span>}
        </span>
      </span>
    </div>
  );
}

/**
 * IX-P2 «استلام إرجاع»: ONE entry for the code (typed + Enter, a scanner, the
 * camera), then a safe preview (POST …/returns/lookup - nothing is consumed:
 * the item, return / exchange, the money and how, the code's validity, where
 * it may be received), then the condition and «تأكيد الاستلام» - the existing
 * redemption, one transaction, unchanged - and an explicit result: what to
 * hand back or collect. The receiving branch is the branch shown (the owner
 * changes it with the header picker); the server decides who may receive where.
 */
export default function ReceiveReturnDialog({
  vendorId,
  branchId,
  branchName,
  isOwner,
  lang,
  t,
  onClose,
  onReceived,
}: {
  vendorId: string;
  branchId: string;
  branchName: string;
  isOwner: boolean;
  lang: Lang;
  t: (k: string) => string;
  onClose: () => void;
  onReceived: (returnId: string) => void;
}) {
  const onExpired = useSessionExpiredRedirect();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  // TB-16.2: the failure or a key - translated when shown, so it follows a language switch
  const [error, setError] = useState<UiError | null>(null);
  const [preview, setPreview] = useState<ReturnPreview | null>(null);
  const [condition, setCondition] = useState<"RESELLABLE" | "DAMAGED">("RESELLABLE");
  const [result, setResult] = useState<{ r: RedeemResult; id: string } | null>(null);
  const stepRef = useRef<HTMLHeadingElement>(null);

  // each step's heading takes the focus (a screen reader hears the new step)
  useEffect(() => {
    if (preview || result) stepRef.current?.focus();
  }, [preview, result]);

  function fail(err: unknown) {
    if (isUnauthorized(err)) return onExpired();
    setError({ api: err });
  }

  async function check(value: string) {
    if (!/^\d{6}$/.test(value)) {
      setError({ key: "rb.receive.code_short" });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const p = await lookupReturn(vendorId, value, branchId);
      setCondition("RESELLABLE");
      setPreview(p);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const r = await redeemReturn(vendorId, code, branchId, condition);
      setResult({ r, id: preview.return_id });
      setPreview(null);
      setCode("");
      onReceived(preview.return_id);
    } catch (err) {
      // a refusal at this point (used meanwhile, expired, wrong branch): back to the code
      if (err instanceof ApiError && err.status !== 401) setPreview(null);
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  function another() {
    setResult(null);
    setPreview(null);
    setError(null);
    setCode("");
  }

  const blockedText =
    preview?.blocked_reason === "WRONG_BRANCH_FOR_EXCHANGE"
      ? fillRb(t("rb.preview.blocked.WRONG_BRANCH_FOR_EXCHANGE"), { branch: preview.allowed_branch?.name ?? "" })
      : preview?.blocked_reason === "SELF_DECISION_FORBIDDEN"
        ? t("rb.preview.blocked.SELF_DECISION_FORBIDDEN")
        : null;

  return (
    <DwDialog title={t("rb.receive.title")} onClose={onClose} busy={busy} testId="rb-receive-dialog">
      <div className="dw-form">
        <p className="rb-at" data-testid="rb-receive-branch">
          <strong>{fillRb(t("rb.receive.at"), { branch: branchName })}</strong>
          {isOwner && !result && <span className="dw-muted"> {t("rb.receive.at_owner")}</span>}
        </p>
        {error && (
          <div className="error-banner" role="alert" data-testid="rb-receive-error">
            {uiErrorText(error, lang)}
          </div>
        )}

        {result ? (
          <div className="rb-result" data-testid="rb-result">
            <h3 ref={stepRef} tabIndex={-1} className="rb-step-title">{t(result.r.desired_outcome === "EXCHANGE" ? "rb.tl.exchanged" : "rb.tl.received")}</h3>
            <div role="status" aria-live="polite">
              {resultLines(result.r, lang, t).map((line, i) => (
                <p key={i} className={i === 1 ? "rb-result-money" : "rb-result-line"} data-testid={i === 1 ? "rb-result-money" : undefined}>
                  {line}
                </p>
              ))}
            </div>
            <div className="dw-dialog-actions">
              <button type="button" className="dw-btn" onClick={onClose} data-testid="rb-done">{t("rb.result.done")}</button>
              <button type="button" className="dw-btn dw-btn-quiet" onClick={another} data-testid="rb-another">{t("rb.result.another")}</button>
            </div>
          </div>
        ) : preview ? (
          <div className="rb-preview" data-testid="rb-preview">
            <h3 ref={stepRef} tabIndex={-1} className="rb-step-title">{t("rb.preview.title")}</h3>
            <p className="dw-muted" dir="auto">
              {fillRb(t("rb.preview.line"), { outcome: t(`rb.outcome.${preview.outcome}`), n: preview.order_number })}
            </p>
            <ItemLine item={preview.item} lang={lang} t={t} testId="rb-preview-item" />
            {preview.replacement && (
              <>
                <p className="rb-label">{t("rb.preview.replacement")}</p>
                <ItemLine item={preview.replacement} lang={lang} t={t} testId="rb-preview-replacement" />
              </>
            )}
            <p className="rb-money" data-testid="rb-preview-money">{moneyLine(preview.money, lang, t)}</p>
            <ul className="rb-facts">
              <li>{fillRb(t("rb.preview.valid_until"), { date: formatDateTime(preview.code_expires_at, lang) })}</li>
              <li>
                {preview.allowed_branch
                  ? fillRb(t("rb.preview.allowed_one"), { branch: preview.allowed_branch.name ?? "" })
                  : t("rb.preview.allowed_any")}
              </li>
            </ul>
            {blockedText ? (
              <p className="rb-blocked" role="alert" data-testid="rb-preview-blocked">{blockedText}</p>
            ) : (
              <fieldset className="rb-condition" data-testid="rb-condition">
                <legend className="dw-field">{t("rb.condition")}</legend>
                {(["RESELLABLE", "DAMAGED"] as const).map((c) => (
                  <label key={c} className={`rb-cond-opt${condition === c ? " is-on" : ""}`}>
                    <input type="radio" name="rb-condition" value={c} checked={condition === c} onChange={() => setCondition(c)} disabled={busy} data-testid={`rb-condition-${c}`} />
                    <span>{itemConditionLabel(c, lang)}</span>
                  </label>
                ))}
                <p className="dw-muted">{t("rb.condition_hint")}</p>
              </fieldset>
            )}
            <div className="dw-dialog-actions">
              {!blockedText && (
                <button type="button" className="dw-btn" onClick={() => void confirm()} disabled={busy} aria-busy={busy} data-testid="rb-confirm">
                  {busy ? t("rb.receive.confirming") : t("rb.receive.confirm")}
                </button>
              )}
              <button type="button" className="dw-btn dw-btn-quiet" onClick={another} disabled={busy} data-testid="rb-change">{t("rb.receive.change")}</button>
            </div>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void check(code);
            }}
          >
            <ReturnCodeField
              value={code}
              onChange={(v) => {
                setCode(v);
                if (error) setError(null);
              }}
              onEnter={(v) => void check(v)}
              disabled={busy}
              invalid={Boolean(error)}
              t={t}
            />
            <div className="dw-dialog-actions">
              <button type="submit" className="dw-btn" disabled={busy} aria-busy={busy} data-testid="rb-check">
                {busy ? t("rb.receive.checking") : t("rb.receive.check")}
              </button>
              <button type="button" className="dw-btn dw-btn-quiet" onClick={onClose} disabled={busy}>{t("rb.cancel")}</button>
            </div>
          </form>
        )}
      </div>
    </DwDialog>
  );
}
