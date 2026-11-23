import { expect, test, type Browser, type Page } from "@playwright/test";
import { loginHref, loginRedirectHref, safeNextPath } from "../src/lib/loginRedirect";
import { call, unique, uniquePhone } from "./helpers/api";
import { prisma } from "./helpers/db";

// TB-34: a page whose session is gone (401 - real or simulated - or no
// session at all) sends the user to /login?next=<that very page, with its
// query>, and signing in brings them back there (a store page by way of
// the workspace confirmation). `next` is built and checked in ONE place
// (src/lib/loginRedirect.ts) and is never anything but a same-site path.
// 403 / 429 / 5xx are not a lost session: no sign-in, no `next`.

const PASSWORD = "a-strong-password";
const PASSWORD_HASH = "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";
const SESSION_KEY = "finalpro_session_token";
const LANG_KEY = "finalpro_lang_pref";
const QUERY = "?from=tb34&page=2";
const FAKE_OFFER = "00000000-0000-4000-8000-000000000034";
const FAKE_VARIANT = "00000000-0000-4000-8000-000000000035";
const FAKE_DRAFT = "00000000-0000-4000-8000-000000000036";

test.describe("TB-34: the sign-in `next` rule (pure)", () => {
  test("a same-site path keeps its query and hash; credentials never travel in it", () => {
    expect(safeNextPath("/vendor/v1/orders?status=NEW&page=2")).toBe("/vendor/v1/orders?status=NEW&page=2");
    expect(safeNextPath("/profile?tab=orders#reviews")).toBe("/profile?tab=orders#reviews");
    expect(safeNextPath("/checkout?token=abc&step=2&otp=1234&session_token=x")).toBe("/checkout?step=2");
    expect(loginHref("/vendor/v1/offers?page=2")).toBe("/login?next=%2Fvendor%2Fv1%2Foffers%3Fpage%3D2");
    expect(loginHref("/")).toBe("/login");
  });

  test("anything outside the site is refused: an absolute URL, //, /\\, a backslash, control characters, encoded tricks, the sign-in pages", () => {
    for (const bad of [
      "https://evil.example/x",
      "http:/evil.example",
      "javascript:alert(1)",
      "//evil.example",
      "///evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "/a\\b",
      "/%2F%2Fevil.example",
      "/%5Cevil.example",
      "/%2f/evil.example",
      "/a\nb",
      "/a%0d%0aSet-Cookie:x",
      "/a\u0000b",
      "evil.example",
      "",
      "/login?next=/vendor/v1",
      "/register",
      "/reset-password",
      "/reactivate",
    ]) {
      expect(safeNextPath(bad), bad).toBeNull();
      expect(loginHref(bad), bad).toBe("/login");
    }
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
  });

  test("a second handler of the same 401, running once the first has already moved to /login?next=..., keeps that next (never a bare /login)", () => {
    const g = globalThis as unknown as { window?: unknown };
    const saved = g.window;
    try {
      g.window = { location: { pathname: "/vendor/v1/offers", search: "?page=2", hash: "" } };
      expect(loginRedirectHref()).toBe("/login?next=%2Fvendor%2Fv1%2Foffers%3Fpage%3D2");
      // The first handler navigated; the second one runs now:
      g.window = { location: { pathname: "/login", search: "?next=%2Fvendor%2Fv1%2Foffers%3Fpage%3D2", hash: "" } };
      expect(loginRedirectHref()).toBe("/login?next=%2Fvendor%2Fv1%2Foffers%3Fpage%3D2");
      // ...and an unsafe next already on the sign-in page is still refused.
      g.window = { location: { pathname: "/login", search: "?next=%2F%2Fevil.example", hash: "" } };
      expect(loginRedirectHref()).toBe("/login");
    } finally {
      g.window = saved;
    }
  });
});

async function account() {
  const phone = uniquePhone();
  const user = await prisma.user.create({
    data: { phone, passwordHash: PASSWORD_HASH, phoneVerifiedAt: new Date(), languagePref: "ar" },
  });
  await prisma.customerProfile.create({ data: { userId: user.id } });
  const res = await call<{ session_token: string }>("/auth/login", { method: "POST", body: { phone, password: PASSWORD } });
  if (!res.body.session_token) throw new Error(`login failed (status ${res.status})`);
  return { id: user.id, phone, token: res.body.session_token };
}

async function storeOf(owner: Awaited<ReturnType<typeof account>>) {
  const vendor = await prisma.vendor.create({
    data: {
      slug: unique("tb34").toLowerCase(),
      legalName: `TB34 ${unique("L")}`,
      displayName: "متجر TB34",
      status: "ACTIVE",
      subscriptionStatus: "ACTIVE",
      storefrontPublished: true,
    },
  });
  const branch = await prisma.storeBranch.create({
    data: { vendorId: vendor.id, name: unique("فرع"), isPhysical: true, verificationStatus: "APPROVED" },
  });
  await prisma.vendorUser.create({ data: { userId: owner.id, vendorId: vendor.id, role: "OWNER" } });
  return { vendorId: vendor.id, branchId: branch.id, legalName: vendor.legalName };
}

type Pages = { name: string; path: string; store: boolean }[];
function pagesFor(v: string, b: string): Pages {
  const s = (name: string, p: string) => ({ name, path: `/vendor/${v}${p}${QUERY}`, store: true });
  return [
    s("offers", "/offers"),
    s("orders", "/orders"),
    s("branch orders", `/branches/${b}/orders`),
    s("branch delivery windows", `/branches/${b}/delivery-windows`),
    s("delivery windows", "/delivery-windows"),
    // 2026-11-23: zones and the return policy live in «إعدادات المتجر» (the old addresses redirect there)
    s("store settings", "/settings"),
    // «مجموعات المتجر» (2026-11-18): the old /sections page only redirects there now
    { name: "store collections", path: `/vendor/${v}/offers?open=collections&${QUERY.slice(1)}`, store: true },
    s("storefront", "/storefront"),
    s("offers import", "/offers/import"),
    s("classic new offer", "/offers/new/classic"),
    s("an offer", `/offers/${FAKE_OFFER}`),
    s("new variant", `/offers/${FAKE_OFFER}/variants/new`),
    s("a variant", `/offers/${FAKE_OFFER}/variants/${FAKE_VARIANT}`),
    // The product-entry wizard (TB-33): its start page and a draft.
    s("new product (wizard start)", "/offers/new"),
    s("a wizard draft", `/offers/drafts/${FAKE_DRAFT}`),
    { name: "checkout", path: `/checkout${QUERY}`, store: false },
    { name: "account", path: `/account${QUERY}`, store: false },
    { name: "addresses", path: `/account/addresses${QUERY}`, store: false },
    { name: "favorites", path: `/account/favorites${QUERY}`, store: false },
    { name: "change phone", path: `/account/phone${QUERY}`, store: false },
    { name: "deactivate", path: `/account/deactivate${QUERY}`, store: false },
  ];
}

const loginNext = (page: Page) => {
  const u = new URL(page.url());
  return u.pathname === "/login" ? u.searchParams.get("next") : null;
};
const lost401 = {
  status: 401,
  contentType: "application/json",
  body: JSON.stringify({ error: { code: "SESSION_INVALID", message: "Session is invalid or has expired", details: [], correlation_id: "tb34" } }),
};
const sessionOf = (page: Page) => page.evaluate((k) => localStorage.getItem(k), SESSION_KEY);

async function openAs(browser: Browser, token: string | null, lang: "ar" | "en") {
  const context = await browser.newContext();
  await context.addInitScript(
    ({ l, lk, sk, t }) => {
      localStorage.setItem(lk, l);
      // What the cart leaves for checkout (the lines chosen to check out);
      // without it checkout goes back to the cart by itself.
      if (!sessionStorage.getItem("checkout_cart_item_ids")) {
        sessionStorage.setItem("checkout_cart_item_ids", JSON.stringify(["00000000-0000-4000-8000-0000000000c0"]));
      }
      // Seeded on the first load only, so a cleared session stays cleared.
      if (t && !sessionStorage.getItem("tb34-seeded")) {
        localStorage.setItem(sk, t);
        sessionStorage.setItem("tb34-seeded", "1");
      }
    },
    { l: lang, lk: LANG_KEY, sk: SESSION_KEY, t: token },
  );
  return { context, page: await context.newPage() };
}

/** The page's answer to its lost session: straight to sign-in with `next` =
 * this page and its query, the stored session cleared. */
async function expectSentToSignIn(page: Page, p: Pages[number]) {
  await expect.poll(() => loginNext(page), { timeout: 30_000, message: p.name }).toBe(p.path);
  expect(await sessionOf(page)).toBeNull();
}

test.describe("TB-34: a lost session goes to sign-in and comes back to the same page", () => {
  test.describe.configure({ mode: "serial" });
  let owner: Awaited<ReturnType<typeof account>>;
  let pages: Pages;
  let legalName = "";

  test.beforeAll(async () => {
    owner = await account();
    const s = await storeOf(owner);
    legalName = s.legalName;
    pages = pagesFor(s.vendorId, s.branchId);
  });

  for (const lang of ["ar", "en"] as const) {
    // The same 21 pages and the same check for each, in three tests of seven:
    // 21 page loads in ONE test (~1.4 s each) sat at the 30 s per-test limit.
    for (const [part, from, to] of [[1, 0, 7], [2, 7, 14], [3, 14, 21]] as const) {
      test(`${lang}: a simulated 401 (every call answered 401) on the 13 store pages, the wizard, checkout and the account pages - part ${part} of 3`, async ({ browser }) => {
        expect(pages.length).toBe(21);
        for (const p of pages.slice(from, to)) {
          const { context, page } = await openAs(browser, owner.token, lang);
          await page.route("**/api/v1/**", (route) => route.fulfill(lost401));
          await page.goto(p.path);
          await expectSentToSignIn(page, p);
          await context.close();
        }
      });
    }

    test(`${lang}: a real 401 (an expired session) on the 13 store pages, the wizard, checkout and the account pages - never by way of the confirmation`, async ({ browser }) => {
      const expired = await account();
      const s = await storeOf(expired);
      await prisma.user.update({ where: { id: expired.id }, data: { sessionVersion: { increment: 1 } } });
      for (const p of pagesFor(s.vendorId, s.branchId)) {
        const { context, page } = await openAs(browser, expired.token, lang);
        const visited: string[] = [];
        page.on("framenavigated", (f) => {
          if (f === page.mainFrame()) visited.push(f.url());
        });
        await page.goto(p.path);
        await expectSentToSignIn(page, p);
        expect(visited.some((u) => u.includes("/workspaces/enter")), p.name).toBe(false);
        await context.close();
      }
    });
  }

  // Every page (Arabic and English alternately, by its place in the list),
  // in three parts of seven: each page signs in afresh (~1.2 s), and 21 of
  // them in ONE test sat right at the 30 s per-test limit - the parts keep
  // every page and every assertion, each well inside the same limit.
  async function signInComesBack(browser: Browser, from: number, to: number) {
    for (const [i, p] of [...pages.entries()].slice(from, to)) {
      const lang = i % 2 === 0 ? "ar" : "en";
      await prisma.user.update({ where: { id: owner.id }, data: { sessionVersion: { increment: 1 } } });
      const { context, page } = await openAs(browser, owner.token, lang);
      const visited: string[] = [];
      page.on("framenavigated", (f) => {
        if (f === page.mainFrame()) visited.push(f.url());
      });
      await page.goto(p.path);
      await expect.poll(() => loginNext(page), { timeout: 30_000, message: p.name }).toBe(p.path);
      const before = visited.length;
      await page.locator('input[type="tel"]').fill(owner.phone);
      await page.locator('input[type="password"]').fill(PASSWORD);
      await page.locator('button[type="submit"]').click();
      if (p.store) {
        await expect(page).toHaveURL(/\/workspaces\/enter\?/, { timeout: 30_000 });
        expect(new URL(page.url()).searchParams.get("next"), p.name).toBe(p.path);
        await expect(page.getByTestId("ws-enter-name")).toHaveText(legalName);
        await page.getByTestId("ws-enter-confirm").click();
      }
      // Back on exactly that address (what the page then does - e.g. an
      // empty checkout going to the cart - is its own business).
      await expect
        .poll(() => visited.slice(before).map((u) => new URL(u)).some((u) => `${u.pathname}${u.search}` === p.path), { timeout: 30_000, message: p.name })
        .toBe(true);
      await context.close();
    }
  }
  for (const [part, from, to] of [[1, 0, 7], [2, 7, 14], [3, 14, 21]] as const) {
    test(`signing in comes back to the very page with its query - a store page by way of the confirmation (every page; Arabic and English alternately) - part ${part} of 3`, async ({ browser }) => {
      expect(pages.length).toBe(21);
      await signInComesBack(browser, from, to);
    });
  }

  test("never signed in: the pages that show a «sign in» button give it `next` = the page and its query (no redirect, nothing lost)", async ({ browser }) => {
    for (const lang of ["ar", "en"] as const) {
      for (const path of ["/account", "/account/addresses", "/account/phone", "/account/deactivate", "/notifications"].map((x) => `${x}${QUERY}`)) {
        const { context, page } = await openAs(browser, null, lang);
        await page.goto(path);
        const button = page.locator('main a[href^="/login"], .page-shell a[href^="/login"]').first();
        await expect(button).toBeVisible({ timeout: 30_000 });
        await expect
          .poll(async () => new URL((await button.getAttribute("href")) ?? "", "http://x").searchParams.get("next"), { message: path })
          .toBe(path);
        expect(new URL(page.url()).pathname).not.toBe("/login");
        await context.close();
      }
    }
  });

  test("the order that used to differ: the workspaces read answers 401 FIRST (the page's own call held back) - still sign-in with next = this page, never the «sign in» button", async ({ browser }) => {
    for (const path of ["/account", "/account/phone", "/notifications"].map((x) => `${x}${QUERY}`)) {
      const { context, page } = await openAs(browser, owner.token, "ar");
      // The workspaces read answers 401 at once; every other call waits until
      // that has cleared the session, then answers 401 too.
      await page.route("**/api/v1/**", async (route) => {
        if (!new URL(route.request().url()).pathname.endsWith("/me/workspaces")) {
          await expect.poll(() => sessionOf(page)).toBeNull();
        }
        await route.fulfill(lost401);
      });
      await page.goto(path);
      await expect.poll(() => loginNext(page), { timeout: 30_000, message: path }).toBe(path);
      await context.close();
    }
  });

  test("an expired session on a direct workspace-entry link: sign-in first, then the confirmation, then the page", async ({ browser }) => {
    const s = await storeOf(owner);
    const target = `/vendor/${s.vendorId}/orders${QUERY}`;
    const entry = `/workspaces/enter?type=vendor&vendor_id=${s.vendorId}&next=${encodeURIComponent(target)}`;
    await prisma.user.update({ where: { id: owner.id }, data: { sessionVersion: { increment: 1 } } });
    const { context, page } = await openAs(browser, owner.token, "en");
    await page.goto(entry);
    await expect.poll(() => loginNext(page), { timeout: 30_000 }).toBe(entry);
    expect(await sessionOf(page)).toBeNull();
    await page.locator('input[type="tel"]').fill(owner.phone);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/\/workspaces\/enter\?/, { timeout: 30_000 });
    await expect(page.getByTestId("ws-enter-name")).toHaveText(s.legalName);
    await page.getByTestId("ws-enter-confirm").click();
    await expect.poll(() => { const u = new URL(page.url()); return `${u.pathname}${u.search}`; }, { timeout: 30_000 }).toBe(target);
    await context.close();
  });

  test("403, 429 and 5xx are not a lost session: no sign-in, no `next`, the session kept", async ({ browser }) => {
    const fresh = await account();
    for (const [status, code] of [[403, "FORBIDDEN"], [429, "TOO_MANY_REQUESTS"], [500, "INTERNAL_SERVER_ERROR"], [503, "SERVICE_UNAVAILABLE"]] as const) {
      for (const path of [`/checkout${QUERY}`, `/account/addresses${QUERY}`, `/account/favorites${QUERY}`]) {
        const { context, page } = await openAs(browser, fresh.token, "ar");
        await page.route("**/api/v1/**", (route) =>
          route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: { code, message: "x", details: [], correlation_id: "tb34" } }) }),
        );
        await page.goto(path);
        await expect(page.locator('[role="alert"], .error-banner, .empty-state').first()).toBeVisible({ timeout: 30_000 });
        expect(new URL(page.url()).pathname, `${status} ${path}`).not.toBe("/login");
        expect(await sessionOf(page), `${status} ${path}`).toBe(fresh.token);
        await context.close();
      }
    }
  });
});
