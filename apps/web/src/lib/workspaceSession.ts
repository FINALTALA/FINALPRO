"use client";

// TB-26: workspace sessions in the browser. Signing in is SHOPPING only;
// a store workspace or the platform workspace is entered explicitly, from
// the confirmation page (/workspaces/enter), and the API then issues a
// short-lived workspace token. That token lives ONLY in this tab's
// sessionStorage - never in a URL, never in localStorage (so another tab
// stays shopping until it enters on its own) - and is sent ONLY on the
// calls of that workspace (apiFetch decides by the path), never on a
// shopping call: the API refuses a workspace token on a shopping route
// (SHOPPING_REQUIRED) and requires the matching one on a workspace route
// (WORKSPACE_REQUIRED) while workspace_scoping_enabled is on.
//
// Not a security boundary on its own: the API re-checks the membership /
// platform role on every request.

export type WorkspaceRef = { type: "vendor"; vendor_id: string } | { type: "platform" };

const STORE_KEY = "finalpro_workspace_tokens";
export const WORKSPACE_EVENT = "finalpro:workspace";
/** Fired by apiFetch when the API answers WORKSPACE_REQUIRED for a call. */
export const WORKSPACE_REQUIRED_EVENT = "finalpro:workspace-required";

interface Stored {
  vendors: Record<string, string>;
  platform: string | null;
}

function read(): Stored {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Stored>;
      return { vendors: parsed.vendors ?? {}, platform: parsed.platform ?? null };
    }
  } catch {
    // Storage unavailable: no workspace in this tab.
  }
  return { vendors: {}, platform: null };
}

function write(next: Stored): void {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    // Without storage the workspace lasts this page only.
  }
  try {
    window.dispatchEvent(new Event(WORKSPACE_EVENT));
  } catch {
    // Not in a browser.
  }
}

export function workspaceToken(ref: WorkspaceRef): string | null {
  const s = read();
  return ref.type === "platform" ? s.platform : (s.vendors[ref.vendor_id] ?? null);
}

export function hasWorkspace(ref: WorkspaceRef): boolean {
  return workspaceToken(ref) !== null;
}

/** A stable string of this tab's entered workspaces (for re-renders). */
export function workspaceSnapshot(): string {
  const s = read();
  return JSON.stringify({ v: Object.keys(s.vendors).sort(), p: Boolean(s.platform) });
}

export function rememberWorkspace(ref: WorkspaceRef, token: string): void {
  const s = read();
  if (ref.type === "platform") s.platform = token;
  else s.vendors[ref.vendor_id] = token;
  write(s);
}

export function forgetWorkspace(ref: WorkspaceRef): void {
  const s = read();
  if (ref.type === "platform") s.platform = null;
  else delete s.vendors[ref.vendor_id];
  write(s);
}

/** Sign-out / another account: this tab leaves every workspace. */
export function forgetAllWorkspaces(): void {
  write({ vendors: {}, platform: null });
}

const VENDOR_PATH = /^\/vendors\/([^/?#]+)(?:[/?#]|$)/;
// Platform decisions that live under a store's path (verification).
const PLATFORM_VENDOR_PATH =
  /^\/vendors\/[^/?#]+\/(?:branches\/[^/?#]+|warehouse)\/verification-(?:decision|evidence)(?:[/?#]|$)/;

/** Which workspace an API path belongs to (null = shopping / public). */
export function workspaceOfApiPath(path: string): WorkspaceRef | null {
  if (path === "/admin" || path.startsWith("/admin/") || path.startsWith("/admin?")) {
    return { type: "platform" };
  }
  if (PLATFORM_VENDOR_PATH.test(path)) return { type: "platform" };
  const m = VENDOR_PATH.exec(path);
  return m ? { type: "vendor", vendor_id: decodeURIComponent(m[1]) } : null;
}

/** Which workspace a PAGE belongs to (null = shopping / public). */
export function workspaceOfPage(pathname: string): WorkspaceRef | null {
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return { type: "platform" };
  const m = /^\/vendor\/([^/?#]+)(?:\/|$)/.exec(pathname);
  return m ? { type: "vendor", vendor_id: decodeURIComponent(m[1]) } : null;
}

/** The workspace token to send with an API call, if any. */
export function workspaceTokenForApiPath(path: string): string | null {
  const ref = workspaceOfApiPath(path);
  return ref ? workspaceToken(ref) : null;
}

/**
 * A safe place to continue to after entering: a same-site path (one
 * leading "/", no "//", no backslash, no scheme) that belongs to that
 * workspace - its own /vendor/<id> or /admin pages, or (for a store) its
 * own storefront page. Anything else falls back to the workspace's home.
 */
export function safeWorkspaceNext(
  next: string | null | undefined,
  ref: WorkspaceRef,
  storefrontSlug?: string | null,
): string {
  const home = workspaceHome(ref);
  if (!next || typeof next !== "string") return home;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\") || /[\u0000-\u001f]/.test(next)) {
    return home;
  }
  let pathname: string;
  try {
    const u = new URL(next, "http://same.origin");
    if (u.origin !== "http://same.origin") return home;
    pathname = u.pathname;
  } catch {
    return home;
  }
  if (ref.type === "platform") {
    return pathname === "/admin" || pathname.startsWith("/admin/") ? next : home;
  }
  const own = `/vendor/${ref.vendor_id}`;
  if (pathname === own || pathname.startsWith(`${own}/`)) return next;
  if (storefrontSlug && (pathname === `/store/${storefrontSlug}` || pathname.startsWith(`/store/${storefrontSlug}/`))) {
    return next;
  }
  return home;
}

export function workspaceHome(ref: WorkspaceRef): string {
  return ref.type === "platform" ? "/admin" : `/vendor/${ref.vendor_id}`;
}

/** The confirmation page for entering `ref`, continuing to `next`. */
export function workspaceEntryHref(ref: WorkspaceRef, next?: string): string {
  const qs = new URLSearchParams({ type: ref.type });
  if (ref.type === "vendor") qs.set("vendor_id", ref.vendor_id);
  if (next) qs.set("next", next);
  return `/workspaces/enter?${qs.toString()}`;
}

/** The notifications API of the context a page belongs to. */
export function notificationsApiBase(pathname: string): string {
  const ref = workspaceOfPage(pathname);
  if (!ref) return "/me/notifications";
  return ref.type === "platform"
    ? "/admin/notifications"
    : `/vendors/${encodeURIComponent(ref.vendor_id)}/notifications`;
}

/** The «إشعاراتي» page of the context a page belongs to. */
export function notificationsPagePath(pathname: string): string {
  const ref = workspaceOfPage(pathname);
  if (!ref) return "/notifications";
  return ref.type === "platform"
    ? "/admin/notifications"
    : `/vendor/${encodeURIComponent(ref.vendor_id)}/notifications`;
}
