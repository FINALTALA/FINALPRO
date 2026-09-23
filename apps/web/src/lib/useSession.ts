"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { apiFetch } from "./api";
import { ActiveWorkspaceRef, SESSION_EVENT, getSessionToken } from "./session";
import type { WorkspaceInfo } from "./nav";

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

/** The signed-in user's workspaces, or null while loading / signed out. */
export function useWorkspaces(token: string | null): WorkspaceInfo[] | null {
  const [state, setState] = useState<{
    token: string | null;
    list: WorkspaceInfo[];
  }>({ token: null, list: [] });

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    apiFetch<{ workspaces: WorkspaceInfo[] }>("/me/workspaces")
      .then((res) => {
        if (!cancelled) setState({ token, list: res.workspaces });
      })
      .catch(() => {
        if (!cancelled) setState({ token, list: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return token && state.token === token ? state.list : null;
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
