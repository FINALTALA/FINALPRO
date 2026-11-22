"use client";

import type { BestsellerMark } from "@/lib/types";
import { useTaxonomy } from "@/lib/taxonomy";
import { useLang } from "@/lib/useLang";
import { registerTranslations, translate } from "@/lib/i18n";
import { audienceName, categoryName } from "@/lib/localized";
import { fmt } from "@/lib/shopText";

registerTranslations({
  ar: {
    "best.label": "الأكثر مبيعاً",
    "best.title_scoped": "من الأكثر مبيعاً في {scope} خلال آخر 30 يوماً",
    "best.title": "من الأكثر مبيعاً خلال آخر 30 يوماً",
    "aud.WOMEN": "نساء",
    "aud.MEN": "رجال",
    "aud.KIDS": "أطفال",
  },
  en: {
    "best.label": "Bestseller",
    "best.title_scoped": "A bestseller in {scope} over the last 30 days",
    "best.title": "A bestseller over the last 30 days",
    "aud.WOMEN": "Women",
    "aud.MEN": "Men",
    "aud.KIDS": "Kids",
  },
});

/**
 * PD-5.3: the small, quiet «الأكثر مبيعاً» mark. It says only that the
 * product qualified in a category/department over the last 30 days - the
 * API never sends a rank, units or customers. `scoped` adds the scope
 * («· فساتين نساء») where there is room (the product page). TB-25: in the
 * interface language.
 */
export default function BestsellerBadge({ mark, scoped = false }: { mark: BestsellerMark; scoped?: boolean }) {
  const lang = useLang();
  const taxonomy = useTaxonomy().data;
  const category = categoryName(taxonomy, mark.category_code, lang);
  const audience = audienceName(taxonomy, mark.audience, lang, translate(lang, `aud.${mark.audience}`));
  const scope = [category, audience].filter(Boolean).join(" ");
  const title = scope ? fmt(translate(lang, "best.title_scoped"), { scope }) : translate(lang, "best.title");
  return (
    <span className={`bestseller-badge${scoped ? " is-scoped" : ""}`} title={title} aria-label={title}>
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M8 1.6l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.4l-3.8 2 .7-4.3-3.1-3 4.3-.6z" />
      </svg>
      {translate(lang, "best.label")}{scoped && scope ? <span className="bestseller-scope"> · {scope}</span> : null}
    </span>
  );
}
