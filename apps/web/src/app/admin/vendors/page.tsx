"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch } from "@/lib/api";
import {
  STORE_TYPE_LABEL,
  VENDOR_STATUS_LABEL,
  adminErrorMessage,
  formatDateTime,
  isForbidden,
} from "@/lib/admin";
import { useAdminGate } from "@/lib/useAdminGate";

interface VendorRow {
  id: string;
  legal_name: string;
  store_type: string;
  status: string;
  created_at: string;
  is_member: boolean;
}

interface VendorPage {
  items: VendorRow[];
  next_cursor: string | null;
}

const STATUSES = Object.keys(VENDOR_STATUS_LABEL);

// Sprint 16 (FR-VEND-009, G-AD-02): the platform admin's vendor list -
// the entry point to suspend / reactivate a store. PLATFORM_ADMIN only.
export default function AdminVendorsPage() {
  const gate = useAdminGate("ADMIN");
  const [status, setStatus] = useState("");
  const [draftQuery, setDraftQuery] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<VendorRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const fetchPage = useCallback(
    (after: string | null) => {
      const qs = new URLSearchParams({ limit: "20" });
      if (status) qs.set("status", status);
      if (query) qs.set("q", query);
      if (after) qs.set("cursor", after);
      return apiFetch<VendorPage>(`/admin/vendors?${qs.toString()}`);
    },
    [status, query],
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

  function applyFilters(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setItems([]);
    setCursor(null);
    setError(null);
    setQuery(draftQuery.trim());
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
        <EmptyState title="هذه الصفحة لمدير المنصة فقط" actionHref="/account" actionLabel="حسابي" />
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 1000 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>المتاجر</h1>
          <Link href="/admin" className="button-link">إدارة المنصة</Link>
        </div>

        <form onSubmit={applyFilters} style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
          <select
            aria-label="تصفية حسب الحالة"
            value={status}
            onChange={(e) => {
              setLoading(true);
              setItems([]);
              setCursor(null);
              setError(null);
              setStatus(e.target.value);
            }}
          >
            <option value="">كل الحالات</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{VENDOR_STATUS_LABEL[s]}</option>
            ))}
          </select>
          <input
            type="search"
            aria-label="بحث باسم المتجر"
            placeholder="ابحثي باسم المتجر (حرفان على الأقل)"
            value={draftQuery}
            onChange={(e) => setDraftQuery(e.target.value)}
            style={{ flex: 1, minWidth: 200 }}
          />
          <button className="button" type="submit">بحث</button>
        </form>

        {error && <ErrorBanner message={error} />}
        {loading && (
          <div aria-busy="true" aria-label="جارٍ التحميل">
            <div className="skeleton" style={{ height: 56, width: "100%", marginBottom: 8 }} />
            <div className="skeleton" style={{ height: 56, width: "100%" }} />
          </div>
        )}
        {!loading && !error && items.length === 0 && (
          <EmptyState title="لا توجد متاجر مطابقة" message="غيّري الحالة أو نص البحث." />
        )}
        {!loading && items.length > 0 && (
          <>
            <div style={{ overflowX: "auto" }}>
<table className="data-table">
              <thead>
                <tr>
                  <th>المتجر</th>
                  <th>النوع</th>
                  <th>الحالة</th>
                  <th>تاريخ الإنشاء</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((v) => (
                  <tr key={v.id}>
                    <td>
                      {v.legal_name}
                      {v.is_member && <span className="badge" style={{ marginInlineStart: 8 }}>أنتِ عضوة</span>}
                    </td>
                    <td>{STORE_TYPE_LABEL[v.store_type] ?? v.store_type}</td>
                    <td>
                      <span className={`badge${v.status === "ACTIVE" ? " badge-active" : ""}`}>
                        {VENDOR_STATUS_LABEL[v.status] ?? v.status}
                      </span>
                    </td>
                    <td>{formatDateTime(v.created_at)}</td>
                    <td>
                      <Link className="button-link" href={`/admin/vendors/${v.id}`}>التفاصيل</Link>
                    </td>
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
