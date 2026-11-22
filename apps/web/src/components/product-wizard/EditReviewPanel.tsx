"use client";

import { fill } from "@/lib/offerWizardText";
import type { DraftProblem, EditConflict, EditReview } from "@/lib/offerWizard";

type ColorRow = [string, string | null, string, string | null, string | null, string | null];

/**
 * Edit drafts: «مراجعة التعديلات» - what applying will change, group by
 * group («الاسم: تغيّر», «لون جديد: موكا», «السعر: 180 ← 150»), a conflict
 * with the product's current state (never merged silently: each group
 * changed in both places needs an explicit choice), and what a paused
 * product still needs before publishing (notes, not blockers).
 */
export function EditReviewPanel({
  review,
  loading,
  problems,
  problemText,
  goToProblem,
  choices,
  setChoice,
  onRebase,
  rebasing,
  colorName,
  sizeLabel,
  t,
  lang,
}: {
  review: EditReview | null;
  loading: boolean;
  problems: DraftProblem[];
  problemText: (code: string) => string;
  goToProblem: (p: DraftProblem) => void;
  choices: Record<string, "mine" | "current">;
  setChoice: (group: string, v: "mine" | "current") => void;
  onRebase: () => void;
  rebasing: boolean;
  colorName: (key: string) => string;
  sizeLabel: (code: string) => string;
  t: (k: string) => string;
  lang: string;
}) {
  if (!review) {
    return <p className="muted" data-testid="wz-edit-review-loading">{t("wz.edit.review.loading")}</p>;
  }
  const lines = reviewLines(review, colorName, sizeLabel, t);
  const paused = review.offer_status !== "ACTIVE";
  const undecided = review.conflict.some((c) => c.kind === "both" && !choices[c.group]);

  return (
    <div className="wz-edit-review" data-testid="wz-edit-review" aria-busy={loading || undefined}>
      {review.conflict.length > 0 && (
        <section className="wz-edit-conflict" role="alert" aria-labelledby="wz-edit-conflict-title" data-testid="wz-edit-conflict">
          <h3 id="wz-edit-conflict-title">{t("wz.edit.conflict.title")}</h3>
          <p>{t("wz.edit.conflict.lead")}</p>
          <ul>
            {review.conflict.map((c: EditConflict) => (
              <li key={c.group} data-testid={`wz-edit-conflict-${c.group}`} data-kind={c.kind}>
                <strong>{t(`wz.edit.group.${c.group}`)}</strong>
                {c.kind === "elsewhere" ? (
                  <span className="muted"> - {t("wz.edit.conflict.elsewhere")}</span>
                ) : (
                  <fieldset className="wz-edit-choice">
                    <legend className="muted">{t("wz.edit.conflict.both")}</legend>
                    {(["mine", "current"] as const).map((v) => (
                      <label key={v} className={`wz-choice${choices[c.group] === v ? " wz-choice-on" : ""}`}>
                        <input
                          type="radio"
                          name={`wz-edit-choice-${c.group}`}
                          checked={choices[c.group] === v}
                          onChange={() => setChoice(c.group, v)}
                          data-testid={`wz-edit-choice-${c.group}-${v}`}
                        />
                        {t(`wz.edit.conflict.${v}`)}
                        <span className="wz-edit-choice-value" dir="auto">{valueText(c.group, v === "mine" ? c.mine : c.current, lang)}</span>
                      </label>
                    ))}
                  </fieldset>
                )}
              </li>
            ))}
          </ul>
          <button type="button" className="button" disabled={undecided || rebasing} onClick={onRebase} data-testid="wz-edit-rebase">
            {rebasing ? t("wz.edit.conflict.rebasing") : t("wz.edit.conflict.rebase")}
          </button>
        </section>
      )}

      <section aria-labelledby="wz-edit-review-title">
        <h3 id="wz-edit-review-title" className="wz-edit-review-title">{t("wz.edit.review.title")}</h3>
        {lines.length === 0 ? (
          <p className="muted" data-testid="wz-edit-review-none">{t("wz.edit.review.none")}</p>
        ) : (
          <ul className="wz-edit-lines" data-testid="wz-edit-lines">
            {lines.map((l) => (
              <li key={l.key} data-testid={`wz-edit-line-${l.key}`}>{l.text}</li>
            ))}
          </ul>
        )}
        {review.mixed_images.map((k) => (
          <p key={k} className="wz-hint" data-testid={`wz-edit-mixed-${k}`}>{fill(t("wz.edit.mixed"), { color: colorName(k) })}</p>
        ))}
      </section>

      {paused && <p className="wz-hint wz-edit-paused" data-testid="wz-edit-paused">{t("wz.edit.paused")}</p>}
      {problems.length > 0 && (
        <section className={paused ? "wz-edit-notes" : "wz-missing"} id="wz-missing-note" data-testid={paused ? "wz-edit-notes" : "wz-missing"}>
          <h3>{paused ? t("wz.edit.notes") : t("wz.missing.title")}</h3>
          <ul>
            {problems.map((p) => (
              <li key={p.code}>
                <button type="button" className="button-link" onClick={() => goToProblem(p)} data-testid={`wz-missing-${p.code}`}>
                  {problemText(p.code)}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

const price = (v: unknown) => (typeof v === "number" ? String(v) : "-");

/** A conflict's value in a few words (price: the number; anything else: short text). */
function valueText(group: string, v: unknown, lang: string): string {
  if (group === "price" && Array.isArray(v)) return ` (${price(v[0])})`;
  if (group === "title" && Array.isArray(v)) return ` (${String((lang === "en" ? v[1] || v[0] : v[0]) ?? "")})`;
  return "";
}

/** The group-level lines of «مراجعة التعديلات». */
export function reviewLines(
  review: EditReview,
  colorName: (key: string) => string,
  sizeLabel: (code: string) => string,
  t: (k: string) => string,
): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = [];
  for (const g of review.groups) {
    if (g.group === "price") {
      const [b, a] = [g.before as unknown[], g.after as unknown[]];
      if (b?.[0] !== a?.[0]) out.push({ key: "price", text: fill(t("wz.edit.price"), { from: price(b?.[0]), to: price(a?.[0]) }) });
      if (JSON.stringify(b?.[1] ?? null) !== JSON.stringify(a?.[1] ?? null)) out.push({ key: "discount", text: t("wz.edit.discount") });
      continue;
    }
    if (g.group === "colors") {
      const before = new Map(((g.before as ColorRow[]) ?? []).map((c) => [c[0], c]));
      let listed = false;
      for (const c of (g.after as ColorRow[]) ?? []) {
        const was = before.get(c[0]);
        if (!was) {
          out.push({ key: `color-new-${c[0]}`, text: fill(t("wz.edit.new_color"), { name: c[2] || colorName(c[0]) }) });
          listed = true;
        } else if (was[2] !== c[2]) {
          out.push({ key: `color-name-${c[0]}`, text: fill(t("wz.edit.renamed_color"), { from: was[2], to: c[2] }) });
          listed = true;
        }
      }
      if (!listed) out.push({ key: "colors", text: fill(t("wz.edit.changed"), { group: t("wz.edit.group.colors") }) });
      continue;
    }
    if (g.group === "sizes") {
      const before = (g.before as Record<string, string[]>) ?? {};
      for (const [k, list] of Object.entries((g.after as Record<string, string[]>) ?? {})) {
        if (!before[k]) continue; // a new colour's sizes: part of «لون جديد»
        for (const s of list.filter((x) => !before[k].includes(x))) {
          out.push({ key: `size-${k}-${s}`, text: fill(t("wz.edit.new_size"), { color: colorName(k), size: sizeLabel(s) }) });
        }
      }
      continue;
    }
    if (g.group === "images") {
      const before = (g.before as Record<string, string[]>) ?? {};
      for (const [k, list] of Object.entries((g.after as Record<string, string[]>) ?? {})) {
        if (before[k] && JSON.stringify(before[k]) !== JSON.stringify(list)) {
          out.push({ key: `images-${k}`, text: fill(t("wz.edit.images_of"), { color: colorName(k) }) });
        }
      }
      continue;
    }
    out.push({ key: g.group, text: fill(t("wz.edit.changed"), { group: t(`wz.edit.group.${g.group}`) }) });
  }
  if (review.new_versions > 0) out.push({ key: "new-versions", text: fill(t("wz.edit.new_versions"), { n: review.new_versions }) });
  return out;
}
