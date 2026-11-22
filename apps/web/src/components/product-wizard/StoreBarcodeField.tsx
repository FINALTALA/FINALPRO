"use client";

import { useId, useState } from "react";
import { BarcodeScanner } from "@/components/pos/BarcodeScanner";
import { GeneratedBarcodeCard } from "@/components/pos/BarcodeVisual";
import { apiFetch } from "@/lib/api";
import type { DraftPayload } from "@/lib/offerWizard";
import { posErrorText } from "@/lib/storePosText";
import { useLang } from "@/lib/useLang";
import "@/lib/storePosText";

type Choice = "external" | "generate";

/**
 * «باركود المنتج للمحل» on the wizard's review step, right under the price
 * (a NEW product): a draft is saved without it, but the product is published
 * only with one - a code already on the item (store scanner, camera or
 * typed) or one the system makes NOW (shown as real bars with its digits,
 * with «أضف إلى صفحة الطباعة»). The choice is saved with the draft as it is;
 * the server checks it and names any problem here - never dropped.
 */
export function StoreBarcodeField({
  vendorId,
  payload,
  update,
  t,
  problems,
  onGoToPrint,
}: {
  vendorId: string;
  payload: DraftPayload;
  update: (fn: (p: DraftPayload) => DraftPayload) => void;
  t: (key: string) => string;
  /** the server's STORE_BARCODE problem texts, already worded */
  problems: string[];
  /** saves the draft, then opens the print page */
  onGoToPrint: () => void;
}) {
  const uid = useId();
  const lang = useLang();
  const current = payload.store_barcode;
  const choice: Choice | null = current?.mode === "external" || current?.mode === "generate" ? current.mode : null;
  const code = current?.mode === "external" ? current.code : "";
  const generated = current?.mode === "generate" ? current.code ?? null : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (next: DraftPayload["store_barcode"]) => update((p) => ({ ...p, store_barcode: next }));

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch<{ code: string }>(`/vendors/${vendorId}/barcodes/reserve`, { method: "POST" });
      set({ mode: "generate", code: r.code });
    } catch (err) {
      setError(posErrorText(err, lang));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="pos-ui pos-panel wz-store-barcode" aria-labelledby={`${uid}-title`} data-testid="wz-store-barcode">
      <div className="pos-panel-head">
        <h3 id={`${uid}-title`}>
          {t("wzb.title")} <span className="wz-req">({t("wzb.required")})</span>
        </h3>
      </div>
      <p className="pos-panel-lead">{t("wzb.lead")}</p>
      <div className="pos-choices-row" role="radiogroup" aria-labelledby={`${uid}-title`}>
        {(["external", "generate"] as const).map((c) => (
          <label key={c} className={`pos-choice${choice === c ? " is-selected" : ""}`}>
            <input
              type="radio"
              name={`${uid}-mode`}
              value={c}
              checked={choice === c}
              disabled={busy}
              onChange={() => {
                if (c === "external") set({ mode: "external", code });
                else void generate();
              }}
              data-testid={`wzb-${c}`}
            />
            <span>
              <strong>{t(`wzb.${c}`)}</strong>
              <small>{t(`wzb.${c}.hint`)}</small>
            </span>
          </label>
        ))}
      </div>
      {choice === "external" && (
        <BarcodeScanner
          id={`${uid}-code`}
          label={t("wzb.code")}
          submitLabel={t("wzb.use")}
          keepValue
          initialValue={code}
          testId="wzb-code"
          onChange={(value) => set({ mode: "external", code: value })}
          onSubmit={(value) => set({ mode: "external", code: value.trim() })}
        />
      )}
      {choice === "generate" && generated && (
        <GeneratedBarcodeCard
          vendorId={vendorId}
          item={{
            code: generated,
            display_code: generated,
            format: "EAN13",
            title_ar: payload.title_ar ?? "",
            title_en: payload.title_en ?? "",
            offer_id: null,
            price: payload.price ?? null,
          }}
          onGoToPrint={onGoToPrint}
        />
      )}
      {choice === "generate" && !generated && (
        <button type="button" className="pos-btn pos-btn-primary" disabled={busy} onClick={() => void generate()}>
          {t("wzb.generate_now")}
        </button>
      )}
      {busy && <p className="pos-note" role="status">{t("wzb.generating")}</p>}
      {error && <p className="pos-inline-error" role="alert">{error}</p>}
      {problems.map((p) => (
        <p key={p} className="pos-inline-error" role="alert" data-testid="wzb-problem">{p}</p>
      ))}
    </section>
  );
}
