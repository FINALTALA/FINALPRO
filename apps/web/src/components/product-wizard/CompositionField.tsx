"use client";

import { useId, useMemo } from "react";
import {
  allCountries,
  COMMON_COUNTRIES,
  COMPOSITION_FIBERS,
  COMPOSITION_PARTS,
  MAX_FIBERS_PER_PART,
  partTotal,
  type Composition,
  type CompositionFiber,
  type CompositionFiberRow,
  type CompositionPart,
  type CompositionPartRow,
} from "@/lib/composition";
import type { Lang } from "@/lib/i18n";
import { fill } from "@/lib/offerWizardText";

/**
 * «مكوّنات القماش وبلد المنشأ (اختياري)» (2026-11-19): under the
 * specifications in the details step. Add a part (shell, lining, filling,
 * trim), then its fibres and percents; a live total says what is missing
 * («المجموع 95% — ينقص 5%»), «100% من ليف واحد» fills a one-fibre part.
 * An unfinished part is kept while typing (the publish check names it).
 * The country of origin from a list (the common ones first). Nothing here
 * is required to publish.
 */
export function CompositionField({
  composition,
  country,
  onChange,
  lang,
  t,
  showProblems,
}: {
  composition: Composition | null | undefined;
  country: string | null | undefined;
  onChange: (next: { composition: Composition | null; country_of_origin: string | null }) => void;
  lang: Lang;
  t: (k: string) => string;
  showProblems: boolean;
}) {
  const countryId = useId();
  const parts = composition?.parts ?? [];
  const countries = useMemo(() => allCountries(lang), [lang]);
  const common = COMMON_COUNTRIES.map((code) => countries.find((c) => c.code === code)).filter((c): c is { code: string; name: string } => !!c);
  const partName = (p: CompositionPart) => t(`wz.part.${p}`);

  const save = (nextParts: CompositionPartRow[], nextCountry = country ?? null) =>
    onChange({
      composition: nextParts.length ? { parts: [...nextParts].sort((a, b) => COMPOSITION_PARTS.indexOf(a.part) - COMPOSITION_PARTS.indexOf(b.part)) } : null,
      country_of_origin: nextCountry,
    });
  const setPart = (part: CompositionPart, fibers: CompositionFiberRow[]) =>
    save(fibers.length ? parts.map((p) => (p.part === part ? { part, fibers } : p)) : parts.filter((p) => p.part !== part));
  const nextFiber = (fibers: CompositionFiberRow[]): CompositionFiber =>
    COMPOSITION_FIBERS.find((f) => f !== "OTHER" && !fibers.some((x) => x.fiber === f)) ?? "OTHER";

  return (
    <fieldset className="wz-field wz-comp" data-testid="wz-composition">
      <legend>
        {t("comp.title")} <span className="wz-opt">({t("wz.optional")})</span>
      </legend>
      <p className="wz-hint">{t("comp.lead")}</p>

      {parts.map((p) => {
        const total = partTotal(p);
        const complete = total === 100 && p.fibers.every((f) => f.percent !== null && (f.fiber !== "OTHER" || !!f.other_ar?.trim()));
        const status = total === 100 ? t("comp.total_ok") : total < 100 ? fill(t("comp.total_missing"), { n: total, left: 100 - total }) : fill(t("comp.total_over"), { n: total, over: total - 100 });
        const problem =
          showProblems && !complete
            ? p.fibers.some((f) => f.percent === null)
              ? fill(t("wz.p.COMPOSITION_PERCENT"), { part: partName(p.part) })
              : p.fibers.some((f) => f.fiber === "OTHER" && !f.other_ar?.trim())
                ? fill(t("wz.p.COMPOSITION_OTHER"), { part: partName(p.part) })
                : fill(t("wz.p.COMPOSITION_SUM"), { part: partName(p.part) })
            : null;
        return (
          <div key={p.part} className={`wz-comp-part${complete ? " is-complete" : ""}`} role="group" aria-label={partName(p.part)} data-testid={`wz-comp-part-${p.part}`}>
            <div className="wz-comp-head">
              <strong>{partName(p.part)}</strong>
              <span className={`wz-comp-total${total === 100 ? " is-ok" : ""}`} aria-live="polite" data-testid={`wz-comp-total-${p.part}`}>{status}</span>
              <button type="button" className="wz-close wz-comp-remove" onClick={() => setPart(p.part, [])} aria-label={fill(t("comp.remove_part"), { part: partName(p.part) })} title={fill(t("comp.remove_part"), { part: partName(p.part) })}>
                ×
              </button>
            </div>
            {p.fibers.map((f, i) => {
              const fiberLabel = `${t("comp.fiber")} ${i + 1} — ${partName(p.part)}`;
              const setFiber = (row: CompositionFiberRow) => setPart(p.part, p.fibers.map((x, j) => (j === i ? row : x)));
              return (
                <div key={i} className="wz-comp-row">
                  <select
                    value={f.fiber}
                    aria-label={fiberLabel}
                    onChange={(e) => {
                      const fiber = e.target.value as CompositionFiber;
                      setFiber(fiber === "OTHER" ? { fiber, percent: f.percent, other_ar: f.other_ar, other_en: f.other_en } : { fiber, percent: f.percent });
                    }}
                    data-testid={`wz-comp-${p.part}-fiber-${i}`}
                  >
                    {COMPOSITION_FIBERS.filter((x) => x === f.fiber || x === "OTHER" || !p.fibers.some((y) => y.fiber === x)).map((x) => (
                      <option key={x} value={x}>{t(`wz.fiber.${x}`)}</option>
                    ))}
                  </select>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={100}
                    step={1}
                    value={f.percent ?? ""}
                    aria-label={`${t("comp.percent")} — ${f.fiber === "OTHER" ? f.other_ar || t("wz.fiber.OTHER") : t(`wz.fiber.${f.fiber}`)} — ${partName(p.part)}`}
                    onChange={(e) => {
                      const n = e.target.value === "" ? null : Math.round(Number(e.target.value));
                      setFiber({ ...f, percent: n === null || !Number.isFinite(n) ? null : Math.min(100, Math.max(1, n)) });
                    }}
                    className="wz-comp-percent"
                    data-testid={`wz-comp-${p.part}-percent-${i}`}
                  />
                  <span className="wz-comp-pct" aria-hidden="true">%</span>
                  {f.fiber === "OTHER" && (
                    <>
                      <input type="text" maxLength={40} value={f.other_ar ?? ""} placeholder={t("comp.other_ar")} aria-label={`${t("comp.other_ar")} — ${partName(p.part)}`} onChange={(e) => setFiber({ ...f, other_ar: e.target.value })} dir="rtl" lang="ar" data-testid={`wz-comp-${p.part}-other-ar-${i}`} />
                      <input type="text" maxLength={40} value={f.other_en ?? ""} placeholder={t("comp.other_en")} aria-label={`${t("comp.other_en")} — ${partName(p.part)}`} onChange={(e) => setFiber({ ...f, other_en: e.target.value })} dir="ltr" lang="en" />
                    </>
                  )}
                  {p.fibers.length > 1 && (
                    <button type="button" className="wz-close wz-comp-remove" onClick={() => setPart(p.part, p.fibers.filter((_, j) => j !== i))} aria-label={fill(t("comp.remove_fiber"), { fiber: f.fiber === "OTHER" ? f.other_ar || t("wz.fiber.OTHER") : t(`wz.fiber.${f.fiber}`), part: partName(p.part) })}>
                      ×
                    </button>
                  )}
                </div>
              );
            })}
            <div className="wz-comp-actions">
              {p.fibers.length < MAX_FIBERS_PER_PART ? (
                <button type="button" className="button-link wz-ghost" onClick={() => setPart(p.part, [...p.fibers, { fiber: nextFiber(p.fibers), percent: null }])} data-testid={`wz-comp-${p.part}-add`}>
                  {t("comp.add_fiber")}
                </button>
              ) : (
                <span className="wz-hint">{fill(t("comp.max_fibers"), { n: MAX_FIBERS_PER_PART })}</span>
              )}
              <button type="button" className="button-link wz-ghost" onClick={() => setPart(p.part, [{ ...p.fibers[0], percent: 100 }])} data-testid={`wz-comp-${p.part}-single`}>
                {t("comp.single")}
              </button>
            </div>
            {problem && <p className="wz-error" role="alert">{problem}</p>}
          </div>
        );
      })}

      {parts.length < COMPOSITION_PARTS.length && (
        <div className="wz-comp-add" role="group" aria-label={t("comp.add_part")}>
          <span className="wz-hint">{t("comp.add_part")}:</span>
          {COMPOSITION_PARTS.filter((x) => !parts.some((p) => p.part === x)).map((x) => (
            <button key={x} type="button" className="button-link owner-secondary" onClick={() => save([...parts, { part: x, fibers: [{ fiber: "COTTON", percent: null }] }])} data-testid={`wz-comp-add-${x}`}>
              + {partName(x)}
            </button>
          ))}
        </div>
      )}

      <div className="wz-field wz-comp-country">
        <label htmlFor={countryId}>{t("comp.country")}</label>
        <select id={countryId} value={country ?? ""} onChange={(e) => save(parts, e.target.value || null)} data-testid="wz-comp-country">
          <option value="">{t("comp.country_none")}</option>
          <optgroup label={t("comp.country_common")}>
            {common.map((c) => (
              <option key={`c-${c.code}`} value={c.code}>{c.name}</option>
            ))}
          </optgroup>
          <optgroup label={t("comp.country_all")}>
            {countries.filter((c) => !COMMON_COUNTRIES.includes(c.code)).map((c) => (
              <option key={c.code} value={c.code}>{c.name}</option>
            ))}
          </optgroup>
        </select>
      </div>
    </fieldset>
  );
}
