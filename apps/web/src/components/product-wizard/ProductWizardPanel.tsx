"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { inManagementFrame, pushFrameScreen, requestFrameEscape } from "@/lib/manageFrame";
import "@/lib/offerWizardText";
import { useT } from "@/lib/useLang";
import { ProductWizard, type WizardContext, type WizardResult } from "./ProductWizard";

/** What opens the panel: a new product (with the list's context) or an existing draft. */
export type WizardOpen = { draftId: string | null; context?: WizardContext };

/**
 * The product-entry wizard as a large panel over the page it was opened
 * from (the storefront's «إضافة منتج», the store's products table): the
 * list stays behind it, unchanged, until the wizard closes. Full screen on
 * a phone. A modal dialog: focus stays inside, Esc closes it the same way
 * as its close button (nothing entered -> just closes; otherwise saved
 * first), and focus returns to what opened it.
 *
 * Inside the store's management frame (an iframe) it is not a second
 * panel: it fills the frame's content, and the frame's header carries its
 * title, «رجوع» and the one × (lib/manageFrame.ts).
 */
export function ProductWizardPanel({
  vendorId,
  open,
  onClose,
}: {
  vendorId: string;
  open: WizardOpen;
  onClose: (result: WizardResult) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<(() => void) | null>(null);
  // Switching to another draft from «مسوداتي» re-mounts the wizard on it.
  const [current, setCurrent] = useState<WizardOpen>(open);
  const t = useT();
  const [framed] = useState(() => inManagementFrame());
  const frameDoneRef = useRef<(() => void) | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!framed) return;
    return pushFrameScreen({
      title: () => t("catalog.new"),
      // «رجوع» and × both save first (the wizard's own close), then leave
      back: () => closeRef.current?.(),
      close: (done) => {
        frameDoneRef.current = done;
        closeRef.current?.();
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [framed]);
  function closed(result: WizardResult) {
    const done = frameDoneRef.current;
    frameDoneRef.current = null;
    done?.();
    onCloseRef.current(result);
  }

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    const previousRootOverflow = document.documentElement.style.overflow;
    // No page scrollbar behind the panel: only the panel's own body scrolls.
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    requestAnimationFrame(() => {
      const first = dialogRef.current?.querySelector<HTMLElement>("#wz-panel-title, [data-testid='wz-panel-back']");
      (first ?? dialogRef.current)?.focus();
    });
    return () => {
      document.body.style.overflow = previousOverflow;
      document.documentElement.style.overflow = previousRootOverflow;
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (framed) requestFrameEscape();
      else closeRef.current?.();
      return;
    }
    if (framed || e.key !== "Tab" || !dialogRef.current) return;
    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // Rendered straight into <body>: a page container with a transform (the
  // storefront's entrance animation) would otherwise become the panel's
  // containing block and clip it to the products section.
  return createPortal(
    <div className={framed ? "wzp-backdrop is-framed" : "wzp-backdrop"} data-testid="wz-panel-backdrop">
      <div
        ref={dialogRef}
        className={framed ? "wzp is-framed" : "wzp"}
        role={framed ? "region" : "dialog"}
        aria-modal={framed ? undefined : "true"}
        aria-labelledby="wz-panel-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        data-testid="wz-panel"
      >
        <ProductWizard
          key={current.draftId ?? "new"}
          vendorId={vendorId}
          draftId={current.draftId}
          context={current.context}
          mode="panel"
          onClose={closed}
          onOpenDraft={(id) => setCurrent({ draftId: id })}
          closeRef={closeRef}
        />
      </div>
    </div>,
    document.body,
  );
}
