"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch, newIdempotencyKey } from "@/lib/api";
import { isUnauthorized } from "@/lib/apiErrors";
import { useLang, useT } from "@/lib/useLang";
import { useSessionExpiredRedirect } from "@/lib/useSessionExpiredRedirect";
import { useFetch } from "@/lib/useFetch";
import { useHydrated, useSessionToken } from "@/lib/useSession";
import {
  type UiError,
  fmt,
  formatDateTime,
  formatMoney,
  returnErrorMessage,
  returnReasonLabel,
  returnStatusLabel,
  uiErrorText,
} from "@/lib/returns";
import ReturnCodeCard from "@/components/ReturnCodeCard";
import SizeGuideSnapshotNote from "@/components/SizeGuideSnapshotNote";
import type { SizeGuideSnapshot } from "@/lib/sizeGuides";
import { loginRedirectHref } from "@/lib/loginRedirect";

interface SettlementDto {
  net_amount: number;
  direction: "COLLECT_CASH" | "REFUND_CASH" | "NONE";
}

interface ReturnDto {
  id: string;
  status: string;
  reason: string;
  reason_note: string | null;
  photo_urls: string[];
  code: string | null;
  code_expires_at: string | null;
  rejected_at: string | null;
  dispute_deadline_at: string | null;
  rejection_reason: string | null;
  escalated_at: string | null;
  received_at: string | null;
  item_condition: string | null;
  created_at: string;
  desired_outcome: "RETURN" | "EXCHANGE";
  settlement: SettlementDto | null;
  size_guide?: SizeGuideSnapshot | null;
}

// Sprint 21 (FR-RET-002/003, review-round point 1): a single return's
// full detail + the customer's own actions on it (cancel while
// REQUESTED, dispute while REJECTED and within the window) - every
// return status is a possible terminal/transient read here, so the page
// shows the raw status badge even for ones with no action available
// (RECEIVED/REFUND_PROCESSING/REFUNDED/ESCALATED/...).
// TB-16.2: Arabic and English; the customer's note and the rejection
// reasons are shown as written.
export default function ReturnDetailPage() {
  const params = useParams<{ returnId: string }>();
  const router = useRouter();
  const lang = useLang();
  const t = useT();
  const onExpired = useSessionExpiredRedirect();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<UiError | null>(null);

  const path =
    hydrated && token ? `/customers/me/returns/${params.returnId}?r=${nonce}` : null;
  const { data, status, loading, apiError } = useFetch<ReturnDto>(path, true);
  // TB-16.1: an expired session goes to sign-in, back to this page.
  useEffect(() => {
    if (status === 401) onExpired();
  }, [status, onExpired]);

  if (!hydrated) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 560 }} />
      </div>
    );
  }
  if (!token) {
    router.replace(loginRedirectHref());
    return null;
  }

  async function act(action: "cancel" | "dispute") {
    setBusy(true);
    setActionError(null);
    try {
      await apiFetch(`/customers/me/returns/${params.returnId}/${action}`, {
        method: "POST",
        idempotencyKey: newIdempotencyKey(`return-${action}`),
      });
      setNonce((n) => n + 1);
    } catch (err) {
      if (isUnauthorized(err)) {
        onExpired();
        return;
      }
      setActionError({ api: err });
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 560 }} />
      </div>
    );
  }
  if (status === 404) {
    return (
      <EmptyState
        title={t("ret.detail.not_found")}
        actionHref="/returns"
        actionLabel={t("ret.my_returns")}
      />
    );
  }
  if (status === 401) return null;
  if (apiError || !data) {
    return (
      <div className="page-shell">
        <ErrorBanner message={apiError ? returnErrorMessage(apiError, lang) : t("ret.detail.load_failed")} />
      </div>
    );
  }

  const canCancel = data.status === "REQUESTED";
  const canDispute =
    data.status === "REJECTED" &&
    !!data.dispute_deadline_at &&
    new Date(data.dispute_deadline_at) > new Date();
  const date = (iso: string | null) => formatDateTime(iso, lang);

  return (
    <div className="page-shell">
      <div className="top-bar">
        <h1 className="page-title" style={{ margin: 0 }}>{t("ret.detail.title")}</h1>
        <Link href="/returns" className="button-link">{t("ret.my_returns")}</Link>
      </div>

      {actionError && <ErrorBanner message={uiErrorText(actionError, lang)} />}

      <div className="card" style={{ maxWidth: 560 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div style={{ fontWeight: 600 }}>{returnReasonLabel(data.reason, lang)}</div>
          <span className="badge badge-active">{returnStatusLabel(data.status, lang)}</span>
        </div>
        <div className="muted">{fmt(t("ret.submitted_at"), { date: date(data.created_at) })}</div>
        {data.reason_note && (
          <div style={{ marginTop: 8 }}>
            {t("ret.detail.your_note")} {data.reason_note}
          </div>
        )}
        <SizeGuideSnapshotNote snapshot={data.size_guide} />

        {data.status === "APPROVED_AWAITING_DROPOFF" && data.code && (
          // IX-P2: large digits + CODE128 bars, for the store's scanner or camera
          <ReturnCodeCard
            code={data.code}
            label={t(`ret.code.${data.desired_outcome}`)}
            hint={fmt(t(`ret.detail.code_hint.${data.desired_outcome}`), { date: date(data.code_expires_at) }).replace(/^-\s*/, "")}
          />
        )}

        {data.status === "REJECTED" && (
          <div className="error-banner" style={{ marginTop: 10 }}>
            <div>
              {t("ret.detail.rejection_reason")} {data.rejection_reason}
            </div>
            {canDispute && (
              <div className="muted" style={{ marginTop: 4 }}>
                {fmt(t("ret.detail.dispute_until"), { date: date(data.dispute_deadline_at) })}
              </div>
            )}
          </div>
        )}

        {data.status === "ADMIN_REJECTED" && (
          <div className="error-banner" style={{ marginTop: 10 }}>
            {t("ret.detail.admin_rejected")} {data.rejection_reason}
          </div>
        )}

        {data.status === "ESCALATED" && (
          <div className="muted" style={{ marginTop: 10 }}>
            {t("ret.detail.escalated")}
          </div>
        )}

        {data.status === "RECEIVED" || data.status === "REFUND_PROCESSING" ? (
          <div className="muted" style={{ marginTop: 10 }}>
            {fmt(t("ret.detail.received"), { date: date(data.received_at) })}
          </div>
        ) : null}

        {data.status === "REFUNDED" && (
          <div className="notice-banner" style={{ marginTop: 10 }}>
            {t("ret.detail.refunded")}
          </div>
        )}

        {data.status === "EXCHANGED" && (
          <div className="notice-banner" style={{ marginTop: 10 }}>
            {fmt(t("ret.detail.exchanged"), { date: date(data.received_at) })}
            {data.settlement && data.settlement.direction === "COLLECT_CASH" && (
              <> {fmt(t("ret.detail.paid"), { amount: formatMoney(data.settlement.net_amount, lang) })}</>
            )}
            {data.settlement && data.settlement.direction === "REFUND_CASH" && (
              <> {fmt(t("ret.detail.refunded_cash"), { amount: formatMoney(data.settlement.net_amount, lang) })}</>
            )}
            {data.settlement && data.settlement.direction === "NONE" && <> {t("ret.no_difference")}</>}
          </div>
        )}

        {data.status === "EXPIRED" && (
          <div className="muted" style={{ marginTop: 10 }}>
            {t(`ret.detail.expired.${data.desired_outcome}`)}
          </div>
        )}

        {canCancel && (
          <button className="button button-secondary" style={{ marginTop: 12 }} disabled={busy} onClick={() => act("cancel")}>
            {t("ret.detail.cancel")}
          </button>
        )}
        {canDispute && (
          <button className="button" style={{ marginTop: 12 }} disabled={busy} onClick={() => act("dispute")}>
            {t("ret.detail.dispute")}
          </button>
        )}
      </div>
    </div>
  );
}
