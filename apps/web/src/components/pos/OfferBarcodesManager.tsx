"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BarcodeScanner, type BarcodeScannerHandle } from "@/components/pos/BarcodeScanner";
import { BarcodeVisual, GeneratedBarcodeCard } from "@/components/pos/BarcodeVisual";
import { usePrintList } from "@/lib/printList";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { fillPos, posErrorText } from "@/lib/storePosText";
import { useLang, useT } from "@/lib/useLang";

export interface BarcodeDto {
  id: string;
  code: string;
  display_code: string;
  format: "EAN13" | "EAN8" | "UPCA" | "CODE128";
  source: "EXTERNAL" | "GENERATED";
  is_primary: boolean;
}
interface BarcodeList {
  items: BarcodeDto[];
  limit: number;
}
interface OfferDto {
  id: string;
  title_ar: string;
  title_en: string;
  status: string;
}

export const FORMAT_LABEL: Record<BarcodeDto["format"], string> = {
  EAN13: "EAN-13",
  EAN8: "EAN-8",
  UPCA: "UPC-A",
  CODE128: "Code 128",
};

/**
 * «إدارة الباركود» of ONE product - its own screen (the management window's
 * content, one «رجوع»), never inside the read-only details: a short row per
 * code (number, type, external / generated, primary), «إنشاء من النظام»
 * (the main action), «مسح أو ربط كود موجود» (secondary: the store scanner or
 * the camera, in this screen), make primary, remove, and «طباعة ملصقات» for
 * the chosen codes. Every change is immediate and audited by the API.
 */
export function OfferBarcodesManager({
  vendorId,
  offerId,
  onPrint,
}: {
  vendorId: string;
  offerId: string;
  /** Opens the print screen (its list is this device's print list). */
  onPrint: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const base = `/vendors/${vendorId}/offers/${offerId}/barcodes`;
  const [offer, setOffer] = useState<OfferDto | null>(null);
  const [list, setList] = useState<BarcodeList | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<BarcodeDto | null>(null);
  const [justMade, setJustMade] = useState<string | null>(null);
  const printList = usePrintList(vendorId);
  const scannerRef = useRef<BarcodeScannerHandle>(null);

  const load = useCallback(() => {
    Promise.all([apiFetch<OfferDto>(`/vendors/${vendorId}/offers/${offerId}`), apiFetch<BarcodeList>(base)])
      .then(([o, l]) => {
        setOffer(o);
        setList(l);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.code === "FEATURE_DISABLED") setDisabled(true);
        else setError(posErrorText(err, lang));
      });
  }, [base, vendorId, offerId, lang]);
  useEffect(() => {
    load();
  }, [load]);

  async function run(action: () => Promise<BarcodeList>, done?: (l: BarcodeList) => string | null) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const l = await action();
      setList(l);
      setNotice(done?.(l) ?? t("bc.saved"));
    } catch (err) {
      setError(posErrorText(err, lang));
    } finally {
      setBusy(false);
    }
  }

  if (disabled) return <p className="muted pos-empty">{t("pos.disabled")}</p>;
  if (!list || !offer) {
    return error ? <p className="pos-inline-error" role="alert">{error}</p> : <div className="skeleton" style={{ height: 180, maxWidth: 760 }} />;
  }
  const archived = offer.status === "ARCHIVED";
  const full = list.items.length >= list.limit;
  const title = lang === "en" ? offer.title_en || offer.title_ar : offer.title_ar;
  const printItem = (b: BarcodeDto) => ({
    code: b.code,
    display_code: b.display_code,
    format: b.format,
    title_ar: offer.title_ar,
    title_en: offer.title_en,
    offer_id: offer.id,
    price: null,
  });
  const made = justMade ? list.items.find((b) => b.code === justMade) ?? null : null;

  return (
    <div className="pos-ui pos-codes" data-testid="barcodes-manager">
      <header className="pos-screen-head">
        <p className="pos-eyebrow">{t("bc.title")}</p>
        <h1 className="pos-screen-title pos-own-title">{t("bc.manage")}</h1>
        <p className="pos-screen-lead">
          <strong>{title}</strong> · {t("bc.lead")}
        </p>
      </header>

      {error && <p className="pos-inline-error" role="alert">{error}</p>}
      {notice && <p className="pos-inline-notice" role="status">{notice}</p>}

      {made && !archived && (
        <section className="pos-panel pos-panel-soft" aria-label={t("bc.generated_title")}>
          <h2 className="pos-subtitle">{t("bc.generated_title")}</h2>
          <GeneratedBarcodeCard vendorId={vendorId} item={printItem(made)} onGoToPrint={onPrint} />
        </section>
      )}

      <section className="pos-panel" aria-labelledby="bc-list-title">
        <div className="pos-panel-head">
          <h2 id="bc-list-title">{t("bc.list")}</h2>
          <span className="pos-count">{fillPos(t("bc.count"), { n: list.items.length, max: list.limit })}</span>
        </div>
        {list.items.length === 0 ? (
          <p className="pos-empty-line" data-testid="barcodes-none">{t("bc.none")}</p>
        ) : (
          <ul className="pos-code-rows">
            {list.items.map((b) => (
              <li key={b.id} className={`pos-code-row${b.is_primary ? " is-primary" : ""}`} data-testid={`barcode-${b.display_code}`}>
                <span className="pos-code-mini" aria-hidden="true">
                  <BarcodeVisual code={b.display_code} format={b.format} height={24} className="pos-barcode-mini" />
                </span>
                <span className="pos-code-number" dir="ltr">{b.display_code}</span>
                <span className="pos-tag">{FORMAT_LABEL[b.format]}</span>
                <span className={`pos-tag ${b.source === "GENERATED" ? "pos-tag-sand" : "pos-tag-quiet"}`}>{t(`bc.source.${b.source}`)}</span>
                {b.is_primary && <span className="pos-tag pos-tag-wine">{t("bc.primary")}</span>}
                <label className="pos-check pos-check-sm">
                  <input
                    type="checkbox"
                    checked={printList.has(b.code)}
                    disabled={!printList.ready}
                    onChange={(e) => (e.target.checked ? printList.add([printItem(b)]) : printList.remove([b.code]))}
                    aria-label={fillPos(t("bc.pick_for_print"), { code: b.display_code })}
                    data-testid={`barcode-to-print-${b.display_code}`}
                  />
                  {t("pl.in_list")}
                </label>
                {!archived && (
                  <span className="pos-code-actions">
                    {!b.is_primary && (
                      <button
                        type="button"
                        className="pos-link-btn"
                        disabled={busy}
                        onClick={() => run(() => apiFetch<BarcodeList>(`${base}/${b.id}/primary`, { method: "PATCH" }))}
                      >
                        {t("bc.make_primary")}
                      </button>
                    )}
                    <button
                      type="button"
                      className="pos-link-btn pos-link-danger"
                      disabled={busy}
                      onClick={() => setConfirmRemove(b)}
                      aria-label={fillPos(t("bc.remove_aria"), { code: b.display_code })}
                    >
                      {t("bc.remove")}
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {archived ? (
        <p className="muted">{t("bc.archived")}</p>
      ) : (
        <div className="pos-actions-bar">
          {!full && (
            <button
              type="button"
              className="pos-btn pos-btn-primary"
              disabled={busy}
              data-testid="barcode-generate"
              onClick={() =>
                run(
                  () =>
                    apiFetch<BarcodeList>(`${base}/generate`, {
                      method: "POST",
                      idempotencyKey: newIdempotencyKey(`barcode-generate-${offerId}`),
                    }),
                  (l) => {
                    const newest = l.items
                      .filter((b) => b.source === "GENERATED" && !list.items.some((old) => old.id === b.id))
                      .slice(-1)[0];
                    if (newest) setJustMade(newest.code);
                    return newest ? fillPos(t("bc.generated"), { code: newest.display_code }) : null;
                  },
                )
              }
            >
              {t("bc.generate")}
            </button>
          )}
          {!full && (
            <button
              type="button"
              className="pos-btn pos-btn-secondary"
              aria-expanded={linking}
              aria-controls="bc-link-area"
              onClick={() => {
                setLinking((v) => !v);
                window.setTimeout(() => scannerRef.current?.focus(), 0);
              }}
              data-testid="barcode-link-open"
            >
              {t("bc.link_existing")}
            </button>
          )}
          <span className="pos-actions-spacer" />
          <button type="button" className="pos-link-btn" onClick={onPrint} data-testid="barcode-print">
            {fillPos(t("pl.go"), { n: printList.items.length })}
          </button>
        </div>
      )}

      {linking && !archived && !full && (
        <section id="bc-link-area" className="pos-panel pos-panel-soft" aria-labelledby="bc-link-title">
          <h2 id="bc-link-title">{t("bc.link_existing")}</h2>
          <p className="pos-panel-lead">{t("bc.link_lead")}</p>
          <BarcodeScanner
            ref={scannerRef}
            id={`bc-add-${offerId}`}
            label={t("bc.add.label")}
            submitLabel={t("bc.add")}
            busy={busy}
            autoFocus
            keepReady
            testId="barcode-add-input"
            onSubmit={(code) =>
              run(
                () => apiFetch<BarcodeList>(base, { method: "POST", body: { code } }),
                () => fillPos(t("bc.linked"), { code }),
              )
            }
          />
        </section>
      )}

      {confirmRemove && (
        <div className="store-quick-edit-overlay" role="presentation" onClick={() => !busy && setConfirmRemove(null)}>
          <section className="store-quick-edit-dialog" role="alertdialog" aria-modal="true" aria-labelledby="bc-remove-title" onClick={(e) => e.stopPropagation()}>
            <h2 id="bc-remove-title">{t("bc.remove")}</h2>
            <p>{fillPos(t("bc.remove.confirm"), { code: confirmRemove.display_code })}</p>
            <div className="store-quick-edit-actions">
              <button type="button" onClick={() => setConfirmRemove(null)} disabled={busy}>{t("pos.confirm.back")}</button>
              <button
                type="button"
                disabled={busy}
                data-testid="barcode-remove-confirm"
                onClick={() =>
                  run(() => apiFetch<BarcodeList>(`${base}/${confirmRemove.id}`, { method: "DELETE" })).then(() => setConfirmRemove(null))
                }
              >
                {t("bc.remove")}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
