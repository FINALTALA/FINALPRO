"use client";

// Sprint 4 (RB-ROLE-005): the browser-side session/workspace-choice
// store. Deliberately not a security boundary - PDR-009's actual
// authorization (least-privilege owner/employee access) is enforced
// entirely on the backend (VendorMembershipGuard); nothing here ever
// hides a button *instead of* a real server-side check, only *in
// addition to* one.
import { forgetAllWorkspaces } from "./workspaceSession";

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
    // A new sign-in may be another account: the previous one's workspace
    // choice must not carry over (re-choosing one never touches the token).
    if (localStorage.getItem(SESSION_TOKEN_KEY) !== token) {
      localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
      // TB-26: workspaces entered under the previous session end with it.
      forgetAllWorkspaces();
    }
    localStorage.setItem(SESSION_TOKEN_KEY, token);
    sessionStorage.removeItem(SESSION_LOST_KEY);
    notifySessionChanged();
  } catch {
    // Private-browsing/blocked storage: the session still works for
    // this page load via in-memory state, just won't survive a reload.
  }
}

/**
 * TB-34: this tab's session was cleared because the API answered 401 (not
 * by the user signing out) and no sign-in has happened since. A page that
 * shows a «sign in» button when there is no session then goes to sign-in
 * itself, with `next` = that page - whichever call noticed the 401 first.
 */
const SESSION_LOST_KEY = "finalpro_session_lost";

export function sessionWasLost(): boolean {
  try {
    return sessionStorage.getItem(SESSION_LOST_KEY) === "1";
  } catch {
    return false;
  }
}

/** Ends the stored session. By default it is a LOST session (a 401); an
 * explicit sign-out or deactivation passes `{ lost: false }`. */
export function clearSession(options: { lost?: boolean } = {}): void {
  try {
    if (options.lost !== false) sessionStorage.setItem(SESSION_LOST_KEY, "1");
    else sessionStorage.removeItem(SESSION_LOST_KEY);
  } catch {
    // Without sessionStorage a lost session simply shows the sign-in button.
  }
  try {
    localStorage.removeItem(SESSION_TOKEN_KEY);
    localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
    forgetAllWorkspaces();
    notifySessionChanged();
  } catch {
    // Nothing to clean up if storage was never reachable.
  }
}

export type ActiveWorkspaceRef =
  | { type: "customer" }
  | { type: "platform" }
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
