"use client";

import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { setPreviewReadOnly } from "@/lib/api";
import "@/lib/storeHomeText";
import { useT } from "@/lib/useLang";

/**
 * P1 «معاينة آمنة» (2026-11-22): nothing done inside the owner's preview of
 * her unpublished home page has an effect - no link or page opens, no
 * filter, cart, favourite, follow or purchase. A click, Enter / Space, a
 * form submit, typing or a choice in a list is stopped (in the capture
 * phase, before any handler of the page) and a short polite message says
 * why. The controls keep their roles, names and focus - never
 * pointer-events:none - and each one is described as unavailable in the
 * preview for screen readers.
 *
 * Exception: what moves the picture locally only (the Hero's arrows and
 * dots, the strips' arrows) carries `data-preview-allow` and works.
 *
 * - "element": the designer's live preview (the designer itself still saves
 *   the draft, so only this part of the page is guarded; it holds no
 *   control that writes).
 * - "document": the store page's full preview - the whole page, plus every
 *   non-GET request refused before it leaves the browser (apiFetch and
 *   window.fetch / sendBeacon), even if a control slipped past.
 */

export const PREVIEW_ALLOW = "data-preview-allow";

/** What acts when used (focus alone is always allowed). */
const ACTIVE =
  'a[href], button, input, select, textarea, summary, label, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], [role="option"], [contenteditable="true"]';
const DESCRIBE = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="switch"], [role="menuitem"]';

export function PreviewGuard({ mode, children, className }: { mode: "element" | "document"; children?: ReactNode; className?: string }) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const descId = useId();
  const [message, setMessage] = useState("");
  const last = useRef(0);
  const hide = useRef<number | null>(null);

  const notify = useCallback(() => {
    const now = Date.now();
    if (now - last.current < 1200) return;
    last.current = now;
    // clear then set: the same words are announced again
    setMessage("");
    window.setTimeout(() => setMessage(t("home.preview_blocked")), 30);
    if (hide.current !== null) window.clearTimeout(hide.current);
    hide.current = window.setTimeout(() => setMessage(""), 4500);
  }, [t]);

  useEffect(() => {
    const root: HTMLElement | Document | null = mode === "document" ? document : rootRef.current;
    if (!root) return;
    const within = (el: Element) => (mode === "document" ? true : (root as HTMLElement).contains(el));
    const target = (e: Event): Element | null => {
      const el = (e.target as Element | null)?.closest?.(ACTIVE) ?? null;
      if (!el || !within(el) || el.closest(`[${PREVIEW_ALLOW}]`)) return null;
      return el;
    };
    const stop = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      notify();
    };
    const onClick = (e: Event) => {
      if (target(e)) stop(e);
    };
    const onKey = (e: KeyboardEvent) => {
      const el = target(e);
      if (!el) return;
      const tag = el.tagName;
      const listLike = tag === "SELECT" || (tag === "INPUT" && (el as HTMLInputElement).type === "range");
      if (e.key === "Enter" || e.key === " " || (listLike && /^Arrow|^Page|^Home$|^End$/.test(e.key))) stop(e);
    };
    const onPointer = (e: Event) => {
      const el = target(e);
      if (el && (el.tagName === "SELECT" || (el.tagName === "INPUT" && (el as HTMLInputElement).type === "range"))) stop(e);
    };
    const onTyping = (e: Event) => {
      if (target(e)) stop(e);
    };
    const onSubmit = (e: Event) => {
      const form = e.target as Element | null;
      if (form && within(form) && !form.closest(`[${PREVIEW_ALLOW}]`)) stop(e);
    };
    const opts = { capture: true } as const;
    root.addEventListener("click", onClick, opts);
    root.addEventListener("keydown", onKey as EventListener, opts);
    root.addEventListener("pointerdown", onPointer, opts);
    root.addEventListener("beforeinput", onTyping, opts);
    root.addEventListener("submit", onSubmit, opts);

    // screen readers: each control is described as unavailable in the preview
    const scope = mode === "document" ? document.body : (root as HTMLElement);
    const describe = () => {
      scope.querySelectorAll(DESCRIBE).forEach((el) => {
        if (el.closest(`[${PREVIEW_ALLOW}]`)) return;
        const ids = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
        if (!ids.includes(descId)) el.setAttribute("aria-describedby", [...ids, descId].join(" "));
      });
    };
    describe();
    let frame = 0;
    const mo = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(describe);
    });
    mo.observe(scope, { childList: true, subtree: true });

    // the full preview: no write leaves the browser
    let restore: (() => void) | null = null;
    if (mode === "document") {
      setPreviewReadOnly(true, notify);
      const realFetch = window.fetch;
      const hasBeacon = typeof navigator.sendBeacon === "function";
      const realBeacon = hasBeacon ? navigator.sendBeacon.bind(navigator) : null;
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        if (method !== "GET" && method !== "HEAD") {
          notify();
          return Promise.reject(new TypeError("The preview is read only"));
        }
        return realFetch(input, init);
      };
      if (hasBeacon) navigator.sendBeacon = () => {
        notify();
        return false;
      };
      restore = () => {
        window.fetch = realFetch;
        if (realBeacon) navigator.sendBeacon = realBeacon;
        setPreviewReadOnly(false);
      };
    }

    return () => {
      root.removeEventListener("click", onClick, opts);
      root.removeEventListener("keydown", onKey as EventListener, opts);
      root.removeEventListener("pointerdown", onPointer, opts);
      root.removeEventListener("beforeinput", onTyping, opts);
      root.removeEventListener("submit", onSubmit, opts);
      mo.disconnect();
      cancelAnimationFrame(frame);
      scope.querySelectorAll(`[aria-describedby~="${CSS.escape(descId)}"]`).forEach((el) => {
        const ids = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((x) => x && x !== descId);
        if (ids.length) el.setAttribute("aria-describedby", ids.join(" "));
        else el.removeAttribute("aria-describedby");
      });
      restore?.();
      if (hide.current !== null) window.clearTimeout(hide.current);
    };
  }, [mode, notify, descId]);

  const notice = (
    <>
      <span id={descId} hidden>{t("home.preview_unavailable")}</span>
      <div className={`pv-toast${message ? " is-on" : ""}${mode === "document" ? " is-page" : ""}`} role="status" aria-live="polite" data-testid="preview-blocked" {...{ [PREVIEW_ALLOW]: "" }}>
        {message}
      </div>
    </>
  );
  if (mode === "document") return notice;
  return (
    <div ref={rootRef} className={className} data-preview-guard>
      {children}
      {notice}
    </div>
  );
}
