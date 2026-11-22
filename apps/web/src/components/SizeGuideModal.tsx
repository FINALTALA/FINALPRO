"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, apiFetch } from "@/lib/api";
import {
  formatMeasure,
  readSizeUnit,
  SIZE_GUIDE_TEXT,
  SizeGuideDto,
  SizeGuidePublicDto,
  sizeLabelFor,
  SizeUnit,
  writeSizeUnit,
} from "@/lib/sizeGuides";
import { useLang } from "@/lib/useLang";

/**
 * PD-4: the product page's size guide - only ever opened when the API
 * says a published guide applies (no empty guide, no invented values).
 * Light glass panel on the page's beige/wine palette over a dimmed page;
 * focus stays inside, Esc closes, focus returns to the opener. The
 * table scrolls inside its own frame (sticky header and size column), so
 * the page itself never scrolls sideways. "ليس مقاسك؟" opens the same
 * guide with the measuring note first - there is no size recommendation.
 * Arabic or English follows the app language; the values stay the same
 * (cm, converted to inches only for display).
 */
export default function SizeGuideModal({
  slug,
  offerId,
  selectedSize,
  focusNotes = false,
  preloaded,
  onClose,
}: {
  slug: string;
  offerId: string;
  /** The size chosen on the page (highlighted in the table). */
  selectedSize: string | null;
  /** Opened from "ليس مقاسك؟": show how to measure first. */
  focusNotes?: boolean;
  /** Phase A++ (item 3): the draft preview's table (the same shape) - nothing is fetched. */
  preloaded?: SizeGuidePublicDto;
  onClose: () => void;
}) {
  const lang = useLang();
  const t = SIZE_GUIDE_TEXT[lang];
  const [data, setData] = useState<SizeGuidePublicDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState(0);
  const [unit, setUnit] = useState<SizeUnit>(() => readSizeUnit());
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let cancelled = false;
    (preloaded ? Promise.resolve(preloaded) : apiFetch<SizeGuidePublicDto>(`/storefronts/${slug}/offers/${offerId}/size-guide`, { auth: false }))
      .then((res) => {
        if (cancelled) return;
        setData(res);
        // Open on the tab that describes the selected size, if any.
        const i = selectedSize ? res.guides.findIndex((g) => g.rows.some((r) => r.size_code === selectedSize)) : -1;
        if (i > 0) setTab(i);
      })
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : ""));
    return () => {
      cancelled = true;
    };
  }, [slug, offerId, selectedSize, preloaded]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>("button")?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
      if (e.key === "Tab" && panel) {
        const focusable = [...panel.querySelectorAll<HTMLElement>("button:not(:disabled), [tabindex='0']")];
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
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      opener?.focus?.();
    };
  }, [onClose]);

  function chooseUnit(next: SizeUnit) {
    setUnit(next);
    writeSizeUnit(next);
  }

  const guide: SizeGuideDto | null = data?.guides[tab] ?? data?.guides[0] ?? null;
  const offerSizes = new Set(data?.offer_sizes ?? []);
  const selectedRow = guide?.rows.find((r) => r.size_code === selectedSize) ?? null;
  const name = guide ? (lang === "en" ? guide.name_en || guide.name_ar : guide.name_ar) : "";
  // English shows notes_en; a guide the administrator wrote only in Arabic keeps its Arabic note.
  const notes = guide ? (lang === "en" ? guide.notes_en || guide.notes_ar : guide.notes_ar) : null;
  const basis = guide?.basis === "BODY" ? t.bodyBasis : t.garmentBasis;
  const unitLong = unit === "cm" ? t.inCm : t.inInch;

  return (
    <div className="sg-overlay" role="presentation" onMouseDown={onClose}>
      <section
        ref={panelRef}
        className="sg-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sg-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="sg-head">
          <div>
            {/* Phase A+: the product's own table is «جدول المقاسات (سم)» (its internal name is not shown). */}
            <h2 id="sg-title">{guide?.kind === "OFFER" ? (unit === "cm" ? t.ownTitle : t.ownTitleInch) : t.title}</h2>
            {guide && guide.kind !== "OFFER" && <p className="sg-subtitle">{name}</p>}
          </div>
          <button type="button" className="sg-close" onClick={onClose} aria-label={t.close}>×</button>
        </header>

        {error !== null ? (
          <p className="sg-error" role="alert">{error || t.loadError}</p>
        ) : !data ? (
          <div className="sg-loading" aria-busy="true">{t.loading}</div>
        ) : !guide ? (
          <p className="sg-empty" role="status">{t.empty}</p>
        ) : (
          <>
            <div className="sg-toolbar">
              {data.guides.length > 1 && (
                <div className="sg-tabs" role="tablist" aria-label={t.audienceTabs}>
                  {data.guides.map((g, i) => (
                    <button
                      key={g.id}
                      type="button"
                      role="tab"
                      aria-selected={i === tab}
                      className={i === tab ? "is-on" : ""}
                      onClick={() => setTab(i)}
                    >
                      {g.audiences.map((a) => t.audience[a] ?? a).join(" / ")}
                    </button>
                  ))}
                </div>
              )}
              <div className="sg-units" role="radiogroup" aria-label={t.unitGroup}>
                {(["cm", "in"] as SizeUnit[]).map((u) => (
                  <button key={u} type="button" role="radio" aria-checked={unit === u} className={unit === u ? "is-on" : ""} onClick={() => chooseUnit(u)}>
                    {u === "cm" ? t.cm : t.inch}
                  </button>
                ))}
              </div>
            </div>

            {focusNotes && <p className="sg-fit-note">{t.fitNote}</p>}

            <p className="sg-basis">
              {basis} · {unitLong}
              {selectedRow && <> · {t.selected}: <b>{sizeLabelFor(selectedRow.size_code, selectedRow.size_label, lang)}</b></>}
            </p>

            <div className="sg-scroll" tabIndex={0} role="region" aria-label={t.table}>
              <table className="sg-table">
                <caption className="sr-only">
                  {name} - {basis} ({unit === "cm" ? t.cm : t.inch})
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{t.size}</th>
                    {guide.measurements.map((m) => (
                      <th key={m.key} scope="col">{lang === "en" ? m.label_en : m.label_ar}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {guide.rows.map((r) => {
                    const selected = r.size_code === selectedSize;
                    return (
                      <tr key={r.size_code} className={selected ? "is-selected" : ""} aria-current={selected ? "true" : undefined}>
                        <th scope="row">
                          {sizeLabelFor(r.size_code, r.size_label, lang)}
                          {offerSizes.has(r.size_code) && <span className="sg-in-offer" title={t.inOffer} aria-label={t.inOffer} />}
                        </th>
                        {guide.measurements.map((m) => (
                          <td key={m.key} dir="ltr">{formatMeasure(r.values[m.key], unit)}</td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="sg-legend"><span className="sg-in-offer" aria-hidden="true" /> {t.legend}</p>

            {data.sizes_not_in_guide.length > 0 && (
              <p className="sg-warning" role="note">
                {t.notInGuide}: {data.sizes_not_in_guide.join(lang === "en" ? ", " : "، ")}.
              </p>
            )}

            {notes && (
              <div className="sg-notes">
                <strong>{t.howToMeasure}</strong>
                <p dir="auto">{notes}</p>
              </div>
            )}
            <p className="sg-meta">
              {t.updated}:{" "}
              {guide.published_at
                ? new Date(guide.published_at).toLocaleDateString(lang === "en" ? "en-GB" : "ar-EG", { day: "numeric", month: "long", year: "numeric" })
                : "-"}
            </p>
          </>
        )}
      </section>
    </div>
  );
}
