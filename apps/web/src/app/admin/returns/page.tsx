"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch, newIdempotencyKey } from "@/lib/api";
import { isUnauthorized } from "@/lib/apiErrors";
import { useLang, useT } from "@/lib/useLang";
import { useSessionExpiredRedirect } from "@/lib/useSessionExpiredRedirect";
import {
  type UiError,
  fmt,
  formatDateTime,
  returnErrorMessage,
  returnReasonLabel,
  returnStatusLabel,
  uiErrorText,
} from "@/lib/returns";
import { useAdminGate } from "@/lib/useAdminGate";
import { useFetch } from "@/lib/useFetch";
import SizeGuideSnapshotNote from "@/components/SizeGuideSnapshotNote";
import type { SizeGuideSnapshot } from "@/lib/sizeGuides";

interface EscalatedReturn {
  id: string;
  status: string;
  reason: string;
  reason_note: string | null;
  photo_urls: string[];
  rejection_reason: string | null;
  escalated_at: string | null;
  desired_outcome: "RETURN" | "EXCHANGE";
  size_guide?: SizeGuideSnapshot | null;
}

function EscalationRow({ r, onDone }: { r: EscalatedReturn; onDone: () => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const lang = useLang();
  const t = useT();
  const onExpired = useSessionExpiredRedirect();

  async function decide(decision: "approve" | "reject") {
    if (decision === "reject" && reason.trim().length < 10) {
      setError({ key: "ret.reject_too_short" });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/admin/returns/${r.id}/escalation-decision`, {
        method: "PATCH",
        body:
          decision === "approve"
            ? { decision }
            : { decision, rejection_reason: reason.trim() },
        idempotencyKey: newIdempotencyKey("return-escalation-decision"),
      });
      onDone();
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
    <div className="card" style={{ maxWidth: "none" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontWeight: 600 }}>
          {returnReasonLabel(r.reason, lang)}
          {r.desired_outcome === "EXCHANGE" && (
            <span className="muted" style={{ marginInlineStart: 8 }}>{t("ret.exchange_request_tag")}</span>
          )}
        </div>
        <span className="badge badge-active">{returnStatusLabel(r.status, lang)}</span>
      </div>
      <div className="muted">{fmt(t("ret.admin.escalated_at"), { date: formatDateTime(r.escalated_at, lang) })}</div>
      {/* The customer's note and the store's reason, as written. */}
      {r.reason_note && (
        <div style={{ marginTop: 6 }}>
          {t("ret.admin.customer_note")} {r.reason_note}
        </div>
      )}
      <SizeGuideSnapshotNote snapshot={r.size_guide} />
      <div className="muted" style={{ marginTop: 4 }}>
        {t("ret.admin.store_reason")} {r.rejection_reason}
      </div>
      {r.photo_urls.length > 0 && (
        <div className="muted" style={{ marginTop: 4 }}>{fmt(t("ret.photos"), { n: r.photo_urls.length })}</div>
      )}

      {error && <ErrorBanner message={uiErrorText(error, lang)} />}

      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        {!rejecting ? (
          <div style={{ display: "flex", gap: 8 }}>
            <button className="button" disabled={busy} onClick={() => decide("approve")}>
              {t(`ret.admin.approve.${r.desired_outcome}`)}
            </button>
            <button
              className="button button-secondary"
              disabled={busy}
              onClick={() => setRejecting(true)}
            >
              {t("ret.admin.final_reject")}
            </button>
          </div>
        ) : (
          <>
            <textarea
              rows={3}
              placeholder={t("ret.admin.final_placeholder")}
              value={reason}
              disabled={busy}
              onChange={(e) => setReason(e.target.value)}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button className="button" disabled={busy} onClick={() => decide("reject")}>
                {t("ret.admin.confirm_final")}
              </button>
              <button className="button-link" disabled={busy} onClick={() => setRejecting(false)}>
                {t("ret.back")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Sprint 21 (PDR-031 escalation, review-round point 1): the Return
// state machine's own break-glass queue - PLATFORM_ADMIN only, same
// authorization shape as AdminBranchOrdersController's forced-cancel.
// A reject here is ADMIN_REJECTED - final, never disputable or
// resubmittable, unlike the store's own REJECTED. TB-16.2: Arabic and
// English.
export default function AdminReturnsPage() {
  // TB-16.1: a failed workspaces read (429, 5xx, network) is shown as that
  // failure - not as "this page is for platform administrators only".
  const gate = useAdminGate("ADMIN", { reportErrors: true });
  const [nonce, setNonce] = useState(0);
  const path = gate.status === "ok" ? `/admin/returns?r=${nonce}` : null;
  const { data, loading, status, apiError } = useFetch<EscalatedReturn[]>(path, true);
  const lang = useLang();
  const t = useT();
  const onExpired = useSessionExpiredRedirect();
  // TB-16.1: an expired session goes to sign-in, back to this page.
  useEffect(() => {
    if (status === 401) onExpired();
  }, [status, onExpired]);

  if (gate.status === "loading") {
    return <div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 800 }} />;
  }
  if (gate.status === "error") {
    return (
      <div className="page-shell">
        <ErrorBanner message={returnErrorMessage(gate.error, lang)} />
      </div>
    );
  }
  if (gate.status === "forbidden") {
    return (
      <EmptyState
        title={t("ret.admin.forbidden")}
        actionHref="/account"
        actionLabel={t("ret.my_account")}
      />
    );
  }

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 800 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>{t("ret.admin.title")}</h1>
          <Link href="/admin" className="button-link">{t("ret.admin.dashboard")}</Link>
        </div>

        {loading && (
          <div aria-busy="true" aria-label={t("ret.loading")}>
            <div className="skeleton" style={{ height: 160, width: "100%" }} />
          </div>
        )}
        {apiError != null && status !== 401 && <ErrorBanner message={returnErrorMessage(apiError, lang)} />}
        {data && data.length === 0 && (
          <EmptyState title={t("ret.admin.empty")} />
        )}
        {data && data.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {data.map((r) => (
              <EscalationRow key={r.id} r={r} onDone={() => setNonce((n) => n + 1)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
