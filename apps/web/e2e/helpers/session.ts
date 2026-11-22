import type { Page } from "@playwright/test";

// Mirrors apps/web/src/lib/session.ts's own storage key exactly -
// seeding it directly is the Playwright equivalent of "already signed
// in," skipping the OTP-entry UI (already covered by this project's
// other e2e coverage) so these specs can focus on the returns feature
// itself. Deliberately not a security bypass: the token still has to
// be a real one minted by the real API (helpers/api.ts's signup()),
// and every API call it makes is authorized exactly as it would be
// from a real browser session.
const SESSION_TOKEN_KEY = "finalpro_session_token";

export async function loginAs(page: Page, token: string): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, value);
    },
    { key: SESSION_TOKEN_KEY, value: token },
  );
}

// TB-26: signing in is shopping only. A spec that is ABOUT a store or the
// platform workspace (not about entering it - tb26-workspaces.spec.ts covers
// that through the real confirmation page) enters it the way the page does:
// a real workspace token from the real API (POST /me/workspace-sessions,
// re-checked on every request), kept in this tab's sessionStorage under the
// web app's own key. Never a security bypass.
const WORKSPACE_TOKENS_KEY = "finalpro_workspace_tokens";
const API_BASE = process.env.PW_API_BASE_URL;

export async function enterWorkspace(
  page: Page,
  sessionToken: string,
  ref: { type: "vendor"; vendor_id: string } | { type: "platform" },
): Promise<void> {
  const res = await fetch(`${API_BASE}/me/workspace-sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify(ref),
  });
  const body = (await res.json()) as { workspace_token?: string };
  if (!res.ok || !body.workspace_token) throw new Error(`entering ${ref.type} failed (status ${res.status})`);
  await page.addInitScript(
    ({ key, ref: r, token }) => {
      let stored: { vendors: Record<string, string>; platform: string | null } = { vendors: {}, platform: null };
      try {
        stored = { ...stored, ...JSON.parse(window.sessionStorage.getItem(key) ?? "{}") };
      } catch {
        // start empty
      }
      if (r.type === "platform") stored.platform = token;
      else stored.vendors = { ...stored.vendors, [r.vendor_id]: token };
      window.sessionStorage.setItem(key, JSON.stringify(stored));
    },
    { key: WORKSPACE_TOKENS_KEY, ref, token: body.workspace_token },
  );
}
