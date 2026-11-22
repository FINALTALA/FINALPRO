"use client";

import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { ApiError, apiFetch } from "./api";
import {
  DiscoveryFilters,
  ListingAudience,
  filtersKey,
  filtersToApiParams,
} from "./discoveryFilters";
import type { BrowsePageDto, ComparisonCardDto } from "./types";
import { type Lang, registerTranslations, translate } from "./i18n";
import { apiErrorMessage } from "./apiErrors";
import { useLang } from "./useLang";

registerTranslations({
  ar: { "list.bestseller_off": "ترتيب «الأكثر مبيعاً» غير متاح حالياً - اختاري ترتيباً آخر.", "list.load_failed": "تعذّر تحميل المنتجات" },
  en: { "list.bestseller_off": "The «Bestsellers» sort isn't available right now - choose another sort.", "list.load_failed": "Couldn't load the products" },
});

/** TB-25: a listing failure worded in the interface language (never the server's own text). */
export function listingErrorText(failure: unknown, lang: Lang): string {
  if (failure instanceof ApiError && failure.code === "FEATURE_DISABLED") return translate(lang, "list.bestseller_off");
  if (failure instanceof ApiError) return apiErrorMessage(failure, lang);
  return translate(lang, "list.load_failed");
}

// Infinite scroll for the /women, /men and /kids listings: cursor
// pagination against /discovery/all's browse mode (server-side taxonomy
// filters, price, availability, sort and category counts), kept in a
// module-level store so that
//  - every effect stays free of setState (useSyncExternalStore reads it),
//  - one request is in flight at a time, superseded ones are aborted,
//    and a late response for an old filter can never be appended,
//  - coming BACK to the page (browser back/forward) restores the loaded
//    products and scroll position without refetching.

export const LISTING_PAGE_SIZE = 20;

export type ListingStatus = "idle" | "loading" | "error" | "done";

interface ListingState {
  /** The page mount that owns the list (null until one activates it). */
  owner: symbol | null;
  key: string;
  audience: ListingAudience | null;
  filters: DiscoveryFilters | null;
  items: ComparisonCardDto[];
  nextCursor: string | null;
  total: number;
  status: ListingStatus;
  /** TB-25: the failure itself; worded at render in the interface language. */
  error: unknown;
  categoryCounts: Record<string, number> | null;
  allCount: number | null;
  /** PD-5.3: the API says the Bestseller mark/sort are on. */
  bestsellerEnabled: boolean;
  /** Window scroll position saved when leaving the page via a link. */
  scrollY: number | null;
}

const EMPTY: ListingState = {
  owner: null,
  key: "",
  audience: null,
  filters: null,
  items: [],
  nextCursor: null,
  total: 0,
  status: "idle",
  error: null,
  categoryCounts: null,
  allCount: null,
  bestsellerEnabled: false,
  scrollY: null,
};

let state: ListingState = EMPTY;
const listeners = new Set<() => void>();
let controller: AbortController | null = null;
// When the browser's back/forward button was last used. A page mount
// shortly after it is a "return" (restore); any other mount is a fresh
// visit. Time-boxed rather than a consumed flag so StrictMode's double
// initializer call sees the same answer and a stale flag never leaks
// into a later, unrelated visit.
const RESTORE_WINDOW_MS = 1500;
let lastPopStateAt = -Infinity;
if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    lastPopStateAt = performance.now();
  });
}

function emit(next: ListingState) {
  state = next;
  listeners.forEach((listener) => listener());
}

function loadMore() {
  const current = state;
  const isFirstPage = current.items.length === 0;
  if (!current.audience || !current.filters) return;
  if (current.status === "loading" || current.status === "done" || current.status === "error") return;
  if (!isFirstPage && !current.nextCursor) return;

  const key = current.key;
  const request = new AbortController();
  controller = request;
  emit({ ...current, status: "loading", error: null });

  // Category counts arrive with the first page of every result set (they
  // depend on the other filters, so they are refreshed with them).
  const params = filtersToApiParams(current.audience, current.filters, {
    pageSize: LISTING_PAGE_SIZE,
    cursor: current.nextCursor,
    withFacets: isFirstPage,
  });
  apiFetch<BrowsePageDto>(`/discovery/all?${params.toString()}`, {
    auth: false,
    signal: request.signal,
  })
    .then((page) => {
      if (state.key !== key || request.signal.aborted) return; // stale
      const seen = new Set(state.items.map((item) => item.canonical_product_id));
      const fresh = page.items.filter((item) => !seen.has(item.canonical_product_id));
      emit({
        ...state,
        items: fresh.length ? [...state.items, ...fresh] : state.items,
        nextCursor: page.next_cursor,
        total: page.total,
        status: page.next_cursor ? "idle" : "done",
        categoryCounts: page.category_counts ?? state.categoryCounts,
        allCount: page.all_count ?? state.allCount,
        bestsellerEnabled: page.bestseller_enabled ?? false,
      });
    })
    .catch((error: unknown) => {
      if (state.key !== key || request.signal.aborted) return;
      emit({
        ...state,
        status: "error",
        error: error ?? new Error("listing failed"),
      });
    })
    .finally(() => {
      if (controller === request) controller = null;
    });
}

const store = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: () => state,
  getServerSnapshot: () => EMPTY,
};

/**
 * Called once per page mount (lazy useState initializer): when the user
 * came back with the browser's back/forward button and the cached list is
 * this audience's, returns the scroll position to restore; otherwise null.
 * (The filters themselves come back with the URL.)
 */
export function takeListingRestore(audience: ListingAudience): number | null {
  if (typeof window === "undefined") return null;
  const returning = performance.now() - lastPopStateAt < RESTORE_WINDOW_MS;
  if (!returning || state.audience !== audience || state.items.length === 0 || state.scrollY === null) return null;
  return state.scrollY;
}

export function useAudienceListing(
  audience: ListingAudience,
  filters: DiscoveryFilters,
  restoreScrollY: number | null,
) {
  const lang = useLang();
  const [owner] = useState(() => Symbol("audience-listing"));
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const key = filtersKey(audience, filters);

  // Take ownership for this result set: reuse the cached list when
  // restoring (or when this mount already owns it), otherwise start from
  // page one. Counts are kept until the new first page replaces them, so
  // the category circles do not flash to zero.
  useEffect(() => {
    const restoring = restoreScrollY !== null && state.key === key && state.items.length > 0;
    if (state.key === key && (state.owner === owner || restoring)) {
      if (state.owner !== owner) emit({ ...state, owner });
      return;
    }
    controller?.abort();
    controller = null;
    const sameAudience = state.audience === audience;
    emit({
      ...EMPTY,
      owner,
      key,
      audience,
      filters,
      categoryCounts: sameAudience ? state.categoryCounts : null,
      allCount: sameAudience ? state.allCount : null,
    });
    loadMore();
    // `filters` is fully described by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, key, audience, restoreScrollY]);

  // Remember the scroll position whenever a link is followed from the
  // page, so coming back restores exactly where the user was.
  useEffect(() => {
    function rememberScroll(event: MouseEvent) {
      if (!(event.target instanceof Element) || !event.target.closest("a[href]")) return;
      if (state.owner === owner && state.items.length > 0) state = { ...state, scrollY: window.scrollY };
    }
    document.addEventListener("click", rememberScroll, true);
    return () => document.removeEventListener("click", rememberScroll, true);
  }, [owner]);

  // Restore the scroll position once the cached items are on screen
  // (again on the next frame, after the router's own scroll handling).
  useLayoutEffect(() => {
    if (restoreScrollY === null) return;
    window.scrollTo(0, restoreScrollY);
    const frame = requestAnimationFrame(() => window.scrollTo(0, restoreScrollY));
    return () => cancelAnimationFrame(frame);
  }, [restoreScrollY]);

  // Until this mount owns the list, show nothing stale from an earlier
  // visit - except when restoring, where the cached list IS the content.
  const restoringNow = restoreScrollY !== null && snapshot.key === key && snapshot.items.length > 0;
  const mine = snapshot.owner === owner || restoringNow;
  const sameAudience = snapshot.audience === audience;
  const visible = mine
    ? snapshot
    : {
        ...EMPTY,
        status: "loading" as const,
        categoryCounts: sameAudience ? snapshot.categoryCounts : null,
        allCount: sameAudience ? snapshot.allCount : null,
      };

  return {
    items: visible.items,
    total: visible.total,
    status: visible.status,
    error: visible.status === "error" ? listingErrorText(visible.error, lang) : null,
    hasMore: visible.nextCursor !== null,
    categoryCounts: visible.categoryCounts,
    allCount: visible.allCount,
    bestsellerEnabled: visible.bestsellerEnabled,
    loadMore,
    retry: () => {
      if (state.status !== "error") return;
      emit({ ...state, status: "idle", error: null });
      loadMore();
    },
  };
}
