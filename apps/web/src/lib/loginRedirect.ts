"use client";

import { useRouter } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import { sessionWasLost } from "./session";

// TB-34: the ONE place that builds and checks the sign-in `next`. A page
// whose session is gone (a 401, or no session at all on a page that needs
// one) sends the user to /login?next=<the page they were on, with its
// query>, and a successful sign-in returns there. `next` is only ever a
// same-site path: an absolute URL, "//host", "/\host", any backslash, a
// control character (also percent-encoded), or a way back to the sign-in
// pages themselves is refused. 403 / 429 / 5xx are not a lost session: they
// never come here (the pages show their own error words).

const SAME_ORIGIN = "http://same.origin.invalid";

/** Query parameters never carried into `next` (credentials must not
 * travel in a URL, and never survive a sign-in round trip). */
const SENSITIVE_PARAMS = new Set(["token", "session_token", "workspace_token", "otp", "password"]);

/** Sign-in pages: never a place to come back to (it would loop). */
const AUTH_PATHS = new Set(["/login", "/register", "/reset-password", "/reactivate", "/join-team"]);

function unsafeText(s: string): boolean {
  return s.includes("\\") || /[\u0000-\u001f\u007f]/.test(s);
}

/**
 * A safe same-site path to continue to (pathname + safe query + hash), or
 * null. Used by the sign-in page for `?next=` and by every redirect below.
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || unsafeText(raw)) return null;
  // Percent-encoded tricks ("/%2F%2Fhost", "/%5Chost", "%0d") are refused too.
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded.startsWith("//") || unsafeText(decoded)) return null;
  let url: URL;
  try {
    url = new URL(raw, SAME_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== SAME_ORIGIN) return null;
  if (AUTH_PATHS.has(url.pathname)) return null;
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The page the user is on now (path + query + hash), as a safe `next`. */
export function currentInternalPath(): string | null {
  if (typeof window === "undefined") return null;
  const { pathname, search, hash } = window.location;
  return safeNextPath(`${pathname}${search}${hash}`);
}

/** /login, with `next` only when it is a safe same-site path. */
export function loginHref(next?: string | null): string {
  const safe = safeNextPath(next ?? null);
  return safe && safe !== "/" ? `/login?next=${encodeURIComponent(safe)}` : "/login";
}

/** /login?next=<this very page> - what every protected page redirects to
 * when its session is missing or answered 401. */
export function loginRedirectHref(): string {
  // Several handlers can notice the same 401 (a page's own call, the
  // session-lost check...). The first one already moved to /login?next=...;
  // a later one must keep that `next`, not replace it with a bare /login.
  if (typeof window !== "undefined" && window.location.pathname === "/login") {
    return loginHref(safeNextPath(new URLSearchParams(window.location.search).get("next")));
  }
  return loginHref(currentInternalPath());
}

const noopSubscribe = () => () => {};

/** The same link for a sign-in BUTTON shown in place of a page that needs a
 * session ("sign in to ..."): plain /login while server-rendering, then
 * /login?next=<this page> in the browser (no hydration mismatch). */
export function useLoginRedirectHref(): string {
  return useSyncExternalStore(noopSubscribe, loginRedirectHref, () => "/login");
}

/**
 * For a page that shows a «sign in» button when there is no session: if
 * this tab's session was LOST (a 401 cleared it - see sessionWasLost), go
 * to sign-in with `next` = this page instead, whichever call noticed the
 * 401 first. Someone who simply never signed in still sees the button.
 */
export function useLoginWhenSessionLost(hydrated: boolean, token: string | null): void {
  const router = useRouter();
  useEffect(() => {
    if (hydrated && !token && sessionWasLost()) router.replace(loginRedirectHref());
  }, [hydrated, token, router]);
}
