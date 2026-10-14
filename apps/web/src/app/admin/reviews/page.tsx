"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch, newIdempotencyKey } from "@/lib/api";
import { adminErrorMessage, formatDateTime, isForbidden } from "@/lib/admin";
import { useAdminGate } from "@/lib/useAdminGate";

interface PendingReport {
  id: string;
  reason: string;
  created_at: string;
}

interface ReportedReview {
  id: string;
  target_type: "PRODUCT" | "STORE";
  rating: number;
  body: string;
  author: string;
  created_at: string;
  pending_reports: PendingReport[];
}

// Sprint 23 (PDR-032, EPIC-REV): the PLATFORM_ADMIN moderation queue -
// every review with at least one PENDING report, dismiss/uphold.
// Mirrors admin/verification/page.tsx's own useAdminGate convention.
export default function AdminReviewsPage() {
  const gate = useAdminGate("ADMIN");
  const [items, setItems] = useState<ReportedReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    return apiFetch<ReportedReview[]>("/admin/reviews/reported");
  }, []);

  useEffect(() => {
    if (gate.status !== "ok") return;
    let cancelled = false;
    load()
      .then((rows) => {
        if (cancelled) return;
        setItems(rows);
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        if (isForbidden(err)) setForbidden(true);
        setError(adminErrorMessage(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [gate.status, load]);

  async function decide(reviewId: string, decision: "dismiss" | "uphold") {
    setBusyId(reviewId);
    setError(null);
    try {
      await apiFetch(`/admin/reviews/${reviewId}/decision`, {
        method: "PATCH",
        body: { decision },
        idempotencyKey: newIdempotencyKey("review-decision"),
      });
      setItems((prev) => prev.filter((r) => r.id !== reviewId));
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
  if (gate.status === "forbidden" || forbidden) {
    return (
      <div className="page-shell">
        <EmptyState title="هذه الصفحة لموظفي المنصة فقط" actionHref="/account" actionLabel="حسابي" />
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 1000 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>بلاغات المراجعات</h1>
          <Link href="/admin" className="button-link">إدارة المنصة</Link>
        </div>

        {error && <ErrorBanner message={error} />}
        {loading && (
          <div aria-busy="true" aria-label="جارٍ التحميل">
            <div className="skeleton" style={{ height: 56, width: "100%", marginBottom: 8 }} />
            <div className="skeleton" style={{ height: 56, width: "100%" }} />
          </div>
        )}
        {!loading && !error && items.length === 0 && (
          <EmptyState title="لا توجد مراجعات عليها بلاغات معلَّقة" />
        )}
        {!loading && items.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {items.map((r) => (
              <div key={r.id} className="card">
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <strong>{r.author}</strong>
                  <span>{r.rating} / 5 - {r.target_type === "PRODUCT" ? "منتج" : "متجر"}</span>
                </div>
                <p style={{ marginTop: 6 }}>{r.body}</p>
                <div className="muted" style={{ fontSize: 13 }}>{formatDateTime(r.created_at)}</div>

                <div style={{ marginTop: 8 }}>
                  <div className="muted">البلاغات ({r.pending_reports.length}):</div>
                  <ul>
                    {r.pending_reports.map((p) => (
                      <li key={p.id}>
                        {p.reason} <span className="muted">({formatDateTime(p.created_at)})</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button
                    className="button button-secondary"
                    disabled={busyId === r.id}
                    onClick={() => void decide(r.id, "dismiss")}
                  >
                    تجاهل البلاغ
                  </button>
                  <button
                    className="button"
                    disabled={busyId === r.id}
                    onClick={() => void decide(r.id, "uphold")}
                  >
                    إخفاء المراجعة
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
