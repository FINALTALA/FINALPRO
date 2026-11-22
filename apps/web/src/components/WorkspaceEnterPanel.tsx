"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiErrorMessage } from "@/lib/apiErrors";
import { useLang, useT } from "@/lib/useLang";
import { enterWorkspaceNow } from "@/lib/workspaceActions";
import "@/lib/workspaceText";

/**
 * Phase A+ (final decision): «إدارة هذا المتجر» on the public store page asks
 * first - in a small panel over the store page itself (no new page or
 * route), with the page blurred behind it, «إلغاء» and «دخول مساحة العمل».
 * Entering is the same API call as everywhere (the membership is checked
 * and the entry audited by the API; the workspace token stays in this tab).
 * Esc or «إلغاء» closes it with nothing entered; focus returns to the opener.
 */
export function WorkspaceEnterPanel({
  vendorId,
  storeName,
  role,
  branchName,
  onCancel,
  onEntered,
}: {
  vendorId: string;
  storeName: string;
  role: "OWNER" | "BRANCH_EMPLOYEE";
  branchName: string | null;
  onCancel: () => void;
  onEntered: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef(onCancel);
  useEffect(() => {
    cancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelRef.current();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const items = [...panelRef.current.querySelectorAll<HTMLElement>("button:not([disabled])")];
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
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      opener?.focus?.();
    };
  }, []);

  async function enter() {
    setBusy(true);
    setError(null);
    try {
      await enterWorkspaceNow({ type: "vendor", vendor_id: vendorId });
      onEntered();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return createPortal(
    <div className="ws-confirm-backdrop" data-testid="ws-confirm-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div ref={panelRef} className="ws-confirm" role="dialog" aria-modal="true" aria-labelledby="ws-confirm-title" aria-describedby="ws-confirm-lead" data-testid="ws-confirm">
        <h2 id="ws-confirm-title" className="ws-confirm-title">{t("ws.enter.title.vendor")}</h2>
        <p className="ws-confirm-name" data-testid="ws-confirm-name">{storeName}</p>
        <p className="ws-confirm-role">
          {t(`ws.enter.role.${role}`)}
          {branchName ? ` · ${t("ws.enter.branch").replace("{name}", branchName)}` : ""}
        </p>
        <p id="ws-confirm-lead" className="ws-confirm-lead">{t("ws.enter.lead")}</p>
        {error !== null && (
          <p role="alert" className="error-text" data-testid="ws-confirm-error">
            {apiErrorMessage(error, lang) || t("ws.enter.failed")}
          </p>
        )}
        <div className="ws-confirm-actions">
          <button type="button" className="button-link" onClick={onCancel} disabled={busy} data-testid="ws-confirm-cancel">
            {t("ws.confirm.cancel")}
          </button>
          <button ref={confirmRef} type="button" className="button" onClick={() => void enter()} disabled={busy} data-testid="ws-confirm-enter">
            {busy ? t("ws.enter.entering") : t("ws.enter.confirm")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
