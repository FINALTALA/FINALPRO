"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch, newIdempotencyKey } from "@/lib/api";
import {
  RETURN_REASON_LABEL,
  RETURN_STATUS_LABEL,
  formatDateTime,
  returnErrorMessage,
} from "@/lib/returns";
import { useHydrated, useSessionToken } from "@/lib/useSession";

interface ReturnRow {
  id: string;
  status: string;
  reason: string;
  reason_note: string | null;
  photo_urls: string[];
  created_at: string;
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
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "approve" | "reject") {
    if (decision === "reject" && reason.trim().length < 10) {
      setError("سبب الرفض يجب أن يكون 10 أحرف على الأقل");
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
      setError(returnErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontWeight: 600 }}>{RETURN_REASON_LABEL[r.reason] ?? r.reason}</div>
        <span className="badge badge-active">{RETURN_STATUS_LABEL[r.status] ?? r.status}</span>
      </div>
      <div className="muted">قُدِّم في {formatDateTime(r.created_at)}</div>
      {r.reason_note && <div style={{ marginTop: 6 }}>{r.reason_note}</div>}
      {r.photo_urls.length > 0 && (
        <div className="muted" style={{ marginTop: 4 }}>{r.photo_urls.length} صورة مرفقة</div>
      )}

      {error && <ErrorBanner message={error} />}

      {r.status === "REQUESTED" && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          {!rejecting ? (
            <div style={{ display: "flex", gap: 8 }}>
              <button className="button" disabled={busy} onClick={() => decide("approve")}>
                اعتماد
              </button>
              <button
                className="button button-secondary"
                disabled={busy}
                onClick={() => setRejecting(true)}
              >
                رفض
              </button>
            </div>
          ) : (
            <>
              <textarea
                rows={3}
                placeholder="سبب الرفض (10 أحرف على الأقل)"
                value={reason}
                disabled={busy}
                onChange={(e) => setReason(e.target.value)}
              />
              <div style={{ display: "flex", gap: 8 }}>
                <button className="button" disabled={busy} onClick={() => decide("reject")}>
                  تأكيد الرفض
                </button>
                <button
                  className="button-link"
                  disabled={busy}
                  onClick={() => setRejecting(false)}
                >
                  تراجع
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
// this, is vendor-wide).
export default function BranchReturnsPage() {
  const params = useParams<{ vendorId: string; branchId: string }>();
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const [rows, setRows] = useState<ReturnRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    apiFetch<ReturnRow[]>(`/vendors/${params.vendorId}/branches/${params.branchId}/returns`)
      .then((data) => {
        setError(null);
        setRows(data);
      })
      .catch((err) => setError(returnErrorMessage(err)));
  }

  useEffect(() => {
    if (!hydrated) return;
    if (!token) {
      router.replace(
        `/login?next=/vendor/${params.vendorId}/branches/${params.branchId}/returns`,
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
        <h1 className="page-title" style={{ margin: 0 }}>طلبات الإرجاع</h1>
        <Link href={`/vendor/${params.vendorId}/branches`} className="button-link">الفروع</Link>
      </div>
      {error && <ErrorBanner message={error} />}
      {!rows && !error && (
        <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 720 }} />
      )}
      {rows && rows.length === 0 && (
        <EmptyState title="لا توجد طلبات إرجاع لهذا الفرع" />
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
