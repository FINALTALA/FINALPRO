"use client";

import { useEffect, useState } from "react";

/**
 * 2026-11-18 (store notifications): the id a page was opened FOR - e.g.
 * ?order=<branch order id> or ?variant=<version id> from a notification - read
 * once from the page's own URL (no useSearchParams: the pages stay static).
 * Null until mounted or when absent.
 */
export function useHighlightParam(name: string): string | null {
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => {
    // read once after mount (the URL is not available during the static render)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setValue(new URLSearchParams(window.location.search).get(name));
  }, [name]);
  return value;
}

/** Scrolls the highlighted element into view and moves focus to it, once it is on the page. */
export function useScrollToHighlight(selector: string | null, ready: boolean) {
  useEffect(() => {
    if (!selector || !ready) return;
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
    el.focus({ preventScroll: true });
  }, [selector, ready]);
}
