"use client";

import { useEffect, useSyncExternalStore } from "react";
import { apiFetch } from "./api";
import { registerTranslations, translate } from "./i18n";
import { useLang } from "./useLang";

registerTranslations({
  ar: { "tax.load_failed": "تعذّر تحميل خيارات التصفية" },
  en: { "tax.load_failed": "Couldn't load the filter options" },
});

// GET /taxonomy - the fixed audiences, categories, seasons, colours and
// sizes. Fetched once per page load and shared by every listing; nothing
// in the UI keeps its own copy of these lists.

export interface TaxonomyOption {
  code: string;
  name_ar: string;
  name_en: string;
  sort_order: number;
}

export interface TaxonomyCategory extends TaxonomyOption {
  audiences: string[];
  /** PD-4: whether a size guide can describe this category (false for accessories). */
  size_guide?: boolean;
}

export interface TaxonomyColor extends TaxonomyOption {
  hex: string | null;
}

export interface TaxonomySize {
  code: string;
  label: string;
  group: "ADULT" | "KIDS_AGE";
  sort_order: number;
}

export interface TaxonomyDto {
  version: number;
  audiences: TaxonomyOption[];
  seasons: TaxonomyOption[];
  categories: TaxonomyCategory[];
  colors: TaxonomyColor[];
  sizes: TaxonomySize[];
}

type TaxonomyState =
  | { status: "loading"; data: null; error: null }
  | { status: "ready"; data: TaxonomyDto; error: null }
  | { status: "error"; data: null; error: string };

const LOADING: TaxonomyState = { status: "loading", data: null, error: null };
let state: TaxonomyState = LOADING;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(next: TaxonomyState) {
  state = next;
  listeners.forEach((listener) => listener());
}

function load() {
  if (state.status === "ready" || inFlight) return;
  inFlight = apiFetch<TaxonomyDto>("/taxonomy", { auth: false })
    .then((data) => emit({ status: "ready", data, error: null }))
    .catch(() => emit({ status: "error", data: null, error: "tax.load_failed" }))
    .finally(() => {
      inFlight = null;
    });
}

const store = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: () => state,
  getServerSnapshot: () => LOADING,
};

export function useTaxonomy() {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const lang = useLang();
  useEffect(load, []);
  // TB-25: the state keeps a key; the page gets the words in its language.
  const localized: TaxonomyState =
    snapshot.status === "error" ? { ...snapshot, error: translate(lang, snapshot.error) } : snapshot;
  return {
    ...localized,
    retry: () => {
      if (state.status !== "error") return;
      emit(LOADING);
      load();
    },
  };
}
