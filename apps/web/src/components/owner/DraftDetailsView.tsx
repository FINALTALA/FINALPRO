"use client";

import { useEffect, useState } from "react";
import { IconEdit } from "@/components/product-wizard/wizardIcons";
import { CompositionView } from "@/components/CompositionView";
import type { Composition } from "@/lib/composition";
import { ErrorBanner } from "@/components/States";
import { ApiError, apiFetch } from "@/lib/api";
import "@/lib/batchText";
import { templateFieldLabel } from "@/lib/clothingTemplates";
import { gateReason } from "@/lib/importProblems";
import { fill } from "@/lib/offerWizardText";
import "@/lib/offerWizardText";
import { specValueText } from "@/lib/specCodes";
import { useTaxonomy } from "@/lib/taxonomy";
import { useLang, useT } from "@/lib/useLang";

interface DraftColor {
  key: string;
  family: string | null;
  name_ar: string;
  name_en?: string;
  hex?: string | null;
  images: string[];
}
interface DraftPayload {
  audience?: string | null;
  category?: string | null;
  title_ar?: string;
  title_en?: string;
  brand?: { mode: "existing"; brand_id: string } | { mode: "none" } | { mode: "request"; name: string } | null;
  specs?: Record<string, string>;
  colors?: DraftColor[];
  sizes?: Record<string, string[]>;
  price?: number | null;
  stock?: Record<string, Record<string, number>>;
  description_ar?: string;
  description_en?: string;
  measurements?: { keys: string[]; values: Record<string, Record<string, number>> } | null;
  discount?: { mode: "sale"; sale_price: number } | { mode: "window"; percent: number; start_at: string; end_at: string } | null;
  model?: { height_cm: number | null; size: string | null } | null;
  shared_images?: string[];
  sections?: string[];
  composition?: Composition | null;
  country_of_origin?: string | null;
}
interface DraftDto {
  id: string;
  status: "OPEN" | "SUBMITTED" | "DISCARDED" | "ABANDONED";
  revision: number;
  title: string;
  payload: DraftPayload;
  offer_id: string | null;
}
interface Branch {
  id: string;
  name: string;
  archived_at: string | null;
}

/**
 * «تفاصيل المسودة» (2026-11-18): a draft read as the owner's product
 * details page reads a product - the same cards, lines and tables (summary;
 * colours, images and sizes; stock by branch; description, specifications,
 * size table and model; publishing) - with no field and no save. The one
 * action is «مراجعة وتعديل» (the wizard). In the management window it is a
 * screen of its own; its «رجوع» returns to the batch.
 */
export function DraftDetailsView({
  vendorId,
  draftId,
  embedded = false,
  onReview,
}: {
  vendorId: string;
  draftId: string;
  embedded?: boolean;
  onReview?: (draftId: string) => void;
}) {
  const t = useT();
  const lang = useLang();
  const taxonomy = useTaxonomy();
  const [draft, setDraft] = useState<DraftDto | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [brandName, setBrandName] = useState<string | null>(null);
  const [problems, setProblems] = useState<{ code: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const base = `/vendors/${vendorId}/offer-drafts/${draftId}`;
    void apiFetch<DraftDto>(base)
      .then(async (d) => {
        setDraft(d);
        const optional = <T,>(p: Promise<T>) => p.catch(() => null);
        const brand = d.payload.brand;
        const [bs, pc, brands] = await Promise.all([
          optional(apiFetch<Branch[]>(`/vendors/${vendorId}/branches`)),
          d.status === "OPEN" ? optional(apiFetch<{ problems: { code: string }[] }>(`${base}/publish-check`)) : Promise.resolve(null),
          brand?.mode === "existing" ? optional(apiFetch<{ id: string; name: string }[]>("/brands", { auth: false })) : Promise.resolve(null),
        ]);
        setBranches(bs ?? []);
        setProblems(pc?.problems ?? null);
        setBrandName(
          brand?.mode === "none" ? t("details.no_brand") : brand?.mode === "existing" ? (brands?.find((b) => b.id === brand.brand_id)?.name ?? null) : brand?.mode === "request" ? brand.name : null,
        );
      })
      .catch((err: unknown) => setError(err instanceof ApiError && err.status === 404 ? t("details.not_found") : t("details.load_failed")));
  }, [vendorId, draftId, t]);

  const shellClass = embedded ? "owner-catalog owner-details owner-embedded" : "page-shell wz-start owner-catalog owner-details";
  if (error) return <div className={shellClass}><ErrorBanner message={error} /></div>;
  if (!draft) {
    return (
      <div className={shellClass} aria-busy="true">
        <div className="skeleton" style={{ height: 220, maxWidth: 1100 }} />
      </div>
    );
  }

  const p = draft.payload;
  const colors = p.colors ?? [];
  const title = (lang === "en" ? p.title_en || p.title_ar : p.title_ar) || draft.title;
  const sizeLabel = (code: string) => taxonomy.data?.sizes.find((s) => s.code === code)?.label ?? code;
  const familyHex = (c: DraftColor) => c.hex ?? taxonomy.data?.colors.find((x) => x.code === c.family)?.hex ?? "#d9cfc4";
  const category = taxonomy.data?.categories.find((c) => c.code === p.category);
  const path = [p.audience ? t(`wz.audience.${p.audience}`) : null, category ? (lang === "en" ? category.name_en || category.name_ar : category.name_ar) : p.category].filter(Boolean).join(" › ");
  const money = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${Number(v).toFixed(2)} ₪`);
  const discount = !p.discount ? null : p.discount.mode === "sale" ? fill(t("details.discount.sale"), { price: money(p.discount.sale_price) }) : fill(t("details.discount.percent"), { p: p.discount.percent });
  const mainImage = colors[0]?.images[0] ?? null;
  const stock = p.stock ?? {};
  const stockBranches = branches.filter((b) => Object.values(stock[b.id] ?? {}).some((q) => q > 0) || !b.archived_at);
  const qty = (branchId: string, colorKey: string, size: string) => stock[branchId]?.[`${colorKey}|${size}`] ?? 0;
  const total = Object.values(stock).reduce((n, per) => n + Object.values(per).reduce((a, q) => a + q, 0), 0);
  const specs = Object.entries(p.specs ?? {}).filter(([, v]) => typeof v === "string" && v.trim());
  const specName = (key: string) => (t(`wz.spec.${key}`) !== `wz.spec.${key}` ? t(`wz.spec.${key}`) : templateFieldLabel(key));
  const description = lang === "en" ? p.description_en || p.description_ar : p.description_ar;
  const open = draft.status === "OPEN";

  return (
    <div className={shellClass} data-testid="draft-details">
      <div className="owner-details-sections">
        <section className="owner-card owner-summary" aria-label={t("details.summary")} data-testid="draft-details-summary">
          <div className="owner-summary-media">
            {mainImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={mainImage} alt={fill(t("details.main_image_alt"), { title })} className="owner-summary-image" />
            ) : (
              <span className="owner-summary-image owner-summary-image-empty" role="img" aria-label={t("details.no_image")} />
            )}
          </div>
          <div className="owner-summary-body">
            <div className="owner-summary-chips">
              <span className={`owner-status ${open ? "owner-status-draft" : "owner-status-active"}`}>{open ? t("bp.state.OPEN") : t(`bp.draft_status.${draft.status}`)}</span>
              <span className="owner-chip owner-chip-quiet">{t("drafts.imported")}</span>
            </div>
            <h1 className="owner-summary-title" dir="rtl" lang="ar">{p.title_ar || draft.title}</h1>
            {p.title_en && <p className="owner-name-en" dir="ltr" lang="en">{p.title_en}</p>}
            <dl className="owner-lines">
              {path && <div><dt>{t("details.category")}</dt><dd>{path}</dd></div>}
              {brandName && <div><dt>{t("catalog.col.brand")}</dt><dd>{brandName}</dd></div>}
              <div><dt>{t("details.price")}</dt><dd className="owner-price">{money(p.price)}</dd></div>
              {discount && <div><dt>{t("details.discount")}</dt><dd>{discount}</dd></div>}
            </dl>
            {open && (
              <div className="owner-summary-actions">
                <button type="button" className="button owner-primary" onClick={() => onReview?.(draft.id)} disabled={!onReview} data-testid="draft-details-review">
                  <IconEdit /> {t("bp.review")}
                </button>
              </div>
            )}
          </div>
        </section>

        <section className="owner-card" aria-labelledby="dd-colors" data-testid="draft-details-colors">
          <h2 id="dd-colors">{t("details.colors")}</h2>
          {colors.length === 0 ? (
            <p className="muted">{t("details.none")}</p>
          ) : (
            <ul className="owner-color-list">
              {colors.map((c) => {
                const name = lang === "en" ? c.name_en || c.name_ar : c.name_ar;
                const sizes = p.sizes?.[c.key] ?? [];
                return (
                  <li key={c.key} className="owner-color">
                    <div className="owner-color-id">
                      <span className="owner-color-dot" style={{ background: familyHex(c) }} aria-hidden="true" />
                      <span>
                        <strong>{name}</strong>
                        <span className="muted owner-color-meta">{fill(t("details.sizes_count"), { n: sizes.length })}</span>
                      </span>
                    </div>
                    <ul className="owner-chips" aria-label={fill(t("details.sizes_of"), { color: name })}>
                      {sizes.map((s) => (
                        <li key={s} className="owner-chip">{sizeLabel(s)}</li>
                      ))}
                    </ul>
                    <div className="owner-color-images">
                      {c.images.length === 0 ? (
                        <span className="muted">{t("details.no_images")}</span>
                      ) : (
                        c.images.map((url, i) => (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img key={url} src={url} alt={fill(t("details.image_alt"), { color: name, n: i + 1 })} className="owner-thumb" />
                        ))
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {(p.shared_images ?? []).length > 0 && (
            <div className="owner-shared">
              <h3>{t("details.shared_images")}</h3>
              <div className="owner-color-images">
                {p.shared_images!.map((url, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={url} src={url} alt={fill(t("details.shared_alt"), { n: i + 1 })} className="owner-thumb" />
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="owner-card" aria-labelledby="dd-stock" data-testid="draft-details-stock">
          <div className="owner-card-head">
            <h2 id="dd-stock">{t("details.stock")} <span className="wz-start-count">{total}</span></h2>
          </div>
          {colors.length === 0 || stockBranches.length === 0 ? (
            <p className="muted">{t("details.none")}</p>
          ) : (
            <div className="owner-scroll" role="region" aria-labelledby="dd-stock" tabIndex={0}>
              <table className="owner-mini-table">
                <thead>
                  <tr>
                    <th scope="col">{t("details.version")}</th>
                    {stockBranches.map((b) => (
                      <th key={b.id} scope="col">{b.name}</th>
                    ))}
                    <th scope="col">{t("wz.grid.total")}</th>
                  </tr>
                </thead>
                {colors.map((c) => {
                  const name = lang === "en" ? c.name_en || c.name_ar : c.name_ar;
                  const sizes = p.sizes?.[c.key] ?? [];
                  return (
                    <tbody key={c.key}>
                      <tr className="owner-group-row">
                        <th scope="colgroup" colSpan={stockBranches.length + 1}>
                          <span className="owner-color-id"><span className="owner-color-dot" style={{ background: familyHex(c) }} aria-hidden="true" /> {name}</span>
                        </th>
                        <td className="owner-total">{sizes.reduce((n, s) => n + stockBranches.reduce((a, b) => a + qty(b.id, c.key, s), 0), 0)}</td>
                      </tr>
                      {sizes.map((s) => (
                        <tr key={s}>
                          <th scope="row" className="owner-size-cell"><span className="visually-hidden">{name} / </span>{sizeLabel(s)}</th>
                          {stockBranches.map((b) => (
                            <td key={b.id}>{qty(b.id, c.key, s)}</td>
                          ))}
                          <td>{stockBranches.reduce((a, b) => a + qty(b.id, c.key, s), 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  );
                })}
              </table>
            </div>
          )}
        </section>

        <section className="owner-card" aria-labelledby="dd-about" data-testid="draft-details-about">
          <h2 id="dd-about">{t("details.about")}</h2>
          <h3>{t("details.description")}</h3>
          <p className="owner-description">{description?.trim() || <span className="muted">{t("details.none")}</span>}</p>
          <h3>{t("details.specs")}</h3>
          {specs.length === 0 ? (
            <p className="muted">{t("details.none")}</p>
          ) : (
            <dl className="owner-lines owner-lines-cols">
              {specs.map(([k, v]) => (
                <div key={k}><dt>{specName(k)}</dt><dd>{specValueText(k, v, lang)}</dd></div>
              ))}
            </dl>
          )}
          <h3>{t("comp.view_title")}</h3>
          {p.composition || p.country_of_origin ? (
            <CompositionView composition={p.composition ?? null} country={p.country_of_origin ?? null} lang={lang} heading={false} />
          ) : (
            <p className="muted">{t("details.none")}</p>
          )}
          <h3>{t("details.measurements")}</h3>
          {p.measurements && p.measurements.keys.length > 0 ? (
            <div className="owner-scroll" role="region" aria-label={t("details.measurements")} tabIndex={0}>
              <table className="owner-mini-table">
                <caption className="visually-hidden">{t("details.measurements")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("wz.measure.size")}</th>
                    {p.measurements.keys.map((k) => (
                      <th key={k} scope="col">{t(`wz.key.${k}`)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(p.measurements.values).map(([size, row]) => (
                    <tr key={size}>
                      <th scope="row">{sizeLabel(size)}</th>
                      {p.measurements!.keys.map((k) => (
                        <td key={k}>{row[k] ?? "—"}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">{t("details.none")}</p>
          )}
          <h3>{t("wz.model.title")}</h3>
          <p>{p.model?.height_cm && p.model.size ? fill(t("details.model"), { h: p.model.height_cm, size: sizeLabel(p.model.size) }) : <span className="muted">{t("details.none")}</span>}</p>
        </section>

        <section className="owner-card" aria-labelledby="dd-publish" data-testid="draft-details-publish">
          <h2 id="dd-publish">{t("details.publishing")}</h2>
          <dl className="owner-lines">
            <div><dt>{t("catalog.col.status")}</dt><dd>{open ? t("bp.state.OPEN") : t(`bp.draft_status.${draft.status}`)}</dd></div>
            {open && problems && (
              <div>
                <dt>{t("details.ready")}</dt>
                <dd data-testid="draft-details-ready">{problems.length === 0 ? t("details.ready.yes") : [...new Set(problems.map((x) => gateReason(t, x.code)))].join("، ")}</dd>
              </div>
            )}
            {(p.sections ?? []).length > 0 && <div><dt>{t("bp.collections")}</dt><dd>{fill(t("bp.collections_n"), { n: p.sections!.length })}</dd></div>}
          </dl>
        </section>
      </div>
    </div>
  );
}
