"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { takeReturnFocus } from "@/lib/navTrail";

const WAIT_MS = 6000;
const HIGHLIGHT_MS = 1800;

/**
 * Mounted once in the app shell: after a "back" arrow (BackToOrigin),
 * the listing it returns to scrolls to the product the shopper was
 * viewing and highlights its card - waiting for the cards to load.
 */
export default function ReturnFocus() {
  const pathname = usePathname();
  useEffect(() => {
    const id = takeReturnFocus();
    if (!id) return;
    const selector = `[data-product-id="${CSS.escape(id)}"]`;
    let timer = 0;
    const find = () => {
      const card = document.querySelector<HTMLElement>(selector);
      if (!card) return false;
      card.scrollIntoView({ block: "center", behavior: "smooth" });
      card.classList.add("is-return-focus");
      timer = window.setTimeout(() => card.classList.remove("is-return-focus"), HIGHLIGHT_MS);
      return true;
    };
    // The listing may still be loading (or restoring its own scroll).
    const started = Date.now();
    const observer = new MutationObserver(() => {
      if (find() || Date.now() - started > WAIT_MS) observer.disconnect();
    });
    const first = window.setTimeout(() => {
      if (!find()) observer.observe(document.body, { childList: true, subtree: true });
    }, 120);
    const stop = window.setTimeout(() => observer.disconnect(), WAIT_MS);
    return () => {
      observer.disconnect();
      window.clearTimeout(first);
      window.clearTimeout(stop);
      window.clearTimeout(timer);
    };
  }, [pathname]);
  return null;
}
