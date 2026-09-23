"use client";

// Sprint 4 (RB-ROLE-005): the browser-side session/workspace-choice
// store. Deliberately not a security boundary - PDR-009's actual
// authorization (least-privilege owner/employee access) is enforced
// entirely on the backend (VendorMembershipGuard); nothing here ever
// hides a button *instead of* a real server-side check, only *in
// addition to* one.
const SESSION_TOKEN_KEY = "finalpro_session_token";
const ACTIVE_WORKSPACE_KEY = "finalpro_active_workspace";

// Sprint 13: the app shell (header/bottom nav) re-reads the session
// whenever it changes in this tab, so login/logout/workspace switches
// update the navigation immediately without a reload.
export const SESSION_EVENT = "finalpro:session";
function notifySessionChanged(): void {
  try {
    window.dispatchEvent(new Event(SESSION_EVENT));
  } catch {
    // Not in a browser (SSR) - nothing to notify.
  }
}

export function getSessionToken(): string | null {
  try {
    return localStorage.getItem(SESSION_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setSessionToken(token: string): void {
  try {
    localStorage.setItem(SESSION_TOKEN_KEY, token);
    notifySessionChanged();
  } catch {
    // Private-browsing/blocked storage: the session still works for
    // this page load via in-memory state, just won't survive a reload.
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_TOKEN_KEY);
    localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
    notifySessionChanged();
  } catch {
    // Nothing to clean up if storage was never reachable.
  }
}

export type ActiveWorkspaceRef =
  | { type: "customer" }
  | { type: "vendor"; vendor_id: string; branch_id: string | null };

export function getActiveWorkspace(): ActiveWorkspaceRef | null {
  try {
    const raw = localStorage.getItem(ACTIVE_WORKSPACE_KEY);
    return raw ? (JSON.parse(raw) as ActiveWorkspaceRef) : null;
  } catch {
    return null;
  }
}

export function setActiveWorkspace(ref: ActiveWorkspaceRef): void {
  try {
    localStorage.setItem(ACTIVE_WORKSPACE_KEY, JSON.stringify(ref));
    notifySessionChanged();
  } catch {
    // Same as setSessionToken - a per-viewer convenience, not load-bearing.
  }
}
