"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
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
  returnReasonLabel,
  returnStatusLabel,
  uiErrorText,
} from "@/lib/returns";
import { useHydrated, useSessionToken } from "@/lib/useSession";
import SizeGuideSnapshotNote from "@/components/SizeGuideSnapshotNote";
import type { SizeGuideSnapshot } from "@/lib/sizeGuides";
import { loginRedirectHref } from "@/lib/loginRedirect";

interface ReturnRow {
  id: string;
  status: string;
  reason: string;
  reason_note: string | null;
  photo_urls: string[];
  created_at: string;
  desired_outcome: "RETURN" | "EXCHANGE";
  size_guide?: SizeGuideSnapshot | null;
}

function DecisionRow({
  vendorId,
  branchId,
  r,
  onDone,
}: {
  vendorId: string;
  branchId: string;
  r: ReturnRow;
  onDone: () => void;
}) {
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
      await apiFetch(
        `/vendors/${vendorId}/branches/${branchId}/returns/${r.id}/decision`,
        {
          method: "PATCH",
          body:
            decision === "approve"
              ? { decision }
              : { decision, rejection_reason: reason.trim() },
          idempotencyKey: newIdempotencyKey("return-decision"),
        },
      );
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
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontWeight: 600 }}>
          {returnReasonLabel(r.reason, lang)}
          {r.desired_outcome === "EXCHANGE" && (
            <span className="muted" style={{ marginInlineStart: 8 }}>{t("ret.exchange_request_tag")}</span>
          )}
        </div>
        <span className="badge badge-active">{returnStatusLabel(r.status, lang)}</span>
      </div>
      <div className="muted">{fmt(t("ret.submitted_at"), { date: formatDateTime(r.created_at, lang) })}</div>
      {/* The customer's own note, as written. */}
      {r.reason_note && <div style={{ marginTop: 6 }}>{r.reason_note}</div>}
      <SizeGuideSnapshotNote snapshot={r.size_guide} />
      {r.photo_urls.length > 0 && (
        <div className="muted" style={{ marginTop: 4 }}>{fmt(t("ret.photos"), { n: r.photo_urls.length })}</div>
      )}

      {error && <ErrorBanner message={uiErrorText(error, lang)} />}

      {r.status === "REQUESTED" && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          {!rejecting ? (
            <div style={{ display: "flex", gap: 8 }}>
              <button className="button" disabled={busy} onClick={() => decide("approve")}>
                {t("ret.branch.approve")}
              </button>
              <button
                className="button button-secondary"
                disabled={busy}
                onClick={() => setRejecting(true)}
              >
                {t("ret.branch.reject")}
              </button>
            </div>
          ) : (
            <>
              <textarea
                rows={3}
                placeholder={t("ret.branch.reject_placeholder")}
                value={reason}
                disabled={busy}
                onChange={(e) => setReason(e.target.value)}
              />
              <div style={{ display: "flex", gap: 8 }}>
                <button className="button" disabled={busy} onClick={() => decide("reject")}>
                  {t("ret.branch.confirm_reject")}
                </button>
                <button
                  className="button-link"
                  disabled={busy}
                  onClick={() => setRejecting(false)}
                >
                  {t("ret.back")}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Sprint 21 (FR-RET-002, review-round point 1): the branch-scoped
// returns queue - decisions stay with the ORIGINATING branch only
// (see BranchReturnsController's own comment for why redeem, unlike
// this, is vendor-wide). TB-16.2: Arabic and English.
export default function BranchReturnsPage() {
  const params = useParams<{ vendorId: string; branchId: string }>();
  const router = useRouter();
  const lang = useLang();
  const t = useT();
  const onExpired = useSessionExpiredRedirect();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const [rows, setRows] = useState<ReturnRow[] | null>(null);
  const [error, setError] = useState<UiError | null>(null);

  function load() {
    apiFetch<ReturnRow[]>(`/vendors/${params.vendorId}/branches/${params.branchId}/returns`)
      .then((data) => {
        setError(null);
        setRows(data);
      })
      .catch((err) => (isUnauthorized(err) ? onExpired() : setError({ api: err })));
  }

  useEffect(() => {
    if (!hydrated) return;
    if (!token) {
      router.replace(
        loginRedirectHref(),
      );
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, token, params.vendorId, params.branchId]);

  if (!hydrated || !token) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 720 }} />
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="top-bar">
        <h1 className="page-title" style={{ margin: 0 }}>{t("ret.branch.title")}</h1>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          <Link href={`/vendor/${params.vendorId}/branches/${params.branchId}`} className="button-link">{t("ret.branch.workspace")}</Link>
          <Link href={`/vendor/${params.vendorId}/branches/${params.branchId}/orders`} className="button-link">{t("ret.branch.orders")}</Link>
          <Link href={`/vendor/${params.vendorId}/branches/${params.branchId}/stock`} className="button-link">{t("ret.branch.stock")}</Link>
          <Link href="/notifications" className="button-link">{t("ret.branch.notifications")}</Link>
        </div>
      </div>
      {error && <ErrorBanner message={uiErrorText(error, lang)} />}
      {!rows && !error && (
        <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 720 }} />
      )}
      {rows && rows.length === 0 && (
        <EmptyState title={t("ret.branch.empty")} />
      )}
      {rows && rows.length > 0 && (
        <div style={{ maxWidth: 720, width: "100%", display: "flex", flexDirection: "column", gap: 10 }}>
          {rows.map((r) => (
            <DecisionRow
              key={r.id}
              vendorId={params.vendorId}
              branchId={params.branchId}
              r={r}
              onDone={load}
            />
          ))}
        </div>
      )}
    </div>
  );
}
