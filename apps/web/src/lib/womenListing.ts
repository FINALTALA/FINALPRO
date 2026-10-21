"use client";

import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { ApiError, apiFetch } from "./api";
import type { BrowsePageDto, ComparisonCardDto } from "./types";

// Infinite scroll for the women's listing: cursor pagination against
// /discovery/all's browse mode (server-side sort/filter/category), kept
// in a module-level store so that
//  - every effect stays free of setState (useSyncExternalStore reads it),
//  - one request is in flight at a time, superseded ones are aborted,
//    and a late response for an old filter can never be appended,
//  - coming BACK to the page (browser back/forward) restores the loaded
//    products, filters and scroll position without refetching.

export const WOMEN_PAGE_SIZE = 20;

export type WomenListingSort = "newest" | "price-asc" | "price-desc" | "discounts";
export type WomenListingFilter = "trend" | "discounts";

export interface WomenListingQuery {
  sort: WomenListingSort;
  filter: WomenListingFilter | null;
  category: string | null;
}

export type WomenListingStatus = "idle" | "loading" | "error" | "done";

export interface WomenListingState {
  /** The page mount that owns the list (null until one activates it). */
  owner: symbol | null;
  key: string;
  query: WomenListingQuery | null;
  items: ComparisonCardDto[];
  nextCursor: string | null;
  total: number;
  status: WomenListingStatus;
  error: string | null;
  categoryCounts: Record<string, number> | null;
  allCount: number | null;
  /** Window scroll position saved when leaving the page via a link. */
  scrollY: number | null;
}

const EMPTY: WomenListingState = {
  owner: null,
  key: "",
  query: null,
  items: [],
  nextCursor: null,
  total: 0,
  status: "idle",
  error: null,
  categoryCounts: null,
  allCount: null,
  scrollY: null,
};

let state: WomenListingState = EMPTY;
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

function emit(next: WomenListingState) {
  state = next;
  listeners.forEach((listener) => listener());
}

function queryKey(query: WomenListingQuery): string {
  return `${query.sort}|${query.filter ?? ""}|${query.category ?? ""}`;
}

function pagePath(query: WomenListingQuery, cursor: string | null, withFacets: boolean): string {
  const params = new URLSearchParams({ segment: "women", page_size: String(WOMEN_PAGE_SIZE), sort: query.sort });
  if (query.filter) params.set("filter", query.filter);
  if (query.category) params.set("category", query.category);
  if (cursor) params.set("cursor", cursor);
  if (withFacets) params.set("facets", "categories");
  return `/discovery/all?${params.toString()}`;
}

function loadMore() {
  const current = state;
  const isFirstPage = current.items.length === 0;
  if (!current.query || current.status === "loading" || current.status === "done" || current.status === "error") return;
  if (!isFirstPage && !current.nextCursor) return;

  const key = current.key;
  const request = new AbortController();
  controller = request;
  emit({ ...current, status: "loading", error: null });

  apiFetch<BrowsePageDto>(pagePath(current.query, current.nextCursor, current.categoryCounts === null), {
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
      });
    })
    .catch((error: unknown) => {
      if (state.key !== key || request.signal.aborted) return;
      emit({
        ...state,
        status: "error",
        error: error instanceof ApiError ? error.message : "تعذّر تحميل المنتجات",
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
 * came back with the browser's back/forward button and a list is cached,
 * returns the query to restore; otherwise null (a fresh listing).
 */
export function takeWomenListingRestore(): { query: WomenListingQuery; scrollY: number } | null {
  const returning = performance.now() - lastPopStateAt < RESTORE_WINDOW_MS;
  if (!returning || state.query === null || state.items.length === 0 || state.scrollY === null) return null;
  return { query: state.query, scrollY: state.scrollY };
}

export function useWomenListing(query: WomenListingQuery, restoreScrollY: number | null) {
  const [owner] = useState(() => Symbol("women-listing"));
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const key = queryKey(query);
  const { sort, filter, category } = query;

  // Take ownership for this query: reuse the cached list when restoring
  // (or when this mount already owns it), otherwise start from page one.
  useEffect(() => {
    const restoring = restoreScrollY !== null && state.key === key && state.items.length > 0;
    if (state.key === key && (state.owner === owner || restoring)) {
      if (state.owner !== owner) emit({ ...state, owner });
      return;
    }
    controller?.abort();
    controller = null;
    emit({
      ...EMPTY,
      owner,
      key,
      query: { sort, filter, category },
      categoryCounts: state.categoryCounts,
      allCount: state.allCount,
    });
    loadMore();
  }, [owner, key, sort, filter, category, restoreScrollY]);

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
  const visible =
    snapshot.owner === owner || restoringNow
      ? snapshot
      : { ...EMPTY, status: "loading" as const, categoryCounts: snapshot.categoryCounts, allCount: snapshot.allCount };

  return {
    items: visible.items,
    total: visible.total,
    status: visible.status,
    error: visible.error,
    hasMore: visible.nextCursor !== null,
    categoryCounts: visible.categoryCounts,
    allCount: visible.allCount,
    loadMore,
    retry: () => {
      if (state.status !== "error") return;
      emit({ ...state, status: "idle", error: null });
      loadMore();
    },
  };
}
