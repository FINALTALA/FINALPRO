"use client";

// The tab's recent in-app routes (path + query), so a page can offer
// "back to where you came from" - e.g. /compare/:id back to the /men,
// /women or /kids listing with its filters. sessionStorage: per tab,
// never shared, a convenience only (a missing trail just means "home").
const KEY = "finalpro_nav_trail";
const MAX = 30;

function read(): string[] {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** Called by the app shell on every route change. */
export function recordRoute(route: string): void {
  try {
    const trail = read();
    if (trail[trail.length - 1] === route) return;
    trail.push(route);
    sessionStorage.setItem(KEY, JSON.stringify(trail.slice(-MAX)));
  } catch {
    // Storage blocked: the back button simply falls back to home.
  }
}

/** The route visited just before `pathname` (another page, not itself). */
export function routeBefore(pathname: string): string | null {
  const trail = read();
  const samePage = (route: string) => route.split("?")[0] === pathname;
  // The shell may or may not have recorded the current page yet.
  let i = trail.length - 1;
  while (i >= 0 && samePage(trail[i])) i -= 1;
  return i >= 0 ? trail[i] : null;
}

/**
 * Where a "back" arrow on `pathname` returns: the page it was entered
 * from, kept per page - returning to it from a page opened FROM it (a
 * store's offer page) never replaces the original origin (the listing).
 */
export function originFor(pathname: string): string | null {
  const previous = routeBefore(pathname);
  const key = `${KEY}:origin:${pathname}`;
  try {
    const stored = sessionStorage.getItem(key);
    if (previous && (!stored || !previous.startsWith("/store/"))) {
      sessionStorage.setItem(key, previous);
      return previous;
    }
    return stored ?? previous;
  } catch {
    return previous;
  }
}

const ORIGIN_LABEL: [RegExp, string][] = [
  [/^\/men(?:$|[/?])/, "الرجال"],
  [/^\/women(?:$|[/?])/, "النساء"],
  [/^\/kids(?:$|[/?])/, "الأطفال"],
  [/^\/discovery(?:$|[/?])/, "اكتشف"],
  [/^\/profile(?:$|[/?])/, "البروفايل"],
  [/^\/store\//, "المتجر"],
  [/^\/$|^\/\?/, "الرئيسية"],
];

/** "رجوع إلى الرجال" etc. for a route from the trail. */
export function backLabel(route: string | null): string {
  const name = route ? ORIGIN_LABEL.find(([re]) => re.test(route))?.[1] : null;
  return name ? `رجوع إلى ${name}` : "رجوع";
}

const FOCUS_KEY = "finalpro_return_focus";

/** Before leaving a product page back to a listing: that listing should
 * land on this product's card. */
export function rememberReturnFocus(canonicalProductId: string): void {
  try {
    sessionStorage.setItem(FOCUS_KEY, canonicalProductId);
  } catch {
    // Storage blocked: the listing simply keeps its own scroll.
  }
}

/** The product a listing should scroll to - read once, then forgotten. */
export function takeReturnFocus(): string | null {
  try {
    const id = sessionStorage.getItem(FOCUS_KEY);
    sessionStorage.removeItem(FOCUS_KEY);
    return id;
  } catch {
    return null;
  }
}

