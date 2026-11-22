"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { EmptyState, ErrorBanner } from "@/components/States";
import { ApiError, apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiErrors";
import {
  type NotificationDto,
  type NotificationPageDto,
  formatNotificationTime,
  notificationDetail,
  notificationHref,
  notificationLabel,
} from "@/lib/notifications";
import { clearSession } from "@/lib/session";
import { useLang, useT } from "@/lib/useLang";
import { useSessionToken, useWorkspaces } from "@/lib/useSession";
import { notificationsApiBase } from "@/lib/workspaceSession";
import { loginHref } from "@/lib/loginRedirect";

// The Via header's Instagram-like notification drawer. It deliberately uses
// the same endpoint and actions as /notifications; the route remains useful
// as a direct URL, while the everyday bell interaction stays in context.
//
// 2026-11-18: the store workspace's «إشعاراتي» is THIS drawer too (same look
// and behaviour) - given its own store endpoint (STORE notifications of that
// store only, with the tab's workspace token), its title, and opening from
// the reading-start side (the right in Arabic). `onNavigate` lets the page
// open a notification's link where it belongs (the owner's management window).
export default function NotificationsPanel({
  open,
  onClose,
  apiBase: storeApiBase,
  title,
  variant,
  onNavigate,
}: {
  open: boolean;
  onClose: () => void;
  /** An explicit inbox (the store workspace's), instead of the page's own context. */
  apiBase?: string;
  title?: string;
  variant?: "store";
  onNavigate?: (href: string) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  // TB-26: the panel lists the page's own context (the shopping bell on a
  // shopping page) - unless it is given the store's own inbox.
  const apiBase = storeApiBase ?? notificationsApiBase(pathname);
  const token = useSessionToken();
  // the reader's role in a store - where its store notifications lead (owner / employee)
  const workspaces = useWorkspaces(token);
  const storeRoleOf = (vendorId: string | null | undefined) => {
    const m = workspaces?.find((w) => w.type === "vendor" && w.vendor_id === vendorId);
    return m && m.type === "vendor" ? (m.role as "OWNER" | "BRANCH_EMPLOYEE") : null;
  };
  const lang = useLang();
  const t = useT();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // TB-4: every opening (and every filter) is one request, named by
  // `requestKey`; the loaded page remembers which request it answers, so
  // "loading" is derived (the page is for an older request) instead of
  // being set inside the fetch effect. Opening counts are adjusted while
  // rendering (React's pattern for state that follows a prop).
  const [openings, setOpenings] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOpenings((n) => n + 1);
  }
  const requestKey = open && token ? `${openings}:${unreadOnly ? "unread" : "all"}` : null;
  const [loaded, setLoaded] = useState<{
    key: string | null;
    items: NotificationDto[];
    cursor: string | null;
    // TB-16.1/16.3: the failure itself and the key of its fallback words;
    // the words are chosen when rendering, in the current language.
    error: { err: unknown; fallbackKey: string } | null;
  }>({ key: null, items: [], cursor: null, error: null });
  // While closed, keep showing the last page (the drawer is sliding away).
  const current = requestKey === null || loaded.key === requestKey;
  const loading = !current;
  const items = current ? loaded.items : [];
  const cursor = current ? loaded.cursor : null;
  const error = current ? loaded.error : null;

  const fetchPage = useCallback((after: string | null) => {
    const qs = new URLSearchParams({ limit: "20" });
    if (unreadOnly) qs.set("unread_only", "true");
    if (after) qs.set("cursor", after);
    return apiFetch<NotificationPageDto>(`${apiBase}?${qs.toString()}`);
  }, [unreadOnly, apiBase]);

  useEffect(() => {
    if (requestKey === null) return;
    let cancelled = false;
    fetchPage(null)
      .then((page) => {
        if (cancelled) return;
        setLoaded({ key: requestKey, items: page.items, cursor: page.next_cursor, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          onClose();
          router.replace(loginHref("/notifications"));
          return;
        }
        setLoaded((previous) => ({ ...previous, key: requestKey, error: { err, fallbackKey: "notif.page.load_failed" } }));
      });
    return () => { cancelled = true; };
  }, [requestKey, fetchPage, router, onClose]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  function selectFilter(next: boolean) {
    if (next === unreadOnly) return;
    // A new request key: the list empties and reloads for this filter.
    setUnreadOnly(next);
  }

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(cursor);
      setLoaded((previous) => ({ ...previous, items: [...previous.items, ...page.items], cursor: page.next_cursor }));
    } catch (err) {
      setLoaded((previous) => ({ ...previous, error: { err, fallbackKey: "notif.page.load_more_failed" } }));
    } finally {
      setLoadingMore(false);
    }
  }

  function openNotification(notification: NotificationDto) {
    if (!notification.read_at) {
      setLoaded((previous) => ({
        ...previous,
        items: previous.items.map((item) => item.id === notification.id ? { ...item, read_at: new Date().toISOString() } : item),
      }));
      apiFetch(`${apiBase}/${notification.id}/read`, { method: "POST" }).catch(() => undefined);
    }
    onClose();
    const href = notificationHref(notification, { storeRole: storeRoleOf(notification.vendor_id) });
    if (onNavigate) onNavigate(href);
    else router.push(href);
  }

  const drawer = (
    <div className={`notifications-drawer-layer${variant === "store" ? " notifications-drawer-store" : ""}${open ? " is-open" : ""}`} aria-hidden={!open} onMouseDown={(event) => event.target === event.currentTarget && onClose()} data-testid={variant === "store" ? "store-inbox-drawer" : undefined}>
      <aside className="notifications-drawer" role="dialog" aria-modal="true" aria-labelledby={variant === "store" ? "store-notifications-drawer-title" : "notifications-drawer-title"}>
        <div className="notifications-drawer-head">
          <h2 id={variant === "store" ? "store-notifications-drawer-title" : "notifications-drawer-title"}>{title ?? t("notif.page.title")}</h2>
          <button type="button" onClick={onClose} aria-label={t("notif.page.close")}>×</button>
        </div>

        {!token ? (
          <EmptyState title={t("notif.page.sign_in_title")} actionHref="/login?next=/notifications" actionLabel={t("notif.page.sign_in")} />
        ) : (
          <>
            <div className="notifications-drawer-filters">
              <button className={!unreadOnly ? "active" : ""} onClick={() => selectFilter(false)}>{t("notif.page.all")}</button>
              <button className={unreadOnly ? "active" : ""} onClick={() => selectFilter(true)}>{t("notif.page.unread_only")}</button>
            </div>

            {error && <ErrorBanner message={error.err instanceof ApiError ? apiErrorMessage(error.err, lang) : t(error.fallbackKey)} />}
            {loading && <div className="notifications-drawer-loading" aria-busy="true"><span /><span /><span /></div>}
            {!loading && !error && items.length === 0 && <EmptyState title={unreadOnly ? t("notif.page.empty_unread") : t("notif.page.empty")} />}

            {!loading && items.length > 0 && (
              <div className="notifications-drawer-list">
                {items.map((notification) => {
                  const detail = notificationDetail(notification, lang);
                  return (
                    <button key={notification.id} type="button" className={`notifications-drawer-item${notification.read_at ? "" : " unread"}`} onClick={() => openNotification(notification)}>
                      <div><strong>{notificationLabel(notification.type, lang)}</strong>{!notification.read_at && <span>{t("notif.page.new")}</span>}</div>
                      {detail && <p>{detail}</p>}
                      <time>{formatNotificationTime(notification.created_at, lang)}</time>
                    </button>
                  );
                })}
              </div>
            )}
            {cursor && <button type="button" className="notifications-drawer-more" disabled={loadingMore} onClick={loadMore}>{loadingMore ? t("notif.page.loading_more") : t("notif.page.load_more")}</button>}
          </>
        )}
      </aside>
    </div>
  );
  // The store drawer is opened from pages whose container has a transform
  // (the storefront's entrance animation), which would become the fixed
  // layer's containing block - so it goes straight into <body>.
  return variant === "store" && typeof document !== "undefined" ? createPortal(drawer, document.body) : drawer;
}
