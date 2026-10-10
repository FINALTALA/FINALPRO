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
