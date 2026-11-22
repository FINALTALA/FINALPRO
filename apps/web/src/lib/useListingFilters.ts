"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { DiscoveryFilters, filtersToSearch, parseFilters } from "./discoveryFilters";

// The listing filters live in the page URL's query string - the single
// source of truth, so a refresh, a shared link and back/forward all show
// the same results. Read through useSyncExternalStore (location.search +
// popstate), so no Suspense boundary is needed and the server render is
// the unfiltered page.

const listeners = new Set<() => void>();
function notify() {
  listeners.forEach((listener) => listener());
}
if (typeof window !== "undefined") {
  window.addEventListener("popstate", notify);
}

const store = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: () => window.location.search,
  getServerSnapshot: () => "",
};

export function useListingFilters() {
  const search = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const filters = useMemo(() => parseFilters(search), [search]);

  /** Applies new filters: a new history entry (back returns to the
   * previous result set), keeping the path and the hash. */
  const setFilters = useCallback((next: DiscoveryFilters) => {
    const query = filtersToSearch(next);
    if (query === window.location.search || (query === "" && window.location.search === "")) return;
    const url = `${window.location.pathname}${query}${window.location.hash}`;
    window.history.pushState(window.history.state, "", url);
    notify();
  }, []);

  return { filters, setFilters };
}
