"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch, ApiError } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiErrors";
import {
  NotificationDto,
  NotificationPageDto,
  formatNotificationTime,
  notificationDetail,
  notificationHref,
  notificationLabel,
} from "@/lib/notifications";
import { clearSession } from "@/lib/session";
import { useLang, useT } from "@/lib/useLang";
import { useHydrated, useSessionToken, useWorkspaces } from "@/lib/useSession";
import { notificationsApiBase, workspaceOfPage } from "@/lib/workspaceSession";
import "@/lib/workspaceText";
import { loginRedirectHref, useLoginRedirectHref, useLoginWhenSessionLost } from "@/lib/loginRedirect";

// Sprint 19 (§9 plan): the one inbox for every role (customer, branch
// employee, owner) - the API is already scoped to the signed-in user,
// so this page never needs to know which workspace is active. Each
// item's own type decides where tapping it goes (lib/notifications.ts);
// marking read is fire-and-forget (idempotent server-side either way)
// so navigation never waits on it.
// TB-26: the same page serves each context - /notifications (the shopping
// bell: CUSTOMER), /vendor/<id>/notifications (that store's workspace) and
// /admin/notifications (the platform workspace). The page's own path picks
// the API, so a list, its count and "mark read" never cross contexts.
export default function NotificationsPage() {
  const loginLink = useLoginRedirectHref();
  const router = useRouter();
  const pathname = usePathname();
  const apiBase = notificationsApiBase(pathname);
  const context = workspaceOfPage(pathname);
  const hydrated = useHydrated();
  const token = useSessionToken();
  // the reader's role in a store - where its store notifications lead (owner / employee)
  const workspaces = useWorkspaces(token);
  const storeRoleOf = (vendorId: string | null | undefined) => {
    const m = workspaces?.find((w) => w.type === "vendor" && w.vendor_id === vendorId);
    return m && m.type === "vendor" ? (m.role as "OWNER" | "BRANCH_EMPLOYEE") : null;
  };
  // TB-34: a session lost to a 401 goes to sign-in (with `next` = this page) rather than showing the sign-in button.
  useLoginWhenSessionLost(hydrated, token);
  const lang = useLang();
  const t = useT();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [items, setItems] = useState<NotificationDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  // TB-16.1/16.3: the failure itself and the key of its fallback words;
  // the words are chosen when rendering, in the current language (never
  // the API's own message).
  const [error, setError] = useState<{ err: unknown; fallbackKey: string } | null>(null);

  const fetchPage = useCallback(
    (after: string | null) => {
      const qs = new URLSearchParams({ limit: "20" });
      if (unreadOnly) qs.set("unread_only", "true");
      if (after) qs.set("cursor", after);
      return apiFetch<NotificationPageDto>(`${apiBase}?${qs.toString()}`);
    },
    [unreadOnly, apiBase],
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
          router.replace(loginRedirectHref());
          return;
        }
        setError({ err, fallbackKey: "notif.page.load_failed" });
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, fetchPage, router, pathname]);

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
      setError({ err, fallbackKey: "notif.page.load_more_failed" });
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
      apiFetch(`${apiBase}/${n.id}/read`, { method: "POST" }).catch(() => {
        // Idempotent and non-critical - a failed mark-as-read never blocks navigation.
      });
    }
    router.push(notificationHref(n, { storeRole: storeRoleOf(n.vendor_id) }));
  }

  if (!hydrated) {
    return (
      <div className="notifications-page page-shell">
        <div className="skeleton" style={{ height: 96, width: "100%", maxWidth: 720 }} />
      </div>
    );
  }

  if (!token) {
    return (
      <div className="notifications-page page-shell">
        <EmptyState
          title={t("notif.page.sign_in_title")}
          actionHref={loginLink}
          actionLabel={t("notif.page.sign_in")}
        />
      </div>
    );
  }

  return (
    <div className="notifications-page page-shell">
      <div className="notifications-content">
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }} data-testid="notifications-title">
            {context ? t(context.type === "platform" ? "ws.notifications.title.platform" : "ws.notifications.title.vendor") : t("notif.page.title")}
          </h1>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          <button
            className={unreadOnly ? "button-link" : "button"}
            onClick={() => selectFilter(false)}
          >
            {t("notif.page.all")}
          </button>
          <button
            className={unreadOnly ? "button" : "button-link"}
            onClick={() => selectFilter(true)}
          >
            {t("notif.page.unread_only")}
          </button>
        </div>

        {error && <ErrorBanner message={error.err instanceof ApiError ? apiErrorMessage(error.err, lang) : t(error.fallbackKey)} />}

        {loading && (
          <div aria-busy="true" aria-label={t("notif.page.loading")}>
            <div className="skeleton" style={{ height: 72, width: "100%", marginBottom: 8 }} />
            <div className="skeleton" style={{ height: 72, width: "100%", marginBottom: 8 }} />
            <div className="skeleton" style={{ height: 72, width: "100%" }} />
          </div>
        )}

        {!loading && !error && items.length === 0 && (
          <EmptyState
            title={unreadOnly ? t("notif.page.empty_unread") : t("notif.page.empty")}
          />
        )}

        {!loading && items.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {items.map((n) => {
              const detail = notificationDetail(n, lang);
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
                    <strong>{notificationLabel(n.type, lang)}</strong>
                    {!n.read_at && <span className="badge badge-active">{t("notif.page.new")}</span>}
                  </div>
                  {detail && <div className="muted">{detail}</div>}
                  <div className="muted" style={{ marginTop: 4, fontSize: 13 }}>
                    {formatNotificationTime(n.created_at, lang)}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {cursor && (
          <div style={{ marginTop: 14 }}>
            <button className="button-link" disabled={loadingMore} onClick={loadMore}>
              {loadingMore ? t("notif.page.loading_more") : t("notif.page.load_more")}
            </button>
          </div>
        )}

        <div style={{ marginTop: 20 }}>
          <Link href="/account" className="button-link">{t("notif.page.account")}</Link>
        </div>
      </div>
    </div>
  );
}
