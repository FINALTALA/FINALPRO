"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch } from "@/lib/api";
import {
  KIND_LABEL,
  STORE_TYPE_LABEL,
  VERIFICATION_STATUS_LABEL,
  formatDateTime,
  isForbidden,
} from "@/lib/admin";
import { adminDirectoryError, adminDirectoryLabel } from "@/lib/adminStoreVerificationText";
import { useLang, useT } from "@/lib/useLang";
import { useAdminGate } from "@/lib/useAdminGate";

interface QueueItem {
  kind: "BRANCH" | "WAREHOUSE";
  item_id: string;
  vendor_id: string;
  legal_name: string;
  store_type: string;
  submitted_at: string;
  branch_name?: string | null;
  status?: string;
  reviewed_at?: string | null;
}

interface QueuePage {
  items: QueueItem[];
  next_cursor: string | null;
}

type Tab = "pending" | "decided";

// Sprint 16 (FR-VEND-003, G-AD-01): the reviewer's queue. Shows summaries
// only - no coordinates, photo or address ever appear in this list; they
// are released one item at a time, audited, on the detail page.
export default function VerificationQueuePage() {
  const t = useT();
  const lang = useLang();
  const gate = useAdminGate();
  const [tab, setTab] = useState<Tab>("pending");
  const [items, setItems] = useState<QueueItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<{ cause: unknown } | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const fetchPage = useCallback(async (which: Tab, after: string | null) => {
    const qs = new URLSearchParams({ status: which, limit: "20" });
    if (after) qs.set("cursor", after);
    return apiFetch<QueuePage>(`/admin/verification-queue?${qs.toString()}`);
  }, []);

  useEffect(() => {
    if (gate.status !== "ok") return;
    let cancelled = false;
    fetchPage(tab, null)
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
        setError({ cause: err });
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [gate.status, tab, fetchPage]);

  function switchTab(next: Tab) {
    if (next === tab) return;
    setItems([]);
    setCursor(null);
    setError(null);
    setLoading(true);
    setTab(next);
  }

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(tab, cursor);
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.next_cursor);
    } catch (err) {
      setError({ cause: err });
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
        <EmptyState title={t("adminDirectory.verification.forbidden")} actionHref="/account" actionLabel={t("adminDirectory.shared.account")} />
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 1000 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>{t("adminDirectory.verification.title")}</h1>
          <Link href="/admin" className="button-link">{t("adminDirectory.shared.dashboard")}</Link>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 14 }} role="tablist">
          <button
            role="tab"
            aria-selected={tab === "pending"}
            className={`button${tab === "pending" ? "" : " button-secondary"}`}
            onClick={() => switchTab("pending")}
          >
            {t("adminDirectory.verification.pending")}
          </button>
          <button
            role="tab"
            aria-selected={tab === "decided"}
            className={`button${tab === "decided" ? "" : " button-secondary"}`}
            onClick={() => switchTab("decided")}
          >
            {t("adminDirectory.verification.decided")}
          </button>
        </div>

        {error && <ErrorBanner message={adminDirectoryError(lang, error.cause)} />}
        {loading && (
          <div aria-busy="true" aria-label={t("adminDirectory.shared.loading")}>
            <div className="skeleton" style={{ height: 56, width: "100%", marginBottom: 8 }} />
            <div className="skeleton" style={{ height: 56, width: "100%", marginBottom: 8 }} />
            <div className="skeleton" style={{ height: 56, width: "100%" }} />
          </div>
        )}
        {!loading && !error && items.length === 0 && (
          <EmptyState
            title={tab === "pending" ? t("adminDirectory.verification.pendingEmpty") : t("adminDirectory.verification.decidedEmpty")}
            message={tab === "pending" ? t("adminDirectory.verification.pendingHint") : undefined}
          />
        )}
        {!loading && items.length > 0 && (
          <>
            <div style={{ overflowX: "auto" }}>
<table className="data-table">
              <thead>
                <tr>
                  <th>{t("adminDirectory.verification.kind")}</th>
                  <th>{t("adminDirectory.shared.store")}</th>
                  <th>{t("adminDirectory.verification.storeType")}</th>
                  <th>{t("adminDirectory.verification.submitted")}</th>
                  {tab === "decided" && <th>{t("adminDirectory.shared.status")}</th>}
                  {tab === "decided" && <th>{t("adminDirectory.verification.reviewed")}</th>}
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={`${i.kind}:${i.item_id}`}>
                    <td>
                      {adminDirectoryLabel(lang, "evidenceKind", KIND_LABEL, i.kind)}
                      {i.kind === "BRANCH" && i.branch_name ? ` - ${i.branch_name}` : ""}
                    </td>
                    <td>{i.legal_name}</td>
                    <td>{adminDirectoryLabel(lang, "storeType", STORE_TYPE_LABEL, i.store_type)}</td>
                    <td>{formatDateTime(i.submitted_at, lang)}</td>
                    {tab === "decided" && (
                      <td>
                        <span className="badge">
                          {i.status && adminDirectoryLabel(lang, "verificationStatus", VERIFICATION_STATUS_LABEL, i.status)}
                        </span>
                      </td>
                    )}
                    {tab === "decided" && <td>{formatDateTime(i.reviewed_at ?? null, lang)}</td>}
                    <td>
                      {tab === "pending" ? (
                        <Link
                          className="button-link"
                          href={`/admin/verification/${i.vendor_id}?kind=${i.kind}&item=${i.item_id}`}
                        >
                          {t("adminDirectory.verification.review")}
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
</div>
            {cursor && (
              <div style={{ marginTop: 14 }}>
                <button className="button button-secondary" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? t("adminDirectory.shared.loadingMore") : t("adminDirectory.shared.loadMore")}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
