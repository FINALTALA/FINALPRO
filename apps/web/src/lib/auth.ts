import { apiFetch } from "./api";
import { clearSession, getSessionToken } from "./session";

/**
 * Signs out: revokes this session on the server (POST /auth/logout),
 * then clears the browser's session no matter what - even if the request
 * fails (offline, already-expired session), the customer is signed out
 * locally.
 */
export async function logout(): Promise<void> {
  if (getSessionToken()) {
    try {
      await apiFetch("/auth/logout", { method: "POST" });
    } catch {
      // Already invalid or unreachable - the local sign-out below is
      // what matters to this browser.
    }
  }
  clearSession({ lost: false });
}

/**
 * «تسجيل الخروج» from anywhere (2026-11-24): one account, so it leaves every
 * context at once - the shopping side, the store / branch workspaces of this
 * tab - and lands on the FULL sign-in page of the site. A full page load of
 * the top window closes whatever was open around the button: the account
 * overlay, the store's management window, a panel or a dialog (each of those
 * is an iframe or page state - none survives the load). Never a sign-in form
 * inside a frame.
 */
export async function signOutToLogin(): Promise<void> {
  await logout();
  // a full load on purpose (not a client-side push): it is what closes
  // every window, panel and frame around the button
  let target: Window = window;
  try {
    if (window.top && window.top.location.origin === window.location.origin) target = window.top;
  } catch {
    // a foreign parent (never this site's own frames): this window at least
  }
  target.location.assign("/login");
}
