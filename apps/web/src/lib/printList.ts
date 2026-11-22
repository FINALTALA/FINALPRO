"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { apiFetch } from "./api";

/**
 * The store's label print list, kept on THIS device for this store and this
 * person (localStorage) until the labels are printed or removed - it survives
 * moving between management screens, «رجوع» and a reload. Each item is one
 * product + the barcode chosen for it, with its copies and whether it is
 * selected for the next print. Titles / price are a snapshot, refreshed by
 * the print page when the code belongs to a product.
 */
export interface PrintItem {
  /** the stored code (the item's identity in the list) */
  code: string;
  display_code: string;
  format: "EAN13" | "EAN8" | "UPCA" | "CODE128";
  title_ar: string;
  title_en: string;
  /** null while the product is still a draft (a code reserved in the wizard) */
  offer_id: string | null;
  price: number | null;
  copies: number;
  selected: boolean;
}

const EVENT = "finalpro:print-list";
const keyOf = (vendorId: string, userId: string) => `fp.printlist.${vendorId}.${userId}`;

function read(key: string): PrintItem[] {
  try {
    const raw = window.localStorage.getItem(key);
    const list = raw ? (JSON.parse(raw) as PrintItem[]) : [];
    return Array.isArray(list) ? list.filter((i) => i && typeof i.code === "string") : [];
  } catch {
    return [];
  }
}
function write(key: string, items: PrintItem[]) {
  try {
    if (items.length) window.localStorage.setItem(key, JSON.stringify(items));
    else window.localStorage.removeItem(key);
  } catch {
    // blocked storage: the list lives for this page only
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: key }));
}

// a stable snapshot per key (useSyncExternalStore needs the same object until it changes)
const cache = new Map<string, { raw: string | null; items: PrintItem[] }>();
function snapshot(key: string): PrintItem[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    raw = null;
  }
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.items;
  const items = read(key);
  cache.set(key, { raw, items });
  return items;
}
const EMPTY: PrintItem[] = [];

function subscribe(onChange: () => void) {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

// who is signed in, per store (the cashier's start answers it) - one request per store
const viewers = new Map<string, Promise<string | null>>();
export function useStoreViewer(vendorId: string): string | null {
  const [userId, setUserId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!viewers.has(vendorId)) {
      viewers.set(
        vendorId,
        apiFetch<{ user_id: string }>(`/vendors/${vendorId}/cashier`)
          .then((r) => r.user_id)
          .catch(() => {
            viewers.delete(vendorId);
            return null;
          }),
      );
    }
    void viewers.get(vendorId)!.then((id) => {
      if (!cancelled) setUserId(id);
    });
    return () => {
      cancelled = true;
    };
  }, [vendorId]);
  return userId;
}

export function usePrintList(vendorId: string) {
  const userId = useStoreViewer(vendorId);
  const key = userId ? keyOf(vendorId, userId) : null;
  const items = useSyncExternalStore(subscribe, () => (key ? snapshot(key) : EMPTY), () => EMPTY);

  const change = useCallback(
    (fn: (list: PrintItem[]) => PrintItem[]) => {
      if (!key) return;
      write(key, fn(read(key)));
    },
    [key],
  );
  /** Adds (or, already there, selects again) - one card per code. */
  const add = useCallback(
    (entries: Omit<PrintItem, "copies" | "selected">[]) =>
      change((list) => {
        const next = [...list];
        for (const e of entries) {
          const at = next.findIndex((i) => i.code === e.code);
          if (at >= 0) next[at] = { ...next[at], ...e, selected: true };
          else next.push({ ...e, copies: 1, selected: true });
        }
        return next;
      }),
    [change],
  );
  const remove = useCallback((codes: string[]) => change((list) => list.filter((i) => !codes.includes(i.code))), [change]);
  const update = useCallback(
    (code: string, patch: Partial<PrintItem>) => change((list) => list.map((i) => (i.code === code ? { ...i, ...patch } : i))),
    [change],
  );
  const setAll = useCallback((selected: boolean) => change((list) => list.map((i) => ({ ...i, selected }))), [change]);
  return { ready: key !== null, items, add, remove, update, setAll, has: (code: string) => items.some((i) => i.code === code) };
}
