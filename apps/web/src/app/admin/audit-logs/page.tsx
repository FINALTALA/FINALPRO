"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { ApiError, apiFetch } from "@/lib/api";
import { adminErrorMessage, formatDateTime, isForbidden } from "@/lib/admin";
import { getSessionToken } from "@/lib/session";
import { useAdminGate } from "@/lib/useAdminGate";

interface AuditLogRow {
  id: string;
  occurred_at: string;
  actor_id: string | null;
  correlation_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  summary: string | null;
}

interface AuditLogPage {
  items: AuditLogRow[];
  next_cursor: string | null;
}

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api/v1";

function downloadText(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

interface Filters {
  entity_type: string;
  entity_id: string;
  actor_id: string;
  action: string;
  correlation_id: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = {
  entity_type: "",
  entity_id: "",
  actor_id: "",
  action: "",
  correlation_id: "",
  from: "",
  to: "",
};

function buildQuery(filters: Filters, extra: Record<string, string>): string {
  const qs = new URLSearchParams(extra);
  if (filters.entity_type.trim()) qs.set("entity_type", filters.entity_type.trim());
  if (filters.entity_id.trim()) qs.set("entity_id", filters.entity_id.trim());
  if (filters.actor_id.trim()) qs.set("actor_id", filters.actor_id.trim());
  if (filters.action.trim()) qs.set("action", filters.action.trim());
  if (filters.correlation_id.trim()) qs.set("correlation_id", filters.correlation_id.trim());
  if (filters.from) qs.set("from", new Date(filters.from).toISOString());
  if (filters.to) qs.set("to", new Date(filters.to).toISOString());
  return qs.toString();
}

// Sprint 25 (FR-ADMIN-005): PLATFORM_ADMIN-only search/export over the
// full AuditLog table. Every filter maps 1:1 to the API's own query
// params; the export button re-sends the exact same filters so "what
// you see is what you export" - never a separate, driftable query.
export default function AdminAuditLogsPage() {
  const gate = useAdminGate("ADMIN");
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [items, setItems] = useState<AuditLogRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const fetchPage = useCallback(
    (after: string | null) => {
      const qs = buildQuery(filters, after ? { limit: "50", cursor: after } : { limit: "50" });
      return apiFetch<AuditLogPage>(`/admin/audit-logs?${qs}`);
    },
    [filters],
  );

  useEffect(() => {
    if (gate.status !== "ok") return;
    let cancelled = false;
    fetchPage(null)
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setCursor(page.next_cursor);
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
  }, [gate.status, fetchPage]);

  function runFilters(next: Filters) {
    setLoading(true);
    setItems([]);
    setCursor(null);
    setError(null);
    setFilters(next);
  }

  function applyFilters(e: FormEvent) {
    e.preventDefault();
    runFilters(draft);
  }

  // Review round: one click shows every row written while serving the
  // same request (Part 4, H.1's correlation id).
  function showRequest(correlationId: string) {
    const next = { ...EMPTY_FILTERS, correlation_id: correlationId };
    setDraft(next);
    runFilters(next);
  }

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(cursor);
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.next_cursor);
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  }

  async function exportCsv() {
    setExporting(true);
    setError(null);
    try {
      const qs = buildQuery(filters, {});
      const token = getSessionToken();
      const res = await fetch(`${API_BASE_URL}/admin/audit-logs/export?${qs}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const text = await res.text();
        const parsed = text ? JSON.parse(text) : {};
        throw new ApiError(
          res.status,
          parsed?.error?.code ?? "UNKNOWN_ERROR",
          parsed?.error?.message ?? "Something went wrong",
        );
      }
      const csv = await res.text();
      downloadText("audit-logs.csv", csv, "text/csv;charset=utf-8");
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setExporting(false);
    }
  }

  if (gate.status === "loading") {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 1100 }} />
      </div>
    );
  }
  if (gate.status === "forbidden" || forbidden) {
    return (
      <div className="page-shell">
        <EmptyState title="هذه الصفحة لمدير المنصة فقط" actionHref="/account" actionLabel="حسابي" />
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 1100 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>سجل التدقيق</h1>
          <Link href="/admin" className="button-link">إدارة المنصة</Link>
        </div>

        <form onSubmit={applyFilters} style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
          <input
            aria-label="نوع الكيان"
            placeholder="نوع الكيان (مثل BranchOrder)"
            value={draft.entity_type}
            onChange={(e) => setDraft({ ...draft, entity_type: e.target.value })}
            style={{ minWidth: 150 }}
          />
          <input
            aria-label="معرّف الكيان"
            placeholder="معرّف الكيان"
            value={draft.entity_id}
            onChange={(e) => setDraft({ ...draft, entity_id: e.target.value })}
            style={{ minWidth: 150 }}
          />
          <input
            aria-label="معرّف الفاعل"
            placeholder="معرّف الفاعل (المستخدم)"
            value={draft.actor_id}
            onChange={(e) => setDraft({ ...draft, actor_id: e.target.value })}
            style={{ minWidth: 150 }}
          />
          <input
            aria-label="الإجراء"
            placeholder="الإجراء (مثل branch_order.status_changed)"
            value={draft.action}
            onChange={(e) => setDraft({ ...draft, action: e.target.value })}
            style={{ minWidth: 220 }}
          />
          <input
            aria-label="معرّف الطلب (correlation id)"
            placeholder="معرّف الطلب (correlation id)"
            value={draft.correlation_id}
            onChange={(e) => setDraft({ ...draft, correlation_id: e.target.value })}
            dir="ltr"
            style={{ minWidth: 220 }}
          />
          <input
            aria-label="من تاريخ"
            type="datetime-local"
            value={draft.from}
            onChange={(e) => setDraft({ ...draft, from: e.target.value })}
          />
          <input
            aria-label="إلى تاريخ"
            type="datetime-local"
            value={draft.to}
            onChange={(e) => setDraft({ ...draft, to: e.target.value })}
          />
          <button className="button" type="submit">تصفية</button>
          <button
            className="button button-secondary"
            type="button"
            onClick={() => {
              setDraft(EMPTY_FILTERS);
              setLoading(true);
              setItems([]);
              setCursor(null);
              setError(null);
              setFilters(EMPTY_FILTERS);
            }}
          >
            إلغاء التصفية
          </button>
          <button
            className="button-link"
            type="button"
            onClick={exportCsv}
            disabled={exporting}
            style={{ marginInlineStart: "auto" }}
          >
            {exporting ? "جارٍ التصدير..." : "تصدير CSV"}
          </button>
        </form>

        {error && <ErrorBanner message={error} />}
        {loading && (
          <div aria-busy="true" aria-label="جارٍ التحميل">
            <div className="skeleton" style={{ height: 56, width: "100%", marginBottom: 8 }} />
            <div className="skeleton" style={{ height: 56, width: "100%" }} />
          </div>
        )}
        {!loading && !error && items.length === 0 && (
          <EmptyState title="لا توجد سجلات مطابقة" message="غيّري شروط التصفية." />
        )}
        {!loading && items.length > 0 && (
          <>
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>الوقت</th>
                    <th>الإجراء</th>
                    <th>نوع الكيان</th>
                    <th>معرّف الكيان</th>
                    <th>الفاعل</th>
                    <th>معرّف الطلب</th>
                    <th>الملخّص</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => (
                    <tr key={row.id}>
                      <td>{formatDateTime(row.occurred_at)}</td>
                      <td>{row.action}</td>
                      <td>{row.entity_type}</td>
                      <td style={{ fontFamily: "monospace", fontSize: 12 }}>{row.entity_id}</td>
                      <td style={{ fontFamily: "monospace", fontSize: 12 }}>{row.actor_id ?? "-"}</td>
                      <td>
                        <button
                          type="button"
                          className="button-link"
                          style={{ fontFamily: "monospace", fontSize: 12, padding: 0 }}
                          title="عرض كل سجلات هذا الطلب"
                          onClick={() => showRequest(row.correlation_id)}
                        >
                          {row.correlation_id}
                        </button>
                      </td>
                      <td>{row.summary ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {cursor && (
              <div style={{ marginTop: 14 }}>
                <button className="button button-secondary" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? "جارٍ التحميل..." : "تحميل المزيد"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
