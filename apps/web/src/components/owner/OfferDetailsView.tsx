"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { EditProductButton } from "@/components/product-wizard/EditProductButton";
import { ProductWizardPanel } from "@/components/product-wizard/ProductWizardPanel";
import { IconBack, IconEdit, IconEye } from "@/components/product-wizard/wizardIcons";
import { CompositionView } from "@/components/CompositionView";
import type { Composition } from "@/lib/composition";
import { ErrorBanner } from "@/components/States";
import { OfferCollectionsSummary } from "./collections/OfferCollectionsSummary";
import "@/lib/storePosText";
import { ApiError, apiFetch } from "@/lib/api";
import { templateFieldLabel } from "@/lib/clothingTemplates";
import { loginRedirectHref } from "@/lib/loginRedirect";
import { fill } from "@/lib/offerWizardText";
import "@/lib/offerWizardText";
import { getSessionToken } from "@/lib/session";
import { specValueText } from "@/lib/specCodes";
import { useTaxonomy } from "@/lib/taxonomy";
import { useLang, useT } from "@/lib/useLang";

interface OfferDto {
  id: string;
  title_ar: string;
  title_en: string;
  status: "DRAFT" | "ACTIVE" | "INACTIVE" | "ARCHIVED";
  brand_id: string | null;
  canonical_product_id: string | null;
  template_attributes: Record<string, unknown> | null;
  price_is_offer_level?: boolean;
  edit_via_draft?: boolean;
  composition?: Composition | null;
  country_of_origin?: string | null;
}
interface VariantDto {
  id: string;
  colour: string | null;
  size: string | null;
  base_price: string;
  sale_price: string | null;
  discount_percent: string | null;
  discount_start_at: string | null;
  discount_end_at: string | null;
  effective_price: number;
  specs_text_ar: string | null;
  specs_text_en: string | null;
}
interface Combination {
  variant_id: string;
  color_code: string | null;
  size_code: string | null;
  colour: string | null;
  size: string | null;
  total_quantity: number;
  stock: { branch_id: string; quantity: number; reserved: number }[];
}
interface MediaDto {
  url: string;
  kind: "PRIMARY" | "ADDITIONAL";
  media_type: "IMAGE" | "VIDEO";
  sort_order: number;
}
interface Branch {
  id: string;
  name: string;
  archived_at: string | null;
}
interface Classification {
  classified: boolean;
  audiences: string[];
  categories: string[];
}
interface Presentation {
  model: { height_cm: number; size: string } | null;
  shared_images: string[];
}
interface Measurements {
  version: number | null;
  published_at: string | null;
  measurements: { keys: string[]; values: Record<string, Record<string, number>> } | null;
}
interface PublishCheck {
  ready: boolean;
  missing: string[];
}

/** One product colour as the page shows it: its name, family colour, sizes, images, versions. */
interface ColorGroup {
  key: string;
  name: string;
  family: string | null;
  sizes: { code: string; label: string; variantId: string; total: number; stock: Combination["stock"] }[];
  images: string[];
}

/**
 * The owner's product details: a read-only, ordered page (summary; colours,
 * images and sizes; stock by branch; description, specifications, size
 * table and model; publishing) - no form, no save, read as connected lines
 * rather than label/value boxes. «تعديل المنتج» is the main action;
 * «معاينة كمتسوقة» opens the shopper's page in a new tab. The old quick
 * status/price page is deliberately not linked from here.
 */
export function OfferDetailsView({
  vendorId,
  offerId,
  embedded = false,
  onEdit,
  onManageCollections,
  onManageBarcodes,
}: {
  vendorId: string;
  offerId: string;
  /** Inside the workspace's large panel: no page shell, no back link (the panel has its own). */
  embedded?: boolean;
  /** In the panel, «تعديل المنتج» replaces this view with the edit wizard; standalone, it opens its own wizard panel. */
  onEdit?: (draftId: string) => void;
  /** In the panel, «إدارة المجموعات» opens this product's collections screen in the same window. */
  onManageCollections?: (offerId: string, title: string) => void;
  /** In the panel, «إدارة الباركود» opens this product's barcode screen in the same window (else its own page). */
  onManageBarcodes?: (offerId: string, title: string) => void;
}) {
  const params = { vendorId, offerId };
  const router = useRouter();
  const t = useT();
  const lang = useLang();
  const taxonomy = useTaxonomy();
  const [offer, setOffer] = useState<OfferDto | null>(null);
  const [variants, setVariants] = useState<VariantDto[]>([]);
  const [combos, setCombos] = useState<Combination[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [brandName, setBrandName] = useState<string | null>(null);
  const [classification, setClassification] = useState<Classification | null>(null);
  const [presentation, setPresentation] = useState<Presentation | null>(null);
  const [measurements, setMeasurements] = useState<Measurements | null>(null);
  const [check, setCheck] = useState<PublishCheck | null>(null);
  const [media, setMedia] = useState<Record<string, string[]>>({});
  const [slug, setSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<string | null>(null);
  // the product's store barcodes - read only here (null: the feature is off / not loaded)
  const [barcodes, setBarcodes] = useState<{ display_code: string; is_primary: boolean }[] | null>(null);
  const base = `/vendors/${params.vendorId}/offers/${params.offerId}`;

  // a promise chain (no state set synchronously inside the effect that calls it)
  const load = useCallback(() => {
    void apiFetch<OfferDto>(base).then(async (o) => {
      setOffer(o);
      const optional = <T,>(p: Promise<T>) => p.catch(() => null);
      const [vs, cs, bs, cl, pr, ms, pc, sf, bc, brands] = await Promise.all([
        apiFetch<VariantDto[]>(`${base}/variants`),
        optional(apiFetch<{ items: Combination[] }>(`${base}/combinations`)),
        optional(apiFetch<Branch[]>(`/vendors/${params.vendorId}/branches`)),
        optional(apiFetch<Classification>(`${base}/classification`)),
        optional(apiFetch<Presentation>(`${base}/presentation`)),
        optional(apiFetch<Measurements>(`/vendors/${params.vendorId}/offers/${params.offerId}/measurements`)),
        optional(apiFetch<PublishCheck>(`${base}/publish-check`)),
        optional(apiFetch<{ slug: string }>(`/vendors/${params.vendorId}/storefront`)),
        optional(apiFetch<{ items: { display_code: string; is_primary: boolean }[] }>(`${base}/barcodes`)),
        o.brand_id ? optional(apiFetch<{ id: string; name: string; is_no_brand?: boolean }[]>("/brands", { auth: false })) : Promise.resolve(null),
      ]);
      setVariants(vs);
      setCombos(cs?.items ?? []);
      setBranches((bs ?? []).filter((b) => !b.archived_at));
      setClassification(cl);
      setPresentation(pr);
      setMeasurements(ms);
      setCheck(pc);
      setSlug(sf?.slug ?? null);
      setBarcodes(bc?.items ?? null);
      const b = brands?.find((x) => x.id === o.brand_id) ?? null;
      setBrandName(b ? (b.is_no_brand ? t("details.no_brand") : b.name) : null);
    }).catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        router.replace(loginRedirectHref());
        return;
      }
      setError(err instanceof ApiError && err.status === 404 ? t("details.not_found") : t("details.load_failed"));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, params.vendorId, params.offerId]);

  useEffect(() => {
    if (!getSessionToken()) {
      router.replace(loginRedirectHref());
      return;
    }
    load();
  }, [load, router]);

  const sizeLabel = useCallback((code: string | null, fallback: string | null) => taxonomy.data?.sizes.find((s) => s.code === code)?.label ?? fallback ?? code ?? "", [taxonomy.data]);
  const familyHex = (code: string | null) => taxonomy.data?.colors.find((c) => c.code === code)?.hex ?? null;

  // colours in the product's own order (the order of its first versions), each with its sizes
  const groups = useMemo<ColorGroup[]>(() => {
    const out: ColorGroup[] = [];
    const rows = combos.length > 0 ? combos : variants.map((v) => ({ variant_id: v.id, color_code: null, size_code: null, colour: v.colour, size: v.size, total_quantity: 0, stock: [] }));
    for (const c of rows) {
      const key = `${c.color_code ?? ""}|${c.colour ?? ""}`;
      let g = out.find((x) => x.key === key);
      if (!g) {
        g = { key, name: c.colour ?? "—", family: c.color_code, sizes: [], images: [] };
        out.push(g);
      }
      g.sizes.push({ code: c.size_code ?? c.size ?? "", label: sizeLabel(c.size_code, c.size), variantId: c.variant_id, total: c.total_quantity, stock: c.stock });
    }
    for (const g of out) g.sizes.sort((a, b) => (taxonomy.data?.sizes.find((s) => s.code === a.code)?.sort_order ?? 0) - (taxonomy.data?.sizes.find((s) => s.code === b.code)?.sort_order ?? 0));
    return out;
  }, [combos, variants, taxonomy.data, sizeLabel]);

  // one image set per colour (its first version's)
  const groupKeys = groups.map((g) => `${g.key}=${g.sizes[0]?.variantId}`).join(",");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next: Record<string, string[]> = {};
      for (const g of groups) {
        const first = g.sizes[0]?.variantId;
        if (!first) continue;
        try {
          const m = await apiFetch<MediaDto[]>(`${base}/variants/${first}/media`);
          next[g.key] = m
            .filter((x) => x.media_type === "IMAGE")
            .sort((a, b) => (a.kind === "PRIMARY" ? -1 : b.kind === "PRIMARY" ? 1 : a.sort_order - b.sort_order))
            .map((x) => x.url);
        } catch {
          next[g.key] = [];
        }
      }
      if (!cancelled) setMedia(next);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupKeys, base]);

  const shellClass = embedded ? "owner-catalog owner-details owner-embedded" : "page-shell wz-start owner-catalog owner-details";
  if (error) {
    return (
      <div className={shellClass}>
        <ErrorBanner message={error} />
        <Link href={`/vendor/${params.vendorId}/offers`} className="button-link">{t("catalog.title")}</Link>
      </div>
    );
  }
  if (!offer) {
    return (
      <div className={shellClass} aria-busy="true">
        <div className="skeleton" style={{ height: 220, maxWidth: 1100 }} />
      </div>
    );
  }

  const title = lang === "en" ? offer.title_en || offer.title_ar : offer.title_ar;
  const first = variants[0] ?? null;
  const mainImage = groups.map((g) => media[g.key]?.[0]).find(Boolean) ?? null;
  const categoryNames = (classification?.categories ?? []).map((code) => {
    const c = taxonomy.data?.categories.find((x) => x.code === code);
    return c ? (lang === "en" ? c.name_en || c.name_ar : c.name_ar) : code;
  });
  const path = [...(classification?.audiences ?? []).map((a) => t(`wz.audience.${a}`)), ...categoryNames].join(" › ");
  const categoryChip = categoryNames[categoryNames.length - 1] ?? null;
  const money = (v: string | number | null) => (v === null ? "—" : `${Number(v).toFixed(2)} ₪`);
  const discount = !first
    ? null
    : first.discount_percent !== null
      ? fill(t("details.discount.percent"), { p: Number(first.discount_percent) })
      : first.sale_price !== null
        ? fill(t("details.discount.sale"), { price: money(first.sale_price) })
        : null;
  const description = first ? (lang === "en" ? first.specs_text_en || first.specs_text_ar : first.specs_text_ar) : null;
  const specs = Object.entries(offer.template_attributes ?? {}).filter(([, v]) => typeof v === "string" && v.trim() && v !== "N/A") as [string, string][];
  const specName = (key: string) => (t(`wz.spec.${key}`) !== `wz.spec.${key}` ? t(`wz.spec.${key}`) : templateFieldLabel(key));
  const total = combos.reduce((n, c) => n + c.total_quantity, 0);
  const shopperUrl = offer.status === "ACTIVE" && slug ? `/store/${slug}/products/${offer.id}` : null;
  const directEditUrl = `/vendor/${params.vendorId}/offers/${offer.id}`;
  const when = (iso: string) => new Date(iso).toLocaleDateString(lang === "en" ? "en-GB" : "ar", { dateStyle: "medium" });
  const swatch = (g: ColorGroup) => <span className="owner-color-dot" style={{ background: familyHex(g.family) ?? "#d9cfc4" }} aria-hidden="true" />;

  return (
    <div className={shellClass}>
      {!embedded && (
        <nav className="owner-details-back" aria-label={t("details.breadcrumb")}>
          <Link href={`/vendor/${params.vendorId}/offers`} className="owner-quiet-link">
            <IconBack /> {t("catalog.title")}
          </Link>
        </nav>
      )}

      <div className="owner-details-sections">
        {/* 1. summary: one card - image, name, chips, reading lines, actions */}
        <section className="owner-card owner-summary" aria-label={t("details.summary")} data-testid="details-summary">
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
              <span className={`owner-status owner-status-${offer.status.toLowerCase()}`}>{t(`catalog.status.${offer.status}`)}</span>
              {categoryChip && <span className="owner-chip owner-chip-quiet">{categoryChip}</span>}
            </div>
            <h1 className="owner-summary-title" dir="rtl" lang="ar">{offer.title_ar}</h1>
            {offer.title_en && <p className="owner-name-en" dir="ltr" lang="en">{offer.title_en}</p>}
            <dl className="owner-lines">
              {path && <div><dt>{t("details.category")}</dt><dd>{path}</dd></div>}
              {brandName && <div><dt>{t("catalog.col.brand")}</dt><dd>{brandName}</dd></div>}
              {first && <div><dt>{t("details.price")}</dt><dd className="owner-price">{money(first.base_price)}</dd></div>}
              {discount && first && (
                <div><dt>{t("details.discount")}</dt><dd>{discount} <span className="muted">· {fill(t("details.now"), { price: money(first.effective_price) })}</span></dd></div>
              )}
            </dl>
            {!offer.price_is_offer_level && offer.status !== "ARCHIVED" && <p className="wz-hint owner-details-note">{t("edit.classify_first")}</p>}
            <div className="owner-summary-actions">
              {offer.edit_via_draft ? (
                <EditProductButton vendorId={params.vendorId} offer={offer} onOpen={(id) => (onEdit ? onEdit(id) : setEditDraft(id))} className="button owner-primary" />
              ) : (
                offer.status !== "ARCHIVED" && (
                  <Link href={directEditUrl} className="button owner-primary" data-testid="details-edit-direct">
                    <IconEdit /> {t("edit.button")}
                  </Link>
                )
              )}
              {shopperUrl && (
                <a href={shopperUrl} target="_blank" rel="noopener noreferrer" className="button-link owner-secondary" data-testid="details-preview">
                  <IconEye /> {t("details.preview")}
                  <span className="visually-hidden"> ({t("details.new_tab")})</span>
                </a>
              )}
              {/* the barcode is managed on its own screen (same window) - this page stays read only */}
              {barcodes !== null && offer.status !== "ARCHIVED" && (
                onManageBarcodes ? (
                  <button type="button" className="owner-quiet-link details-barcodes-action" onClick={() => onManageBarcodes(offer.id, offer.title_ar)} data-testid="details-manage-barcodes">
                    {t("bc.manage")}
                  </button>
                ) : (
                  <Link href={`/vendor/${params.vendorId}/offers/${offer.id}/barcodes`} className="owner-quiet-link details-barcodes-action" data-testid="details-manage-barcodes">
                    {t("bc.manage")}
                  </Link>
                )
              )}
            </div>
          </div>
        </section>

        {/* 2. colours, images and sizes: one row per colour */}
        <section className="owner-card" aria-labelledby="d-colors" data-testid="details-colors">
          <h2 id="d-colors">{t("details.colors")}</h2>
          {groups.length === 0 ? (
            <p className="muted">{t("details.none")}</p>
          ) : (
            <ul className="owner-color-list">
              {groups.map((g) => (
                <li key={g.key} className="owner-color">
                  <div className="owner-color-id">
                    {swatch(g)}
                    <span>
                      <strong>{g.name}</strong>
                      <span className="muted owner-color-meta">{fill(t("details.sizes_count"), { n: g.sizes.length })}</span>
                    </span>
                  </div>
                  <ul className="owner-chips" aria-label={fill(t("details.sizes_of"), { color: g.name })}>
                    {g.sizes.map((s) => (
                      <li key={s.variantId} className="owner-chip">{s.label}</li>
                    ))}
                  </ul>
                  <div className="owner-color-images">
                    {(media[g.key] ?? []).length === 0 ? (
                      <span className="muted">{t("details.no_images")}</span>
                    ) : (
                      (media[g.key] ?? []).map((url, i) => (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img key={url} src={url} alt={fill(t("details.image_alt"), { color: g.name, n: i + 1 })} className="owner-thumb" />
                      ))
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {(presentation?.shared_images ?? []).length > 0 && (
            <div className="owner-shared">
              <h3>{t("details.shared_images")}</h3>
              <div className="owner-color-images">
                {presentation!.shared_images.map((url, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={url} src={url} alt={fill(t("details.shared_alt"), { n: i + 1 })} className="owner-thumb" />
                ))}
              </div>
            </div>
          )}
        </section>

        {/* 3. stock by branch, colour and size */}
        <section className="owner-card" aria-labelledby="d-stock" data-testid="details-stock">
          <div className="owner-card-head">
            <h2 id="d-stock">{t("details.stock")} <span className="wz-start-count">{total}</span></h2>
            {branches.length > 0 && (
              <div className="owner-stock-links">
                {branches.map((b) => (
                  <Link key={b.id} href={`/vendor/${params.vendorId}/branches/${b.id}/stock`} className="owner-quiet-link">
                    {branches.length > 1 ? fill(t("details.stock_screen_of"), { branch: b.name }) : t("details.stock_screen")}
                  </Link>
                ))}
              </div>
            )}
          </div>
          {groups.length === 0 || branches.length === 0 ? (
            <p className="muted">{t("details.none")}</p>
          ) : (
            <div className="owner-scroll" role="region" aria-labelledby="d-stock" tabIndex={0}>
              <table className="owner-mini-table">
                <thead>
                  <tr>
                    <th scope="col">{t("details.version")}</th>
                    {branches.map((b) => (
                      <th key={b.id} scope="col">{b.name}</th>
                    ))}
                    <th scope="col">{t("wz.grid.total")}</th>
                  </tr>
                </thead>
                {groups.map((g) => (
                  <tbody key={g.key}>
                    <tr className="owner-group-row">
                      <th scope="colgroup" colSpan={branches.length + 1}>
                        <span className="owner-color-id">{swatch(g)} {g.name}</span>
                      </th>
                      <td className="owner-total">{g.sizes.reduce((n, s) => n + s.total, 0)}</td>
                    </tr>
                    {g.sizes.map((s) => (
                      <tr key={s.variantId}>
                        <th scope="row" className="owner-size-cell">
                          <span className="visually-hidden">{g.name} / </span>{s.label}
                        </th>
                        {branches.map((b) => {
                          const row = s.stock.find((x) => x.branch_id === b.id);
                          return (
                            <td key={b.id}>
                              {row?.quantity ?? 0}
                              {row && row.reserved > 0 && <span className="muted"> ({fill(t("details.reserved"), { n: row.reserved })})</span>}
                            </td>
                          );
                        })}
                        <td>{s.total}</td>
                      </tr>
                    ))}
                  </tbody>
                ))}
                <tfoot>
                  <tr>
                    <th scope="row" colSpan={branches.length + 1}>{t("wz.grid.total")}</th>
                    <td className="owner-total">{total}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </section>

        {/* 4. description and specifications, size table, model */}
        <section className="owner-card" aria-labelledby="d-about" data-testid="details-about">
          <h2 id="d-about">{t("details.about")}</h2>
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
          {offer.composition || offer.country_of_origin ? (
            <CompositionView composition={offer.composition ?? null} country={offer.country_of_origin ?? null} lang={lang} heading={false} />
          ) : (
            <p className="muted" data-testid="details-composition-none">{t("details.none")}</p>
          )}
          <h3>{t("details.measurements")}</h3>
          {measurements?.measurements ? (
            <div className="owner-scroll" role="region" aria-label={t("details.measurements")} tabIndex={0}>
              <table className="owner-mini-table">
                <caption className="visually-hidden">{t("details.measurements")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("wz.measure.size")}</th>
                    {measurements.measurements.keys.map((k) => (
                      <th key={k} scope="col">{t(`wz.key.${k}`)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(measurements.measurements.values).map(([size, row]) => (
                    <tr key={size}>
                      <th scope="row">{sizeLabel(size, size)}</th>
                      {measurements.measurements!.keys.map((k) => (
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
          <p>{presentation?.model ? fill(t("details.model"), { h: presentation.model.height_cm, size: sizeLabel(presentation.model.size, presentation.model.size) }) : <span className="muted">{t("details.none")}</span>}</p>
        </section>

        {/* 5. publishing */}
        <section className="owner-card" aria-labelledby="d-publish" data-testid="details-publish">
          <h2 id="d-publish">{t("details.publishing")}</h2>
          <dl className="owner-lines">
            <div><dt>{t("catalog.col.status")}</dt><dd><span className={`owner-status owner-status-${offer.status.toLowerCase()}`}>{t(`catalog.status.${offer.status}`)}</span></dd></div>
            {offer.status !== "ACTIVE" && offer.status !== "ARCHIVED" && check && (
              <div>
                <dt>{t("details.ready")}</dt>
                <dd>
                  {check.ready ? t("details.ready.yes") : check.missing.map((m) => t(`wz.publish_reason.${m}`)).join("، ")}
                  {/* putting it back needs a barcode: the way to add (or generate) one, right here */}
                  {check.missing.includes("barcode") && (
                    onManageBarcodes ? (
                      <button type="button" className="owner-quiet-link" onClick={() => onManageBarcodes(offer.id, offer.title_ar)} data-testid="details-barcode-needed"> {t("details.barcode_needed")}</button>
                    ) : (
                      <Link href={`/vendor/${params.vendorId}/offers/${offer.id}/barcodes`} className="owner-quiet-link" data-testid="details-barcode-needed"> {t("details.barcode_needed")}</Link>
                    )
                  )}
                </dd>
              </div>
            )}
            {measurements?.version != null && (
              <div><dt>{t("details.size_table_version")}</dt><dd>{fill(t("details.size_table_value"), { v: measurements.version, when: measurements.published_at ? when(measurements.published_at) : "—" })}</dd></div>
            )}
            <div><dt>{t("details.matched")}</dt><dd>{offer.canonical_product_id ? t("catalog.yes") : t("catalog.no")}</dd></div>
            {barcodes !== null && (
              <div>
                <dt>{t("bc.title")}</dt>
                <dd data-testid="details-barcode-line">
                  {barcodes.length === 0
                    ? <span className="muted">{t("bc.none_short")}</span>
                    : <><span dir="ltr" className="pos-code-inline">{(barcodes.find((b) => b.is_primary) ?? barcodes[0]).display_code}</span>{barcodes.length > 1 && <span className="muted"> · {fill(t("bc.more"), { n: barcodes.length - 1 })}</span>}</>}
                </dd>
              </div>
            )}
          </dl>
          {/* «مجموعات المتجر»: read only here - «إدارة المجموعات» changes them on its own screen (directly, audited) */}
          {offer.status !== "ARCHIVED" && (
            <OfferCollectionsSummary
              vendorId={params.vendorId}
              offerId={offer.id}
              onManage={onManageCollections ? () => onManageCollections(offer.id, offer.title_ar) : undefined}
              manageHref={onManageCollections ? undefined : `/vendor/${params.vendorId}/offers?open=offer-collections&offer=${offer.id}`}
            />
          )}
        </section>
      </div>

      {editDraft && (
        <ProductWizardPanel
          vendorId={params.vendorId}
          open={{ draftId: editDraft }}
          onClose={() => {
            setEditDraft(null);
            load();
          }}
        />
      )}
    </div>
  );
}
