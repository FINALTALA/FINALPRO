"use client";

import { draftSizes, stockFor, type DraftPayload } from "@/lib/offerWizard";
import { swatchBackground } from "@/lib/colorName";
import { fill } from "@/lib/offerWizardText";
import type { TaxonomyDto } from "@/lib/taxonomy";

/**
 * The wizard's side summary (wide panels only): the product as it is taking
 * shape - its main image, name, place in the store, price (with the
 * discount), colours, sizes and how many pieces are entered - so the space
 * beside the form shows the seller what she is building. Display only: it
 * reads the same draft the steps edit and never changes it.
 */
export function WizardAside({
  payload,
  taxonomy,
  title,
  path,
  branchIds,
  colorName,
  t,
}: {
  payload: DraftPayload;
  taxonomy: TaxonomyDto | null;
  title: string;
  path: string;
  branchIds: string[];
  colorName: (code: string) => string;
  t: (k: string) => string;
}) {
  const colors = payload.colors ?? [];
  const image = colors.find((c) => c.images.length > 0)?.images[0] ?? null;
  const order = (code: string) => taxonomy?.sizes.find((s) => s.code === code)?.sort_order ?? 0;
  const sizes = [...draftSizes(payload)].sort((a, b) => order(a) - order(b));
  const sizeLabel = (code: string) => taxonomy?.sizes.find((s) => s.code === code)?.label ?? code;
  const familyHex = (code: string | null) => taxonomy?.colors.find((c) => c.code === code)?.hex ?? null;
  const branches = branchIds.length > 0 ? branchIds : Object.keys(payload.stock ?? {});
  const pieces = colors.reduce(
    (n, c) => n + (payload.sizes?.[c.key] ?? []).reduce((m, s) => m + branches.reduce((k, b) => k + stockFor(payload, c.key, s, b), 0), 0),
    0,
  );
  const price = payload.price ?? null;
  const d = payload.discount ?? null;
  const sale = price && d?.mode === "sale" && d.sale_price ? d.sale_price : null;
  const percent = price && d?.mode === "window" && d.percent ? d.percent : null;

  return (
    <aside className="wz-aside" aria-label={t("wz.aside.title")} data-testid="wz-aside">
      <p className="wz-aside-kicker">{t("wz.aside.title")}</p>
      <div className="wz-aside-media">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt="" />
        ) : (
          <span className="wz-aside-noimage">{t("wz.aside.no_image")}</span>
        )}
      </div>
      <div className="wz-aside-body">
        <p className="wz-aside-name">{title}</p>
        {path && <p className="wz-aside-path">{path}</p>}
        <p className="wz-aside-price" dir="auto">
          {price ? (
            sale ? (
              <>
                <strong>{sale} ₪</strong> <s>{price} ₪</s>
              </>
            ) : (
              <>
                <strong>{price} ₪</strong>
                {percent && <span className="wz-aside-off">{fill(t("wz.aside.window"), { p: percent })}</span>}
              </>
            )
          ) : (
            <span className="wz-aside-missing">{t("wz.aside.no_price")}</span>
          )}
        </p>
        {colors.length > 0 && (
          <div className="wz-aside-row">
            <span className="wz-aside-label">{t("wz.aside.colors")}</span>
            <span className="wz-aside-swatches">
              {colors.map((c) => (
                <span key={c.key} className="wz-aside-swatch" title={colorName(c.key)}>
                  <span style={{ background: swatchBackground({ swatch_url: c.swatch, hex: c.hex, family_hex: familyHex(c.family) }) }} aria-hidden="true" />
                  {colorName(c.key)}
                </span>
              ))}
            </span>
          </div>
        )}
        {sizes.length > 0 && (
          <div className="wz-aside-row">
            <span className="wz-aside-label">{t("wz.aside.sizes")}</span>
            <span className="wz-aside-sizes" dir="ltr">
              {sizes.map((s) => (
                <span key={s}>{sizeLabel(s)}</span>
              ))}
            </span>
          </div>
        )}
        <div className="wz-aside-row">
          <span className="wz-aside-label">{t("wz.aside.pieces")}</span>
          <span className="wz-aside-count">{pieces}</span>
        </div>
      </div>
    </aside>
  );
}
