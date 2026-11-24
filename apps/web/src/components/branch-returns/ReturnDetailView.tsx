"use client";

import { useState, type ReactNode, type RefObject } from "react";
import DwDialog from "@/components/branch-delivery/DwDialog";
import { actorLabel } from "@/components/branch-orders/OrderTimeline";
import SizeGuideSnapshotNote from "@/components/SizeGuideSnapshotNote";
import { isUnauthorized } from "@/lib/apiErrors";
import { relativeTime } from "@/lib/branchOrders";
import { decideReturn, type ReturnDetail, type ReturnEvent } from "@/lib/branchReturns";
import { fillRb } from "@/lib/branchReturnsText";
import type { Lang } from "@/lib/i18n";
import type { SizeGuideSnapshot } from "@/lib/sizeGuides";
import { formatDateTime, formatMoney, itemConditionLabel, returnReasonLabel, returnStatusLabel, uiErrorText, type UiError } from "@/lib/returns";
import { useSessionExpiredRedirect } from "@/lib/useSessionExpiredRedirect";
import { ItemLine, moneyLine } from "./ReceiveReturnDialog";
import "../branch-delivery/deliveryBoard.css";

const safeUrl = (u: string) => /^https?:\/\//i.test(u);

/** The return's activity, newest first: what, who (role and branch AT THAT TIME), when. */
function ReturnTimeline({ events, truncated, lang, t }: { events: ReturnEvent[] | null; truncated: boolean; lang: Lang; t: (k: string) => string }) {
  if (!events) return <div className="skeleton" style={{ height: 80, width: "100%" }} />;
  if (events.length === 0) return <p className="bo-muted">{t("rb.tl.empty")}</p>;
  return (
    <>
      <ol className="bo-timeline" data-testid="rb-timeline">
        {events.map((e) => {
          const { who, extra } = actorLabel(e.actor, t);
          const detail =
            e.kind === "received"
              ? [e.branch_name, e.condition ? itemConditionLabel(e.condition, lang) : null].filter(Boolean).join(" · ")
              : e.kind === "refunded" && e.amount !== null && e.amount !== undefined
                ? `${formatMoney(e.amount, lang)}${e.method ? ` · ${t(`rb.tl.method.${e.method}`)}` : ""}`
                : e.kind === "exchanged" && e.amount !== null && e.amount !== undefined && e.direction
                  ? e.direction === "NONE"
                    ? t("rb.money.none")
                    : fillRb(t(e.direction === "COLLECT_CASH" ? "rb.money.collect" : "rb.money.give"), { amount: formatMoney(e.amount, lang) })
                  : "";
          return (
            <li key={e.id} className="bo-tl-item" data-testid="rb-tl-item" data-kind={e.kind}>
              <span className="bo-tl-dot" aria-hidden="true" />
              <div className="bo-tl-body">
                <p className="bo-tl-what">
                  <strong>{t(`rb.tl.${e.kind}`)}</strong>
                  {detail && <span className="bo-muted" dir="auto">{detail}</span>}
                </p>
                <p className="bo-tl-who" data-testid="rb-tl-actor">
                  <span dir="auto">{who}</span>
                  {extra && <span className="bo-muted"> · {extra}</span>}
                </p>
                <p className="bo-tl-when">
                  <time dateTime={e.at} title={formatDateTime(e.at, lang)}>{relativeTime(e.at, lang)}</time>
                  <span className="bo-muted"> · {formatDateTime(e.at, lang)}</span>
                </p>
              </div>
            </li>
          );
        })}
      </ol>
      {truncated && <p className="bo-muted">{t("rb.tl.truncated")}</p>}
    </>
  );
}

/**
 * IX-P2: one return - what was returned, why, the money (expected until it
 * happens, then the recorded one), the replacement of an exchange, the
 * order's own policy, where it may be received, the activity; and, while it
 * awaits the decision, «قبول» / «رفض» (the existing decision endpoint; a
 * reason is required to reject). Never the code (IX-P1).
 */
export default function ReturnDetailView({
  vendorId,
  branchId,
  r,
  events,
  truncated,
  lang,
  t,
  onChanged,
  onNotice,
  headingRef,
  backButton,
}: {
  vendorId: string;
  branchId: string;
  r: ReturnDetail;
  events: ReturnEvent[] | null;
  truncated: boolean;
  lang: Lang;
  t: (k: string) => string;
  onChanged: () => Promise<void>;
  onNotice: (s: string) => void;
  headingRef: RefObject<HTMLHeadingElement | null>;
  backButton: ReactNode;
}) {
  const onExpired = useSessionExpiredRedirect();
  const [busy, setBusy] = useState(false);
  // TB-16.2: the failure or a key - translated when shown
  const [error, setError] = useState<UiError | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<UiError | null>(null);

  async function decide(decision: "approve" | "reject") {
    if (decision === "reject" && reason.trim().length < 10) {
      setReasonError({ key: "rb.reject.short" });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await decideReturn(vendorId, branchId, r.id, decision, reason.trim());
      setRejecting(false);
      setReason("");
      onNotice(t(decision === "approve" ? "rb.approved" : "rb.rejected"));
      await onChanged();
    } catch (err) {
      if (isUnauthorized(err)) return onExpired();
      if (decision === "reject") setReasonError({ api: err });
      else setError({ api: err });
    } finally {
      setBusy(false);
    }
  }

  const m = moneyLine(r.money, lang, t);
  const photos = r.photo_urls.filter(safeUrl);

  return (
    <article className="bo-detail" aria-labelledby="rb-detail-title" data-testid="rb-detail">
      {/* its own scrolling area on a computer: reachable and scrollable from the keyboard */}
      <div className="bo-detail-scroll" tabIndex={0} role="region" aria-labelledby="rb-detail-title">
        {backButton}
        <header className="bo-sec">
          <div className="bo-detail-head">
            <h2 id="rb-detail-title" ref={headingRef} tabIndex={-1} className="bo-detail-title" dir="auto">
              {fillRb(t("rb.detail.title"), { n: r.number })}
            </h2>
            <span className={`bo-chip rb-chip is-${r.status.toLowerCase()}`} data-testid="rb-detail-status">{returnStatusLabel(r.status, lang)}</span>
            <span className={`rb-outcome is-${r.outcome.toLowerCase()}`}>{t(`rb.outcome.${r.outcome}`)}</span>
          </div>
          <dl className="bo-facts">
            <div>
              <dt>{t("rb.f.order")}</dt>
              <dd dir="ltr">#{r.order_number}</dd>
            </div>
            <div>
              <dt>{t("rb.f.customer")}</dt>
              <dd dir="auto">{r.customer_short ?? "—"}</dd>
            </div>
            <div>
              <dt>{t("rb.f.created")}</dt>
              <dd>
                <time dateTime={r.created_at}>{formatDateTime(r.created_at, lang)}</time>
              </dd>
            </div>
            <div>
              <dt>{t("rb.f.branch")}</dt>
              <dd dir="auto">{r.branch_name}</dd>
            </div>
          </dl>
        </header>

        <section className="bo-sec" aria-labelledby="rb-sec-item">
          <h3 id="rb-sec-item" className="bo-sec-title">{t("rb.sec.item")}</h3>
          <ItemLine item={r.item} lang={lang} t={t} testId="rb-detail-item" />
          <SizeGuideSnapshotNote snapshot={r.size_guide as SizeGuideSnapshot | null} />
        </section>

        <section className="bo-sec" aria-labelledby="rb-sec-request">
          <h3 id="rb-sec-request" className="bo-sec-title">{t("rb.sec.request")}</h3>
          <dl className="bo-facts">
            <div>
              <dt>{t("rb.f.reason")}</dt>
              <dd data-testid="rb-detail-reason">{returnReasonLabel(r.reason, lang)}</dd>
            </div>
            {r.deadline && (
              <div>
                <dt>{t("rb.f.status")}</dt>
                <dd>{fillRb(t(`rb.deadline.${r.deadline.kind}`), { t: formatDateTime(r.deadline.at, lang) })}</dd>
              </div>
            )}
          </dl>
          {r.reason_note && (
            <>
              <p className="bo-label">{t("rb.f.note")}</p>
              <p className="bo-note" dir="auto" data-testid="rb-detail-note">{r.reason_note}</p>
            </>
          )}
          {photos.length > 0 && (
            <>
              <p className="bo-label">{t("rb.f.photos")}</p>
              <ul className="rb-photos">
                {photos.map((u, i) => (
                  <li key={u}>
                    <a href={u} target="_blank" rel="noopener noreferrer nofollow" className="bo-link">
                      {fillRb(t("rb.photo_n"), { n: i + 1 })}
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}
          {r.rejection_reason && (
            <>
              <p className="bo-label">{t("rb.f.rejection")}</p>
              <p className="bo-note" dir="auto">{r.rejection_reason}</p>
            </>
          )}
        </section>

        <section className="bo-sec" aria-labelledby="rb-sec-money">
          <h3 id="rb-sec-money" className="bo-sec-title">{t("rb.sec.money")}</h3>
          {m && (
            <p className="rb-money" data-testid="rb-detail-money">
              {m}
              {r.money && !r.money.final && <span className="bo-muted"> · {t("rb.money.expected")}</span>}
            </p>
          )}
          {r.received && (
            <p className="bo-muted" data-testid="rb-detail-received">
              {t("rb.f.received")}: {[formatDateTime(r.received.at, lang), r.received.branch_name, r.received.condition ? itemConditionLabel(r.received.condition, lang) : null].filter(Boolean).join(" · ")}
            </p>
          )}
          {r.receive_at && (
            <p className="rb-where" data-testid="rb-detail-where">
              {r.receive_at.any_branch ? t("rb.receive_where.any") : fillRb(t("rb.receive_where.one"), { branch: r.receive_at.branch_name ?? "" })}
            </p>
          )}
        </section>

        {r.replacement && (
          <section className="bo-sec" aria-labelledby="rb-sec-replacement">
            <h3 id="rb-sec-replacement" className="bo-sec-title">{t("rb.sec.replacement")}</h3>
            <ItemLine item={r.replacement} lang={lang} t={t} testId="rb-detail-replacement" />
            {r.replacement.branch_name && (
              <p className="bo-muted">
                {t("rb.f.replacement_branch")}: <span dir="auto">{r.replacement.branch_name}</span>
              </p>
            )}
          </section>
        )}

        <section className="bo-sec" aria-labelledby="rb-sec-policy">
          <h3 id="rb-sec-policy" className="bo-sec-title">{t("rb.sec.policy")}</h3>
          <dl className="bo-facts">
            {r.policy.window_days !== null && (
              <div>
                <dt>{t("rb.f.window")}</dt>
                <dd>{fillRb(t("rb.window_days"), { n: r.policy.window_days })}</dd>
              </div>
            )}
            {r.policy.fee_ils !== null && (
              <div>
                <dt>{t("rb.f.fee")}</dt>
                <dd>{formatMoney(r.policy.fee_ils, lang)}</dd>
              </div>
            )}
            {r.policy.exchange_fee_ils !== null && (
              <div>
                <dt>{t("rb.f.exchange_fee")}</dt>
                <dd>{formatMoney(r.policy.exchange_fee_ils, lang)}</dd>
              </div>
            )}
            <div>
              <dt>{t("rb.f.payment")}</dt>
              <dd>{t(`rb.pay.${r.payment_method}`)}</dd>
            </div>
          </dl>
        </section>

        <section className="bo-sec" aria-labelledby="rb-sec-tl">
          <h3 id="rb-sec-tl" className="bo-sec-title">{t("rb.sec.timeline")}</h3>
          <ReturnTimeline events={events} truncated={truncated} lang={lang} t={t} />
        </section>
      </div>

      {r.status === "REQUESTED" && (
        <div className="bo-actionbar" data-testid="rb-actions">
          {error && <p className="bo-error" role="alert">{uiErrorText(error, lang)}</p>}
          {r.is_own_return ? (
            <p className="bo-no-action bo-muted">{t("rb.own")}</p>
          ) : (
            <div className="bo-actionbar-row">
              <button type="button" className="bo-btn bo-btn-primary bo-btn-wide" disabled={busy || !r.can_decide} aria-busy={busy} onClick={() => void decide("approve")} data-testid="rb-approve">
                {t("rb.approve")}
              </button>
              <button
                type="button"
                className="bo-btn bo-btn-quiet"
                disabled={busy || !r.can_decide}
                onClick={() => {
                  setReasonError(null);
                  setRejecting(true);
                }}
                data-testid="rb-reject"
              >
                {t("rb.reject")}
              </button>
            </div>
          )}
        </div>
      )}

      {rejecting && (
        <DwDialog title={t("rb.reject.title")} onClose={() => setRejecting(false)} busy={busy} testId="rb-reject-dialog">
          <form
            className="dw-form"
            onSubmit={(e) => {
              e.preventDefault();
              void decide("reject");
            }}
          >
            <label className="dw-field">
              {t("rb.reject.reason")}
              <textarea
                className="dw-input"
                rows={3}
                maxLength={1000}
                value={reason}
                disabled={busy}
                aria-invalid={Boolean(reasonError) || undefined}
                aria-describedby="rb-reject-hint"
                onChange={(e) => {
                  setReason(e.target.value);
                  setReasonError(null);
                }}
                autoFocus
                data-testid="rb-reject-reason"
              />
            </label>
            <p id="rb-reject-hint" className="dw-muted">{t("rb.reject.hint")}</p>
            {reasonError && (
              <div className="error-banner" role="alert" data-testid="rb-reject-error">
                {uiErrorText(reasonError, lang)}
              </div>
            )}
            <div className="dw-dialog-actions">
              <button type="submit" className="dw-btn dw-btn-danger" disabled={busy} aria-busy={busy} data-testid="rb-reject-confirm">
                {t("rb.reject.confirm")}
              </button>
              <button type="button" className="dw-btn dw-btn-quiet" onClick={() => setRejecting(false)} disabled={busy}>
                {t("rb.cancel")}
              </button>
            </div>
          </form>
        </DwDialog>
      )}
    </article>
  );
}
