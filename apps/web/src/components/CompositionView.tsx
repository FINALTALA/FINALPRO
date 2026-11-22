"use client";

import { countryName, fiberName, type Composition } from "@/lib/composition";
import type { Lang } from "@/lib/i18n";
import { translate } from "@/lib/i18n";

/**
 * Fabric composition and country of origin, read-only (2026-11-19) - the
 * one view of the shopper's product page, the draft preview (same data,
 * same component), and the owner's details pages:
 *   الخامة الخارجية   95% قطن، 5% إيلاستين
 *   البطانة           100% بوليستر
 *   بلد المنشأ        تركيا
 * Each «percent fibre» is isolated (<bdi>) so «95%» never flips in either
 * direction. Nothing at all when neither is given.
 */
export function CompositionView({ composition, country, lang, heading = true }: { composition: Composition | null; country: string | null; lang: Lang; heading?: boolean }) {
  const parts = composition?.parts ?? [];
  if (parts.length === 0 && !country) return null;
  const sep = lang === "en" ? ", " : "، ";
  return (
    <div className="pdp-composition" data-testid="composition-view">
      {heading && <h3 className="pdp-composition-title">{translate(lang, "comp.view_title")}</h3>}
      <dl className="pdp-specs">
        {parts.map((p) => (
          <div key={p.part} className="pdp-composition-row" data-testid={`composition-${p.part}`}>
            <dt>{translate(lang, `wz.part.${p.part}`)}</dt>
            <dd>
              {p.fibers.map((f, i) => (
                <span key={i}>
                  {i > 0 && sep}
                  <bdi>{`${f.percent}%`}</bdi> {fiberName(f, lang)}
                </span>
              ))}
            </dd>
          </div>
        ))}
        {country && (
          <div className="pdp-composition-row" data-testid="composition-origin">
            <dt>{translate(lang, "comp.origin_line")}</dt>
            <dd>{countryName(country, lang)}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
