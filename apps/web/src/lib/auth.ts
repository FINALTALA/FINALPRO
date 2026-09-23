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
  clearSession();
}
