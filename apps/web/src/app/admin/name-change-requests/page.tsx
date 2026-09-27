"use client";

import Link from "next/link";
import { useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch, newIdempotencyKey } from "@/lib/api";
import { adminErrorMessage, formatDateTime } from "@/lib/admin";
import { useAdminGate } from "@/lib/useAdminGate";
import { useFetch } from "@/lib/useFetch";

interface NameChangeRequest {
  id: string;
  canonical_product_id: string;
  vendor_id: string;
  requested_name_ar: string;
  requested_name_en: string;
  reason: string | null;
  status: string;
  created_at: string;
}

// Sprint 16 (FR-ADMIN-001, G-AD-03 partial): a screen over the EXISTING
// admin endpoints for canonical-product rename requests. It does not
// build any platform match-correction flow - there is no approved policy
// for that yet.
export default function NameChangeRequestsPage() {
  const gate = useAdminGate("ADMIN");
  const [nonce, setNonce] = useState(0);
  const requests = useFetch<NameChangeRequest[]>(
    gate.status === "ok" ? `/canonical-products/name-change-requests?r=${nonce}` : null,
    true,
  );
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function decide(id: string, decision: "approve" | "reject") {
    setBusyId(id);
    setError(null);
    setNotice(null);
    const note = (notes[id] ?? "").trim();
    try {
      await apiFetch(`/canonical-products/name-change-requests/${id}/decision`, {
        method: "POST",
        body: note ? { decision, note } : { decision },
        idempotencyKey: newIdempotencyKey("name-change-decision"),
      });
      setNotice(decision === "approve" ? "تم اعتماد الاسم الجديد." : "تم رفض الطلب.");
      setNonce((n) => n + 1);
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  if (gate.status === "loading") {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 1000 }} />
      </div>
    );
  }
  if (gate.status === "forbidden" || requests.status === 403) {
    return (
      <div className="page-shell">
        <EmptyState title="هذه الصفحة لمدير المنصة فقط" actionHref="/account" actionLabel="حسابي" />
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 1000 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>طلبات تغيير الاسم</h1>
          <Link href="/admin" className="button-link">إدارة المنصة</Link>
        </div>

        {(requests.error || error) && <ErrorBanner message={error ?? requests.error ?? ""} />}
        {notice && <div className="notice-banner" role="status">{notice}</div>}
        {requests.loading && !requests.data && (
          <div aria-busy="true" aria-label="جارٍ التحميل">
            <div className="skeleton" style={{ height: 120, width: "100%" }} />
          </div>
        )}
        {requests.data && requests.data.length === 0 && (
          <EmptyState title="لا توجد طلبات معلّقة" message="ستظهر هنا طلبات تغيير أسماء المنتجات الأساسية." />
        )}
        {requests.data && requests.data.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {requests.data.map((r) => (
              <div key={r.id} className="card" style={{ maxWidth: "none" }}>
                <p style={{ margin: "0 0 4px" }}>
                  <strong>{r.requested_name_ar}</strong> - <span dir="ltr">{r.requested_name_en}</span>
                </p>
                <p className="muted" style={{ margin: "0 0 8px" }}>
                  طُلب في {formatDateTime(r.created_at)}
                </p>
                {r.reason && <p style={{ whiteSpace: "pre-wrap" }}>{r.reason}</p>}
                <div className="field">
                  <label htmlFor={`note-${r.id}`}>ملاحظة (اختيارية)</label>
                  <textarea
                    id={`note-${r.id}`}
                    rows={2}
                    value={notes[r.id] ?? ""}
                    disabled={busyId !== null}
                    onChange={(e) => setNotes((prev) => ({ ...prev, [r.id]: e.target.value }))}
                  />
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="button" disabled={busyId !== null} onClick={() => decide(r.id, "approve")}>
                    اعتماد
                  </button>
                  <button
                    className="button button-secondary"
                    disabled={busyId !== null}
                    onClick={() => decide(r.id, "reject")}
                  >
                    رفض
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
