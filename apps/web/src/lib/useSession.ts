"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { apiFetch } from "./api";
import { isUnauthorized } from "./apiErrors";
import { ActiveWorkspaceRef, SESSION_EVENT, clearSession, getSessionToken } from "./session";
import type { WorkspaceInfo } from "./nav";
import { hasWorkspace, notificationsApiBase, workspaceOfPage } from "./workspaceSession";

function subscribe(onChange: () => void): () => void {
  window.addEventListener(SESSION_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(SESSION_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

const noopSubscribe = () => () => {};

/**
 * False during server rendering and the first hydration pass, true
 * afterwards. Session-dependent redirects/empty states must wait for it,
 * or a signed-in user is briefly treated as signed out.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

/** The current session token (null on the server and when signed out). */
export function useSessionToken(): string | null {
  return useSyncExternalStore(subscribe, getSessionToken, () => null);
}

function getActiveRaw(): string | null {
  try {
    return localStorage.getItem("finalpro_active_workspace");
  } catch {
    return null;
  }
}

export function useActiveWorkspace(): ActiveWorkspaceRef | null {
  const raw = useSyncExternalStore(subscribe, getActiveRaw, () => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ActiveWorkspaceRef;
  } catch {
    return null;
  }
}

/** TB-16.1: how reading the workspaces ended - three different outcomes. */
export type WorkspacesResult =
  | { status: "loading" }
  | { status: "ok"; list: WorkspaceInfo[] }
  // 429, 5xx, a network failure: NOT "no workspaces".
  | { status: "error"; error: unknown };

/**
 * TB-16.1: the workspaces read with its outcome. A 401 means the stored
 * session is no longer valid: it is cleared, so every page that needs one
 * sends the user to sign in (useAdminGate and the token checks do that) -
 * the result then stays "loading" until that happens. Any other failure is
 * reported as an error, never as an empty list.
 */
// TB-26: one read of the workspaces per session, shared by every component
// that needs it at the same time (the app shell, the store page, the
// workspace entry, the admin gate) - in flight once, then kept for a few
// seconds - instead of one request each. A failure is never kept.
const WORKSPACES_TTL_MS = 5_000;
let workspacesRead: { token: string; at: number; promise: Promise<{ workspaces: WorkspaceInfo[] }> } | null = null;
function readWorkspaces(token: string): Promise<{ workspaces: WorkspaceInfo[] }> {
  const now = Date.now();
  if (workspacesRead && workspacesRead.token === token && now - workspacesRead.at < WORKSPACES_TTL_MS) {
    return workspacesRead.promise;
  }
  const promise = apiFetch<{ workspaces: WorkspaceInfo[] }>("/me/workspaces");
  const entry = { token, at: now, promise };
  workspacesRead = entry;
  promise.catch(() => {
    if (workspacesRead === entry) workspacesRead = null;
  });
  return promise;
}

export function useWorkspacesResult(token: string | null): WorkspacesResult {
  const [state, setState] = useState<{ token: string | null; result: WorkspacesResult }>({
    token: null,
    result: { status: "loading" },
  });

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    readWorkspaces(token)
      .then((res) => {
        if (!cancelled) setState({ token, result: { status: "ok", list: res.workspaces } });
      })
      .catch((err) => {
        if (cancelled) return;
        if (isUnauthorized(err)) {
          clearSession();
          return;
        }
        setState({ token, result: { status: "error", error: err } });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return token && state.token === token ? state.result : { status: "loading" };
}

/** The signed-in user's workspaces, or null while loading / signed out.
 * Kept for its many callers: a failure other than 401 still reads as an
 * empty list here (see useWorkspacesResult for the outcome itself). */
export function useWorkspaces(token: string | null): WorkspaceInfo[] | null {
  const result = useWorkspacesResult(token);
  if (result.status === "ok") return result.list;
  if (result.status === "error") return [];
  return null;
}

/** Number of lines in the server-side cart (0 when signed out). */
export function useCartCount(token: string | null, refreshKey: string): number {
  const [state, setState] = useState<{ key: string; count: number }>({
    key: "",
    count: 0,
  });
  const key = `${token ?? ""}|${refreshKey}`;

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    apiFetch<unknown[]>("/cart")
      .then((items) => {
        if (!cancelled) setState({ key, count: items.length });
      })
      .catch(() => {
        if (!cancelled) setState({ key, count: 0 });
      });
    return () => {
      cancelled = true;
    };
  }, [token, key]);

  return token && state.key === key ? state.count : 0;
}

/** Sprint 19: unread count for the bell icon (0 when signed out).
 * Polls on the same "refetch when refreshKey changes" model as
 * useCartCount - here refreshKey is the pathname, so leaving any page
 * (in particular /notifications itself, after marking things read)
 * refreshes the badge. */
export function useUnreadNotificationCount(
  token: string | null,
  refreshKey: string,
): number {
  const [state, setState] = useState<{ key: string; count: number }>({
    key: "",
    count: 0,
  });
  const key = `${token ?? ""}|${refreshKey}`;

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    // TB-26: the count of the page's own context - the shopping bell, or
    // the store / platform workspace the page belongs to (only once this
    // tab has entered it).
    const pageWorkspace = workspaceOfPage(refreshKey);
    if (pageWorkspace && !hasWorkspace(pageWorkspace)) return;
    apiFetch<{ unread_count: number }>(`${notificationsApiBase(refreshKey)}/unread-count`)
      .then((res) => {
        if (!cancelled) setState({ key, count: res.unread_count });
      })
      .catch(() => {
        if (!cancelled) setState({ key, count: 0 });
      });
    return () => {
      cancelled = true;
    };
  }, [token, key, refreshKey]);

  return token && state.key === key ? state.count : 0;
}
