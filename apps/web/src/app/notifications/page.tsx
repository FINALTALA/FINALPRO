"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch, ApiError } from "@/lib/api";
import {
  NOTIFICATION_TYPE_LABEL,
  NotificationDto,
  NotificationPageDto,
  notificationDetail,
  notificationHref,
} from "@/lib/notifications";
import { clearSession } from "@/lib/session";
import { useHydrated, useSessionToken } from "@/lib/useSession";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ar", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

// Sprint 19 (§9 plan): the one inbox for every role (customer, branch
// employee, owner) - the API is already scoped to the signed-in user,
// so this page never needs to know which workspace is active. Each
// item's own type decides where tapping it goes (lib/notifications.ts);
// marking read is fire-and-forget (idempotent server-side either way)
// so navigation never waits on it.
export default function NotificationsPage() {
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [items, setItems] = useState<NotificationDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(
    (after: string | null) => {
      const qs = new URLSearchParams({ limit: "20" });
      if (unreadOnly) qs.set("unread_only", "true");
      if (after) qs.set("cursor", after);
      return apiFetch<NotificationPageDto>(`/me/notifications?${qs.toString()}`);
    },
    [unreadOnly],
  );

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetchPage(null)
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setCursor(page.next_cursor);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          router.replace("/login?next=/notifications");
          return;
        }
        setError(err instanceof ApiError ? err.message : "تعذّر تحميل الإشعارات");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, fetchPage, router]);

  function selectFilter(next: boolean) {
    if (next === unreadOnly) return;
    setLoading(true);
    setItems([]);
    setCursor(null);
    setError(null);
    setUnreadOnly(next);
  }

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(cursor);
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.next_cursor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر تحميل المزيد");
    } finally {
      setLoadingMore(false);
    }
  }

  function markReadLocally(id: string) {
    setItems((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read_at: n.read_at ?? new Date().toISOString() } : n)),
    );
  }

  function openNotification(n: NotificationDto) {
    if (!n.read_at) {
      markReadLocally(n.id);
      apiFetch(`/me/notifications/${n.id}/read`, { method: "POST" }).catch(() => {
        // Idempotent and non-critical - a failed mark-as-read never blocks navigation.
      });
    }
    router.push(notificationHref(n));
  }

  if (!hydrated) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 96, width: "100%", maxWidth: 720 }} />
      </div>
    );
  }

  if (!token) {
    return (
      <div className="page-shell">
        <EmptyState
          title="سجّلي الدخول لرؤية إشعاراتك"
          actionHref="/login?next=/notifications"
          actionLabel="تسجيل الدخول"
        />
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div style={{ maxWidth: 720, width: "100%" }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>الإشعارات</h1>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          <button
            className={unreadOnly ? "button-link" : "button"}
            onClick={() => selectFilter(false)}
          >
            الكل
          </button>
          <button
            className={unreadOnly ? "button" : "button-link"}
            onClick={() => selectFilter(true)}
          >
            غير المقروءة فقط
          </button>
        </div>

        {error && <ErrorBanner message={error} />}

        {loading && (
          <div aria-busy="true" aria-label="جارٍ التحميل">
            <div className="skeleton" style={{ height: 72, width: "100%", marginBottom: 8 }} />
            <div className="skeleton" style={{ height: 72, width: "100%", marginBottom: 8 }} />
            <div className="skeleton" style={{ height: 72, width: "100%" }} />
          </div>
        )}

        {!loading && !error && items.length === 0 && (
          <EmptyState
            title={unreadOnly ? "لا توجد إشعارات غير مقروءة" : "لا توجد إشعارات بعد"}
          />
        )}

        {!loading && items.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {items.map((n) => {
              const detail = notificationDetail(n);
              return (
                <button
                  key={n.id}
                  onClick={() => openNotification(n)}
                  className="card"
                  style={{
                    display: "block",
                    width: "100%",
                    maxWidth: "none",
                    font: "inherit",
                    textAlign: "start",
                    cursor: "pointer",
                    border: n.read_at ? undefined : "1px solid var(--color-primary)",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <strong>{NOTIFICATION_TYPE_LABEL[n.type] ?? n.type}</strong>
                    {!n.read_at && <span className="badge badge-active">جديد</span>}
                  </div>
                  {detail && <div className="muted">{detail}</div>}
                  <div className="muted" style={{ marginTop: 4, fontSize: 13 }}>
                    {formatDateTime(n.created_at)}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {cursor && (
          <div style={{ marginTop: 14 }}>
            <button className="button-link" disabled={loadingMore} onClick={loadMore}>
              {loadingMore ? "جارٍ التحميل..." : "تحميل المزيد"}
            </button>
          </div>
        )}

        <div style={{ marginTop: 20 }}>
          <Link href="/account" className="button-link">حسابي</Link>
        </div>
      </div>
    </div>
  );
}
