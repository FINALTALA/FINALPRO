"use client";

// Sprint 4 (RB-ROLE-005): the browser-side session/workspace-choice
// store. Deliberately not a security boundary - PDR-009's actual
// authorization (least-privilege owner/employee access) is enforced
// entirely on the backend (VendorMembershipGuard); nothing here ever
// hides a button *instead of* a real server-side check, only *in
// addition to* one.
const SESSION_TOKEN_KEY = "finalpro_session_token";
const ACTIVE_WORKSPACE_KEY = "finalpro_active_workspace";

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
  } catch {
    // Private-browsing/blocked storage: the session still works for
    // this page load via in-memory state, just won't survive a reload.
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_TOKEN_KEY);
    localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
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
  } catch {
    // Same as setSessionToken - a per-viewer convenience, not load-bearing.
  }
}
