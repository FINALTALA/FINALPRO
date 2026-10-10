"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch } from "@/lib/api";
import { useHydrated, useSessionToken } from "@/lib/useSession";
import {
  RETURN_REASON_LABEL,
  RETURN_STATUS_LABEL,
  formatDateTime,
  returnErrorMessage,
} from "@/lib/returns";

interface ReturnListRow {
  id: string;
  status: string;
  reason: string;
  code: string | null;
  branch_order_id: string;
  title_ar: string;
  title_en: string;
  created_at: string;
}

// Sprint 21 (review-round point 1): the customer's own cross-order
// returns list - GET /customers/me/returns - so "this item already has
// a return, track it here" is discoverable without remembering a
// returnId, same reasoning as the /orders page's own grouping.
export default function ReturnsListPage() {
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const [rows, setRows] = useState<ReturnListRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hydrated) return;
    if (!token) {
      router.replace("/login?next=/returns");
      return;
    }
    apiFetch<ReturnListRow[]>("/customers/me/returns")
      .then(setRows)
      .catch((err) => setError(returnErrorMessage(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, token]);

  if (!hydrated || (!token && !error)) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 720 }} />
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="top-bar">
        <h1 className="page-title" style={{ margin: 0 }}>إرجاعاتي</h1>
        <Link href="/orders" className="button-link">طلباتي</Link>
      </div>

      {error && <ErrorBanner message={error} />}

      {!rows && !error && (
        <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 720 }} />
      )}

      {rows && rows.length === 0 && (
        <EmptyState
          title="لا توجد طلبات إرجاع"
          message="يمكنك طلب إرجاع منتج من صفحة طلباتي بعد استلامه."
          actionHref="/orders"
          actionLabel="طلباتي"
        />
      )}

      {rows && rows.length > 0 && (
        <div style={{ maxWidth: 720, width: "100%", display: "flex", flexDirection: "column", gap: 10 }}>
          {rows.map((r) => (
            <Link key={r.id} href={`/returns/${r.id}`} className="card" style={{ display: "block" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div style={{ fontWeight: 600 }}>{r.title_ar || r.title_en}</div>
                <span className="badge badge-active">{RETURN_STATUS_LABEL[r.status] ?? r.status}</span>
              </div>
              <div className="muted">
                {RETURN_REASON_LABEL[r.reason] ?? r.reason} · {formatDateTime(r.created_at)}
              </div>
              {r.code && <div style={{ fontWeight: 600, marginTop: 4 }}>كود الإرجاع: {r.code}</div>}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
