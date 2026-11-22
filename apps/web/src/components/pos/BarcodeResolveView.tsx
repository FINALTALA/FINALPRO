"use client";

import { useState } from "react";
import { BarcodeScanner } from "@/components/pos/BarcodeScanner";
import { BarcodeVisual } from "@/components/pos/BarcodeVisual";
import { apiFetch } from "@/lib/api";
import { usePrintList } from "@/lib/printList";
import { fillPos, posErrorText } from "@/lib/storePosText";
import { useLang, useT } from "@/lib/useLang";

export interface MissingBarcodeItem {
  draft_id: string;
  title: string;
}
interface Generated {
  draft_id: string;
  title: string;
  code: string;
  display_code: string;
  format: "EAN13";
  price: number | null;
}

/**
 * Before bulk publishing (the batch's own screen, the same window): the
 * chosen drafts that still have no store barcode. The barcode stays required
 * - this resolves it instead of only refusing:
 *  1) «إدخال/مسح باركود لكل منتج»: one field per product (store scanner,
 *     camera or typing), the code for the whole product, saved one by one;
 *  2) «إنشاء باركودات من النظام»: one in-store code for each of THESE drafts
 *     only, shown as bars and added to this device's print list.
 * Then back to the preflight and publishing.
 */
export function BarcodeResolveView({
  vendorId,
  items,
  onContinue,
  onBack,
  onPrintLabels,
}: {
  vendorId: string;
  items: MissingBarcodeItem[];
  /** back to the preflight (asked again - what is still missing comes back here) */
  onContinue: () => void;
  onBack: () => void;
  onPrintLabels: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const printList = usePrintList(vendorId);
  const [mode, setMode] = useState<"choose" | "manual" | "generated">("choose");
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<Generated[]>([]);
  const n = items.length;

  async function save(draftId: string, code: string) {
    setBusy(draftId);
    setRowError((e) => ({ ...e, [draftId]: "" }));
    try {
      const r = await apiFetch<{ display_code: string }>(`/vendors/${vendorId}/offer-drafts/${draftId}/store-barcode`, { method: "PUT", body: { code } });
      setSaved((s) => ({ ...s, [draftId]: r.display_code }));
    } catch (err) {
      setRowError((e) => ({ ...e, [draftId]: posErrorText(err, lang) }));
    } finally {
      setBusy(null);
    }
  }

  async function generate() {
    setBusy("generate");
    setError(null);
    try {
      const r = await apiFetch<{ items: Generated[] }>(`/vendors/${vendorId}/offer-drafts/store-barcodes/generate`, {
        method: "POST",
        body: { draft_ids: items.map((i) => i.draft_id) },
      });
      setGenerated(r.items);
      printList.add(
        r.items.map((g) => ({ code: g.code, display_code: g.display_code, format: g.format, title_ar: g.title, title_en: "", offer_id: null, price: g.price })),
      );
      setMode("generated");
    } catch (err) {
      setError(posErrorText(err, lang));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="pos-ui bpb" data-testid="bp-barcodes">
      <header className="pos-screen-head">
        <p className="pos-eyebrow">{t("bpb.eyebrow")}</p>
        <h1 className="pos-screen-title" tabIndex={-1}>{fillPos(t("bpb.title"), { n })}</h1>
        <p className="pos-screen-lead">{t("bpb.lead")}</p>
      </header>
      {error && <p className="pos-inline-error" role="alert">{error}</p>}

      {mode === "choose" && (
        <>
          <ul className="bpb-names">
            {items.map((i) => (
              <li key={i.draft_id} dir="auto">{i.title}</li>
            ))}
          </ul>
          <div className="bpb-options">
            <button type="button" className="bpb-option" onClick={() => setMode("manual")} data-testid="bpb-manual">
              <strong>{t("bpb.manual")}</strong>
              <span>{t("bpb.manual.hint")}</span>
            </button>
            <button type="button" className="bpb-option is-primary" disabled={busy !== null} onClick={() => void generate()} data-testid="bpb-generate">
              <strong>{fillPos(t("bpb.generate"), { n })}</strong>
              <span>{t("bpb.generate.hint")}</span>
            </button>
          </div>
          <button type="button" className="pos-link-btn" onClick={onBack} data-testid="bpb-back">{t("bp.back_to_batch")}</button>
        </>
      )}

      {mode === "manual" && (
        <>
          <ul className="bpb-rows">
            {items.map((i) => (
              <li key={i.draft_id} className={`bpb-row${saved[i.draft_id] ? " is-done" : ""}`} data-testid="bpb-row">
                <strong dir="auto">{i.title}</strong>
                {saved[i.draft_id] ? (
                  <p className="pos-inline-notice" role="status">
                    ✓ <span dir="ltr" className="pos-code-number">{saved[i.draft_id]}</span>
                  </p>
                ) : (
                  <BarcodeScanner
                    id={`bpb-${i.draft_id}`}
                    label={t("bpb.code_for")}
                    submitLabel={t("bpb.save")}
                    busy={busy === i.draft_id}
                    testId={`bpb-code-${i.draft_id}`}
                    onSubmit={(code) => void save(i.draft_id, code)}
                  />
                )}
                {rowError[i.draft_id] && <p className="pos-inline-error" role="alert">{rowError[i.draft_id]}</p>}
              </li>
            ))}
          </ul>
          <p className="pos-note">{fillPos(t("bpb.saved_count"), { done: Object.keys(saved).length, n })}</p>
          <div className="pos-actions-bar">
            <button type="button" className="pos-btn pos-btn-primary" onClick={onContinue} data-testid="bpb-continue">{t("bpb.back_to_publish")}</button>
            <button type="button" className="pos-link-btn" onClick={() => setMode("choose")}>{t("bpb.other_way")}</button>
          </div>
        </>
      )}

      {mode === "generated" && (
        <>
          <p className="pos-done" role="status" data-testid="bpb-generated">{fillPos(t("bpb.generated"), { n: generated.length })}</p>
          <ul className="bpb-codes">
            {generated.map((g) => (
              <li key={g.draft_id}>
                <span dir="auto">{g.title}</span>
                <BarcodeVisual code={g.display_code} format={g.format} height={28} className="pos-barcode-mini" />
              </li>
            ))}
          </ul>
          <p className="pos-note">{t("bpb.print_later")}</p>
          <div className="pos-actions-bar">
            <button type="button" className="pos-btn pos-btn-primary" onClick={onContinue} data-testid="bpb-continue">{t("bpb.continue")}</button>
            <button type="button" className="pos-btn pos-btn-secondary" onClick={onPrintLabels} data-testid="bpb-print">{t("bpb.review_print")}</button>
          </div>
        </>
      )}
    </div>
  );
}
