"use client";

import "@/lib/adminReviewsPerformanceText";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { ApiError, apiFetch } from "@/lib/api";
import { isForbidden } from "@/lib/admin";
import { fillMp, mpError } from "@/lib/adminMarketplaceText";
import { useAdminGate } from "@/lib/useAdminGate";
import { useLang, useT } from "@/lib/useLang";

interface VendorPerformanceRow {
  display_name: string;
  cancellation_rate: number | null;
  average_response_time_hours: number | null;
  responded_orders_count: number;
  rating_average: number | null;
  rating_count: number;
}

interface VendorPerformancePage {
  items: VendorPerformanceRow[];
  next_cursor: string | null;
}

function formatPercent(v: number | null): string {
  if (v === null) return "-";
  return `${(v * 100).toFixed(1)}%`;
}

function formatHours(v: number | null, hoursText: string): string {
  if (v === null) return "-";
  return fillMp(hoursText, { n: v.toFixed(1) });
}

// Sprint 25 (FR-VEND-011): PLATFORM_ADMIN's view of every vendor's
// performance indicators - gated by the same
// `vendor_performance_dashboard_enabled` flag the vendor-facing
// dashboard uses (see /admin/feature-flags), so a disabled flag shows
// one clear message here instead of a confusing empty list.
export default function AdminVendorPerformancePage() {
  const gate = useAdminGate("ADMIN");
  const lang = useLang();
  const t = useT();
  const [items, setItems] = useState<VendorPerformanceRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [disabled, setDisabled] = useState(false);

  const fetchPage = useCallback((after: string | null) => {
    const qs = new URLSearchParams({ limit: "20" });
    if (after) qs.set("cursor", after);
    return apiFetch<VendorPerformancePage>(`/admin/vendors/performance?${qs.toString()}`);
  }, []);

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
        if (err instanceof ApiError && err.code === "FEATURE_DISABLED") {
          setDisabled(true);
        } else {
          setError(mpError(err, lang));
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate.status, fetchPage]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(cursor);
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.next_cursor);
    } catch (err) {
      setError(mpError(err, lang));
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
        <EmptyState title={t("mpa.vp.forbidden")} actionHref="/account" actionLabel={t("mpa.rv.myAccount")} />
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 1000 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>{t("mpa.vp.title")}</h1>
          <Link href="/admin" className="button-link">{t("mpa.rv.dashboard")}</Link>
        </div>

        {disabled && (
          <EmptyState
            title={t("mpa.vp.disabled")}
            message={t("mpa.vp.disabledHint")}
            actionHref="/admin/feature-flags"
            actionLabel={t("mpa.vp.flags")}
          />
        )}
        {!disabled && error && <ErrorBanner message={error} />}
        {!disabled && loading && (
          <div aria-busy="true" aria-label={t("mpa.rv.loading")}>
            <div className="skeleton" style={{ height: 56, width: "100%", marginBottom: 8 }} />
            <div className="skeleton" style={{ height: 56, width: "100%" }} />
          </div>
        )}
        {!disabled && !loading && !error && items.length === 0 && (
          <EmptyState title={t("mpa.vp.empty")} />
        )}
        {!disabled && !loading && items.length > 0 && (
          <>
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t("mpa.vp.colStore")}</th>
                    <th>{t("mpa.vp.colCancellation")}</th>
                    <th>{t("mpa.vp.colResponse")}</th>
                    <th>{t("mpa.vp.colResponded")}</th>
                    <th>{t("mpa.vp.colRating")}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((v, i) => (
                    <tr key={`${v.display_name}-${i}`}>
                      <td>{v.display_name}</td>
                      <td>{formatPercent(v.cancellation_rate)}</td>
                      <td>{formatHours(v.average_response_time_hours, t("mpa.vp.hours"))}</td>
                      <td>{v.responded_orders_count}</td>
                      <td>
                        {v.rating_average === null
                          ? "-"
                          : `${v.rating_average.toFixed(1)} (${v.rating_count})`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {cursor && (
              <div style={{ marginTop: 14 }}>
                <button className="button button-secondary" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? t("mpa.vp.loadingMore") : t("mpa.vp.loadMore")}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
