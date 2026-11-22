"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { LabelBarcode } from "@/components/pos/BarcodeVisual";
import { FORMAT_LABEL, type BarcodeDto } from "@/components/pos/OfferBarcodesManager";
import { ApiError, apiFetch } from "@/lib/api";
import { usePrintList, type PrintItem } from "@/lib/printList";
import { fillPos, formatIls, posErrorText } from "@/lib/storePosText";
import { useLang, useT } from "@/lib/useLang";

interface LabelItem {
  offer_id: string;
  title_ar: string;
  title_en: string;
  price: number | null;
  barcode: BarcodeDto | null;
  barcodes: BarcodeDto[];
}
interface LabelsDto {
  store_name: string;
  items: LabelItem[];
}
interface OfferRow {
  id: string;
  title_ar: string;
  title_en: string;
  status: string;
}
type Size = "thermal" | "a4";
const MAX_COPIES = 200;
/** An A4 sheet: 4 columns x 9 rows of 50 x 30 mm labels (36 a page). */
const A4_PER_PAGE = 36;
const noSubscribe = () => () => {};

/**
 * «طباعة ملصقات»: this device's label list for the store (kept until printed
 * or removed) - one card per product + its chosen barcode, with its copies;
 * choose all or some. Below it, the real print sheet: an A4 page holds 4 x 9
 * labels of 50 x 30 mm (36), a thermal printer gets one 50 x 30 mm label a
 * page - each label: the product's name, its current price (after a running
 * discount; shown by default, can be hidden), the bars at their real size
 * (EAN-13 at 100%) and the digits. «طباعة المحدد» opens the system's print
 * dialog (no silent print, no QR); «نسخ الأكواد المحددة» copies the numbers.
 */
export function LabelsScreen({ vendorId }: { vendorId: string }) {
  const t = useT();
  const lang = useLang();
  const list = usePrintList(vendorId);
  const [catalog, setCatalog] = useState<OfferRow[] | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [size, setSize] = useState<Size>("a4");
  const [showPrice, setShowPrice] = useState(true);
  // the print sheet lives directly under <body>: only it is printed
  const canPortal = useSyncExternalStore(noSubscribe, () => true, () => false);
  const name = (ar: string, en: string) => (lang === "en" ? en || ar : ar);

  useEffect(() => {
    apiFetch<OfferRow[]>(`/vendors/${vendorId}/offers`)
      .then((rows) => setCatalog(rows.filter((r) => r.status !== "ARCHIVED")))
      .catch((err) => {
        if (err instanceof ApiError && err.code === "FEATURE_DISABLED") setDisabled(true);
        else setError(posErrorText(err, lang));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorId]);

  // each listed code's product as it is now (a renamed product, its price,
  // a code reserved in the wizard whose product has since been published)
  const codesKey = list.items.map((i) => i.code).join(",");
  const { update } = list;
  useEffect(() => {
    if (!list.ready) return;
    apiFetch<LabelsDto>(`/vendors/${vendorId}/barcode-labels?codes=${encodeURIComponent(codesKey)}`)
      .then((d) => {
        for (const item of d.items) {
          for (const b of item.barcodes) {
            if (!codesKey.split(",").includes(b.code)) continue;
            update(b.code, { title_ar: item.title_ar, title_en: item.title_en, price: item.price, offer_id: item.offer_id, format: b.format, display_code: b.display_code });
          }
        }
      })
      .catch((err) => {
        if (err instanceof ApiError && err.code === "FEATURE_DISABLED") setDisabled(true);
      });
  }, [vendorId, codesKey, list.ready, update]);

  async function addProduct(o: OfferRow) {
    setError(null);
    // cleared at once - never after the answer, which would wipe what is being typed next
    setQuery("");
    try {
      const d = await apiFetch<LabelsDto>(`/vendors/${vendorId}/barcode-labels?offer_ids=${o.id}`);
      const item = d.items[0];
      const b = item?.barcode;
      if (!item || !b) {
        setError(fillPos(t("lb.no_barcode"), { title: name(o.title_ar, o.title_en) }));
        return;
      }
      list.add([{ code: b.code, display_code: b.display_code, format: b.format, title_ar: item.title_ar, title_en: item.title_en, offer_id: item.offer_id, price: item.price }]);
    } catch (err) {
      setError(posErrorText(err, lang));
    }
  }

  const selected = list.items.filter((i) => i.selected && i.copies > 0);
  const labels = selected.flatMap((item) => Array.from({ length: item.copies }, (_, n) => ({ item, key: `${item.code}|${n}` })));
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!catalog || !q) return [];
    return catalog.filter((o) => o.title_ar.toLowerCase().includes(q) || o.title_en.toLowerCase().includes(q)).slice(0, 8);
  }, [catalog, query]);
  const allSelected = list.items.length > 0 && list.items.every((i) => i.selected);

  async function copyCodes() {
    const text = selected.map((i) => i.display_code).join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // older browsers: a hidden field and the copy command
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setNotice(fillPos(t("pl.copied"), { n: selected.length }));
  }

  if (disabled) return <p className="muted pos-empty">{t("pos.disabled")}</p>;
  const pageCss = size === "thermal" ? "@page { size: 50mm 30mm; margin: 0; }" : "@page { size: A4; margin: 0; }";
  /** One label: the name, then the price, right above the bars; the digits under them. */
  const labelOf = (item: PrintItem, key: string, testId: string) => (
    <article key={key} className="lb-label" data-testid={testId}>
      <span className="lb-name" dir="auto">{name(item.title_ar, item.title_en)}</span>
      {showPrice && item.price !== null && <span className="lb-price" data-testid="label-price">{formatIls(item.price, lang)}</span>}
      <LabelBarcode code={item.display_code} format={item.format} />
      <span className="lb-digits" dir="ltr">{item.display_code}</span>
    </article>
  );
  // the sheet's pages: 36 labels an A4 page, one label a thermal page
  const perPage = size === "a4" ? A4_PER_PAGE : 1;
  const pages: (typeof labels)[] = [];
  for (let i = 0; i < labels.length; i += perPage) pages.push(labels.slice(i, i + perPage));
  const sheet = (testId: string, labelTestId: string) => (
    <div className={`lb-sheet lb-sheet-${size}`} data-testid={testId}>
      {pages.map((page, n) => (
        <div key={n} className={`lb-page lb-page-${size}`} data-testid={`${testId}-page`} aria-label={fillPos(t("lb.page_n"), { n: n + 1 })}>
          {page.map(({ item, key }) => labelOf(item, key, labelTestId))}
        </div>
      ))}
    </div>
  );

  return (
    <div className={`pos-ui lb-screen lb-${size}`} data-testid="labels-screen">
      <style>{`@media print { ${pageCss} }`}</style>
      <header className="pos-screen-head lb-noprint">
        <h1 className="pos-screen-title pos-own-title">{t("pos.labels.title")}</h1>
        <p className="pos-screen-lead">{t("pl.lead")}</p>
      </header>
      {error && <p className="pos-inline-error lb-noprint" role="alert">{error}</p>}
      {notice && <p className="pos-inline-notice lb-noprint" role="status">{notice}</p>}
      {list.items.some((i) => !i.offer_id) && (
        <p className="pos-note lb-noprint lb-draft-note" data-testid="labels-draft-note">{t("pl.draft_note")}</p>
      )}

      <div className="lb-toolbar lb-noprint">
        <label className="pos-check">
          <input type="checkbox" checked={allSelected} disabled={!list.items.length} onChange={(e) => list.setAll(e.target.checked)} data-testid="labels-select-all" />
          {t("pl.select_all")}
        </label>
        <span className="pos-count">{fillPos(t("pl.count"), { cards: list.items.length, chosen: selected.length, labels: labels.length })}</span>
        <span className="pos-actions-spacer" />
        <button type="button" className="pos-btn pos-btn-quiet" disabled={!selected.length} onClick={() => void copyCodes()} data-testid="labels-copy">
          {t("pl.copy")}
        </button>
        <button type="button" className="pos-btn pos-btn-primary" disabled={!labels.length} onClick={() => window.print()} data-testid="labels-print">
          {fillPos(t("pl.print"), { n: labels.length })}
        </button>
      </div>

      <div className="lb-layout lb-noprint">
        {/* 1. the list: one card per product + barcode */}
        <section className="pos-panel" aria-labelledby="lb-list-title">
          <div className="pos-panel-head">
            <h2 id="lb-list-title">{t("pl.list")}</h2>
          </div>
          <div className="lb-search">
            <label htmlFor="lb-search" className="pos-field-label">{t("lb.search")}</label>
            <input id="lb-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("lb.search_ph")} data-testid="labels-search" />
            {results.length > 0 && (
              <ul className="lb-results" aria-label={t("lb.results")}>
                {results.map((o) => (
                  <li key={o.id}>
                    <span>{name(o.title_ar, o.title_en)}</span>
                    <button type="button" className="pos-link-btn" onClick={() => void addProduct(o)} data-testid="labels-add">{t("lb.add")}</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {list.items.length === 0 ? (
            <p className="pos-empty-line">{t("pl.empty")}</p>
          ) : (
            <ul className="lb-cards">
              {list.items.map((item) => {
                const title = name(item.title_ar, item.title_en);
                return (
                  <li key={item.code} className={`lb-card${item.selected ? " is-on" : ""}`} data-testid="labels-card">
                    <label className="lb-card-pick">
                      <input
                        type="checkbox"
                        checked={item.selected}
                        onChange={(e) => list.update(item.code, { selected: e.target.checked })}
                        aria-label={fillPos(t("pl.pick"), { title, code: item.display_code })}
                        data-testid={`labels-pick-${item.display_code}`}
                      />
                    </label>
                    <div className="lb-card-label">{labelOf(item, item.code, "labels-card-preview")}</div>
                    <div className="lb-card-side">
                      <strong>{title}</strong>
                      <span className="pos-tags">
                        <span className="pos-tag">{FORMAT_LABEL[item.format]}</span>
                        {!item.offer_id && <span className="pos-tag pos-tag-sand">{t("pl.draft")}</span>}
                      </span>
                      <span className="lb-copies" role="group" aria-label={fillPos(t("lb.copies_for"), { code: item.display_code })}>
                        <button type="button" onClick={() => list.update(item.code, { copies: Math.max(1, item.copies - 1) })} disabled={item.copies <= 1} aria-label={t("pos.qty.less")}>−</button>
                        <input
                          type="number"
                          min={1}
                          max={MAX_COPIES}
                          inputMode="numeric"
                          value={item.copies}
                          onChange={(e) => list.update(item.code, { copies: Math.max(1, Math.min(MAX_COPIES, Math.floor(Number(e.target.value)) || 1)) })}
                          aria-label={fillPos(t("lb.copies_for"), { code: item.display_code })}
                          data-testid={`labels-copies-${item.display_code}`}
                        />
                        <button type="button" onClick={() => list.update(item.code, { copies: Math.min(MAX_COPIES, item.copies + 1) })} disabled={item.copies >= MAX_COPIES} aria-label={t("pos.qty.more")}>+</button>
                      </span>
                      <button type="button" className="pos-link-btn pos-link-danger" onClick={() => list.remove([item.code])} data-testid={`labels-remove-${item.display_code}`}>
                        {t("pl.remove")}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* 2. the label and the printer */}
        <section className="pos-panel" aria-labelledby="lb-settings-title">
          <h2 id="lb-settings-title">{t("lb.settings")}</h2>
          <fieldset className="lb-field">
            <legend>{t("lb.size")}</legend>
            {(["a4", "thermal"] as const).map((s) => (
              <label key={s} className={`pos-choice${size === s ? " is-selected" : ""}`}>
                <input type="radio" name="lb-size" value={s} checked={size === s} onChange={() => setSize(s)} data-testid={`labels-size-${s}`} />
                {t(`lb.size.${s}`)}
              </label>
            ))}
          </fieldset>
          <label className="lb-check">
            <input type="checkbox" checked={showPrice} onChange={(e) => setShowPrice(e.target.checked)} data-testid="labels-show-price" />
            {t("lb.price")}
          </label>
          <p className="pos-panel-lead">{t("lb.printer_note")}</p>
        </section>
      </div>

      {/* the real sheet, at its real size (scaled down on screen): what the printer receives */}
      <section className="pos-panel lb-preview lb-noprint" aria-labelledby="lb-preview-title" data-testid="labels-preview">
        <h2 id="lb-preview-title">{t("lb.sheet")}</h2>
        {labels.length ? (
          <>
            <p className="pos-panel-lead">{fillPos(t("lb.sheet_lead"), { labels: labels.length, pages: pages.length })}</p>
            <div className="lb-preview-pages">{sheet("labels-preview-sheet", "preview-label")}</div>
          </>
        ) : (
          <p className="pos-empty-line">{t("lb.sheet_empty")}</p>
        )}
      </section>
      {canPortal && createPortal(<div className="lb-print-root" aria-hidden="true">{sheet("labels-sheet", "label")}</div>, document.body)}
    </div>
  );
}
