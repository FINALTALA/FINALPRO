"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiErrors";
import "@/lib/offerWizardText";
import { useLang, useT } from "@/lib/useLang";
import { IconCopy } from "./wizardIcons";

/**
 * Phase A++ (item 1): «نسخ كمنتج جديد» - asks once whether to copy the
 * images (default: no - a copy is usually a different piece), then the
 * server builds the new draft (POST .../offer-drafts { copy_from }) and the
 * caller opens it in the wizard. Quantities, SKUs and status are never
 * copied; the copy is a draft and passes the same publish check.
 *
 * A SMALL modal - a short decision only (never an entry or reading page):
 * the product as one clear line, the two image choices as two cards,
 * «إنشاء النسخة» primary and «إلغاء» quiet. Focus stays inside; Esc and a
 * click outside cancel; focus returns to what opened it.
 */
export function CopyProductDialog({
  vendorId,
  from,
  title,
  onCancel,
  onCopied,
}: {
  vendorId: string;
  from: { offer_id: string } | { draft_id: string };
  title: string;
  onCancel: () => void;
  onCopied: (draftId: string) => void;
}) {
  const t = useT();
  const lang = useLang();
  const [withImages, setWithImages] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef(onCancel);
  const busyRef = useRef(busy);
  useEffect(() => {
    cancelRef.current = onCancel;
    busyRef.current = busy;
  }, [onCancel, busy]);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyRef.current) {
        // the dialog only - not the large panel behind it
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
    if (e.key !== "Tab" || !dialogRef.current) return;
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')).filter(
      (el) => !(el instanceof HTMLInputElement && el.type === "radio" && !el.checked),
    );
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

  async function copy() {
    setBusy(true);
    setError(null);
    try {
      const d = await apiFetch<{ id: string }>(`/vendors/${vendorId}/offer-drafts`, {
        method: "POST",
        body: { copy_from: from, with_images: withImages },
      });
      onCopied(d.id);
    } catch (err) {
      setError(apiErrorMessage(err, lang));
      setBusy(false);
    }
  }

  const choices = [
    { value: false, label: t("copy.without_images"), hint: t("copy.without_images.hint"), testId: "copy-without-images" },
    { value: true, label: t("copy.with_images"), hint: t("copy.with_images.hint"), testId: "copy-with-images" },
  ];

  return createPortal(
    <div className="ws-confirm-backdrop cpd-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div ref={dialogRef} className="cpd" role="dialog" aria-modal="true" aria-labelledby="copy-title" aria-describedby="copy-lead" onKeyDown={trap} data-testid="copy-dialog">
        <div className="cpd-head">
          <span className="cpd-icon" aria-hidden="true">
            <IconCopy />
          </span>
          <h2 id="copy-title" className="cpd-title">{t("copy.title")}</h2>
        </div>
        <div className="cpd-product">
          <span className="cpd-product-label">{t("copy.from")}</span>
          <strong dir="auto">{title}</strong>
        </div>
        <p id="copy-lead" className="cpd-lead">{t("copy.lead")}</p>
        <fieldset className="cpd-choices">
          <legend>{t("copy.images")}</legend>
          {choices.map((c) => (
            <label key={c.testId} className={`cpd-choice${withImages === c.value ? " is-on" : ""}`}>
              <input type="radio" name="copy-images" checked={withImages === c.value} onChange={() => setWithImages(c.value)} data-testid={c.testId} />
              <span className="cpd-choice-text">
                <strong>{c.label}</strong>
                <span>{c.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {error && <p role="alert" className="error-text">{error}</p>}
        <div className="cpd-actions">
          <button type="button" className="button cpd-primary" onClick={() => void copy()} disabled={busy} data-testid="copy-confirm" autoFocus>
            {busy ? t("copy.copying") : t("copy.confirm")}
          </button>
          <button type="button" className="button-link cpd-cancel" onClick={onCancel} disabled={busy}>
            {t("ws.confirm.cancel")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
