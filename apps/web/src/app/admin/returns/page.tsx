"use client";

import Link from "next/link";
import { useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch, newIdempotencyKey } from "@/lib/api";
import {
  RETURN_REASON_LABEL,
  RETURN_STATUS_LABEL,
  formatDateTime,
  returnErrorMessage,
} from "@/lib/returns";
import { useAdminGate } from "@/lib/useAdminGate";
import { useFetch } from "@/lib/useFetch";

interface EscalatedReturn {
  id: string;
  status: string;
  reason: string;
  reason_note: string | null;
  photo_urls: string[];
  rejection_reason: string | null;
  escalated_at: string | null;
}

function EscalationRow({ r, onDone }: { r: EscalatedReturn; onDone: () => void }) {
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
      setError(returnErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ maxWidth: "none" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontWeight: 600 }}>{RETURN_REASON_LABEL[r.reason] ?? r.reason}</div>
        <span className="badge badge-active">{RETURN_STATUS_LABEL[r.status] ?? r.status}</span>
      </div>
      <div className="muted">تصاعد في {formatDateTime(r.escalated_at)}</div>
      {r.reason_note && <div style={{ marginTop: 6 }}>ملاحظة العميل: {r.reason_note}</div>}
      <div className="muted" style={{ marginTop: 4 }}>سبب رفض المتجر: {r.rejection_reason}</div>
      {r.photo_urls.length > 0 && (
        <div className="muted" style={{ marginTop: 4 }}>{r.photo_urls.length} صورة مرفقة</div>
      )}

      {error && <ErrorBanner message={error} />}

      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        {!rejecting ? (
          <div style={{ display: "flex", gap: 8 }}>
            <button className="button" disabled={busy} onClick={() => decide("approve")}>
              اعتماد الإرجاع
            </button>
            <button
              className="button button-secondary"
              disabled={busy}
              onClick={() => setRejecting(true)}
            >
              رفض نهائي
            </button>
          </div>
        ) : (
          <>
            <textarea
              rows={3}
              placeholder="سبب الرفض النهائي (10 أحرف على الأقل)"
              value={reason}
              disabled={busy}
              onChange={(e) => setReason(e.target.value)}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button className="button" disabled={busy} onClick={() => decide("reject")}>
                تأكيد الرفض النهائي
              </button>
              <button className="button-link" disabled={busy} onClick={() => setRejecting(false)}>
                تراجع
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
// resubmittable, unlike the store's own REJECTED.
export default function AdminReturnsPage() {
  const gate = useAdminGate("ADMIN");
  const [nonce, setNonce] = useState(0);
  const path = gate.status === "ok" ? `/admin/returns?r=${nonce}` : null;
  const { data, error, loading } = useFetch<EscalatedReturn[]>(path, true);

  if (gate.status === "loading") {
    return <div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 800 }} />;
  }
  if (gate.status === "forbidden") {
    return (
      <EmptyState
        title="هذه الصفحة لمدير المنصة فقط"
        actionHref="/account"
        actionLabel="حسابي"
      />
    );
  }

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 800 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>الإرجاعات المتصاعدة</h1>
          <Link href="/admin" className="button-link">لوحة الإدارة</Link>
        </div>

        {loading && (
          <div aria-busy="true" aria-label="جارٍ التحميل">
            <div className="skeleton" style={{ height: 160, width: "100%" }} />
          </div>
        )}
        {error && <ErrorBanner message={error} />}
        {data && data.length === 0 && (
          <EmptyState title="لا توجد إرجاعات معلَّقة لمراجعتك حالياً" />
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
