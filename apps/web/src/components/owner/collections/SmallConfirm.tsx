"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * A SMALL decision dialog (a delete confirmation) - the only kind of modal
 * allowed over the management window. Esc and a click outside cancel; focus
 * stays inside; the safe choice («إلغاء») is focused first.
 */
export function SmallConfirm({
  title,
  lead,
  confirmLabel,
  cancelLabel,
  busy,
  tone = "danger",
  onConfirm,
  onCancel,
}: {
  title: string;
  lead: string;
  confirmLabel: string;
  cancelLabel: string;
  busy?: boolean;
  /** «danger» for a delete; «primary» for a final go-ahead (publishing). */
  tone?: "danger" | "primary";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef(onCancel);
  useEffect(() => {
    cancelRef.current = onCancel;
  }, [onCancel]);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLButtonElement>("[data-cancel]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        cancelRef.current();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);
  function trap(e: React.KeyboardEvent) {
    if (e.key !== "Tab" || !ref.current) return;
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>("button:not([disabled])"));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
  return createPortal(
    <div className="ws-confirm-backdrop cpd-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div ref={ref} className="cpd" role="alertdialog" aria-modal="true" aria-labelledby="small-confirm-title" aria-describedby="small-confirm-lead" onKeyDown={trap} data-testid="small-confirm">
        <h2 id="small-confirm-title" className="cpd-title">{title}</h2>
        <p id="small-confirm-lead" className="cpd-lead">{lead}</p>
        <div className="cpd-actions">
          <button type="button" className={tone === "primary" ? "button owner-primary" : "button cpd-danger"} onClick={onConfirm} disabled={busy} data-testid="small-confirm-ok">
            {confirmLabel}
          </button>
          <button type="button" className="button-link cpd-cancel" onClick={onCancel} disabled={busy} data-cancel>
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
