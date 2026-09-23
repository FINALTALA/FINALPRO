"use client";

import { useEffect, useState } from "react";
import { ApiError, apiFetch } from "./api";

interface FetchState<T> {
  path: string | null;
  data: T | null;
  error: string | null;
  status: number | null;
}

/**
 * Loads `path` (re-fetching when it changes). Pass null to skip. State is
 * keyed by path so a stale response for a previous path is never shown.
 */
export function useFetch<T>(path: string | null, auth = false) {
  const [state, setState] = useState<FetchState<T>>({
    path: null,
    data: null,
    error: null,
    status: null,
  });

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    apiFetch<T>(path, { auth })
      .then((data) => {
        if (!cancelled) setState({ path, data, error: null, status: 200 });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          path,
          data: null,
          error: err instanceof ApiError ? err.message : "تعذّر الاتصال بالخادم",
          status: err instanceof ApiError ? err.status : 0,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [path, auth]);

  const ready = state.path === path;
  return {
    data: ready ? state.data : null,
    error: ready ? state.error : null,
    status: ready ? state.status : null,
    loading: path !== null && !ready,
  };
}
