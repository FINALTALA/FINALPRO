"use client";

import { autoColorName, COLOR_NAME_MAX, MAX_PRODUCT_COLORS, nextColorKey, normalizeColorName, swatchBackground } from "@/lib/colorName";
import { ImageAdviceBadge, imageAdvice, ModelInputs, MODEL_HEIGHT_MAX_CM, MODEL_HEIGHT_MIN_CM, SharedImagesEditor, type ImageAdvice } from "./presentation";
import { type ReactNode, useId, useMemo, useState } from "react";
import { uploadVendorImage } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiErrors";
import {
  type DraftColor,
  AUDIENCES,
  type DraftBrandRequest,
  type DraftProblem,
  draftSizes,
  MAX_IMAGES_PER_COLOR,
  MEASURE_LIMITS_CM,
  measureKeysFor,
  measurementsEmpty,
  missingMeasurements,
  type MeasureKey,
  SPEC_OPTIONS,
  sizeSystemOf,
  sizeSystemsFor,
  specFieldsFor,
  stockFor,
  suggestedSizeSystem,
  versionKey,
  withQuantities,
  pruneVersions,
  type Audience,
  type DraftEdit,
  type DraftPayload,
  type SizeSystem,
} from "@/lib/offerWizard";
import { DiscountFields } from "@/components/DiscountFields";
import { CODED_SPECS, MULTI_SPECS, isCodedSpec, specCodesOf } from "@/lib/specCodes";
import { discountProblem } from "@/lib/discountWindow";
import { countryName, partText } from "@/lib/composition";
import type { Lang } from "@/lib/i18n";
import { CompositionField } from "./CompositionField";
import { fill } from "@/lib/offerWizardText";
import type { TaxonomyDto } from "@/lib/taxonomy";
import type { SaveState } from "@/lib/useDraftAutosave";

export interface BrandOption {
  id: string;
  name: string;
  is_no_brand?: boolean;
}
export interface BranchOption {
  id: string;
  name: string;
  archived_at: string | null;
}

interface CommonProps {
  payload: DraftPayload;
  update: (change: (p: DraftPayload) => DraftPayload) => void;
  taxonomy: TaxonomyDto | null;
  lang: string;
  t: (key: string) => string;
  showProblems: boolean;
  colorName: (code: string) => string;
  /** Edit drafts: the published product being edited (null: a new product). */
  edit?: DraftEdit | null;
}

function FieldError({ id, text }: { id: string; text: string | null }) {
  if (!text) return null;
  return (
    <p id={id} className="wz-field-error" role="alert">
      {text}
    </p>
  );
}

// ------------------------------------------------------------- step 1

export function StepDetails({ payload, update, taxonomy, lang, t, showProblems, brands, brandRequest, edit, onCopyAsNew }: CommonProps & { brands: BrandOption[]; brandRequest: DraftBrandRequest | null; onCopyAsNew?: () => void }) {
  const uid = useId();
  const categories = useMemo(
    () =>
      (taxonomy?.categories ?? [])
        .filter((c) => payload.audience && c.audiences.includes(payload.audience))
        .sort((a, b) => a.sort_order - b.sort_order),
    [taxonomy, payload.audience],
  );
  const fields = specFieldsFor(payload.category);
  const err = (cond: boolean, key: string) => (showProblems && cond ? t(key) : null);

  function chooseAudience(a: Audience) {
    update((p) => {
      const fits = (taxonomy?.categories ?? []).some((c) => c.code === p.category && c.audiences.includes(a));
      if (a === p.audience) return p;
      // Another audience: a category that does not fit it is cleared (never kept silently),
      // and sizes go when the size systems differ (children's ages vs adult sizes).
      const keepSizes = (a === "KIDS") === (p.audience === "KIDS");
      return pruneVersions({ ...p, audience: a, category: fits ? p.category : null, ...(keepSizes ? {} : { sizes: {}, size_system: null }) });
    });
  }

  return (
    <div className="wz-fields">
      <fieldset className="wz-field">
        <legend>
          {t("wz.audience")} <span className="wz-req">*</span>
        </legend>
        <div className="wz-choice-row" role="radiogroup" aria-required="true" data-testid="wz-audience">
          {AUDIENCES.map((a) => (
            <label key={a} className={`wz-choice${payload.audience === a ? " wz-choice-on" : ""}`}>
              <input type="radio" name={`${uid}-audience`} checked={payload.audience === a} disabled={!!edit} onChange={() => chooseAudience(a)} />
              {t(`wz.audience.${a}`)}
            </label>
          ))}
        </div>
        <FieldError id={`${uid}-aud-err`} text={err(!payload.audience, "wz.p.AUDIENCE_REQUIRED")} />
      </fieldset>

      <div className="wz-field">
        <label htmlFor={`${uid}-cat`}>
          {t("wz.category")} <span className="wz-req">*</span>
        </label>
        <select
          id={`${uid}-cat`}
          data-testid="wz-category"
          value={payload.category ?? ""}
          disabled={!payload.audience || !!edit}
          onChange={(e) => update((p) => pruneVersions({ ...p, category: e.target.value || null }))}
        >
          <option value="">{payload.audience ? t("wz.category.pick") : t("wz.category.audience_first")}</option>
          {categories.map((c) => (
            <option key={c.code} value={c.code}>
              {lang === "en" ? c.name_en || c.name_ar : c.name_ar}
            </option>
          ))}
        </select>
        <FieldError id={`${uid}-cat-err`} text={err(!payload.category, "wz.p.CATEGORY_REQUIRED")} />
        {edit && (
          <p className="wz-hint wz-edit-locked" data-testid="wz-edit-locked-context">
            {t("wz.edit.locked_context")}{" "}
            {onCopyAsNew && (
              <button type="button" className="button-link" onClick={onCopyAsNew} data-testid="wz-edit-copy-new">
                {t("copy.button")}
              </button>
            )}
          </p>
        )}
      </div>

      <div className="wz-field">
        <label htmlFor={`${uid}-tar`}>
          {t("wz.title_ar")} <span className="wz-req">*</span>
        </label>
        <input id={`${uid}-tar`} dir="rtl" data-testid="wz-title-ar" value={payload.title_ar ?? ""} onChange={(e) => update((p) => ({ ...p, title_ar: e.target.value }))} aria-describedby={`${uid}-tar-ex`} />
        <p id={`${uid}-tar-ex`} className="wz-hint">{t("wz.title_ar.example")}</p>
        <FieldError id={`${uid}-tar-err`} text={err(!(payload.title_ar ?? "").trim(), "wz.p.TITLE_AR_REQUIRED")} />
      </div>
      <div className="wz-field">
        <label htmlFor={`${uid}-ten`}>
          {t("wz.title_en")} <span className="wz-opt">({t("wz.optional")})</span>
        </label>
        <input id={`${uid}-ten`} dir="ltr" data-testid="wz-title-en" value={payload.title_en ?? ""} onChange={(e) => update((p) => ({ ...p, title_en: e.target.value }))} aria-describedby={`${uid}-ten-ex`} />
        <p id={`${uid}-ten-ex`} className="wz-hint">{t("wz.title_en.optional_note")} {t("wz.title_en.example")}</p>
      </div>

      <BrandField payload={payload} update={update} brands={brands} t={t} error={err(!payload.brand, "wz.p.BRAND_REQUIRED")} brandRequest={brandRequest} />

      <fieldset className="wz-field" data-testid="wz-specs">
        <legend>
          {t("wz.specs")} <span className="wz-opt">({t("wz.optional")})</span>
        </legend>
        {fields.length === 0 ? (
          <p className="wz-hint">{t("wz.specs.none")}</p>
        ) : (
          <>
            <p className="wz-hint">{t("wz.specs.note")}</p>
            <div className="wz-spec-grid">
              {fields.map((f) => (
                <SpecChoice key={f} field={f} value={payload.specs?.[f] ?? ""} lang={lang} t={t} onChange={(v) => update((p) => {
                  const specs = { ...(p.specs ?? {}) };
                  if (v.trim()) specs[f] = v;
                  else delete specs[f];
                  return { ...p, specs };
                })} />
              ))}
            </div>
          </>
        )}
      </fieldset>

      <CompositionField
        composition={payload.composition}
        country={payload.country_of_origin}
        lang={lang as Lang}
        t={t}
        showProblems={showProblems}
        onChange={(next) => update((p) => ({ ...p, ...next }))}
      />
    </div>
  );
}

function SpecField({ field, value, onChange, lang, t }: { field: string; value: string; onChange: (v: string) => void; lang: string; t: (k: string) => string }) {
  const uid = useId();
  const options = SPEC_OPTIONS[field] ?? [];
  const known = options.some((o) => o.ar === value);
  const [other, setOther] = useState(!known && value !== "");
  const selectValue = other ? "__other" : value;
  return (
    <div className="wz-field wz-spec">
      <label htmlFor={uid}>{t(`wz.spec.${field}`)}</label>
      {options.length > 0 && (
        <select
          id={uid}
          value={selectValue}
          onChange={(e) => {
            if (e.target.value === "__other") {
              setOther(true);
              onChange("");
            } else {
              setOther(false);
              onChange(e.target.value);
            }
          }}
          data-testid={`wz-spec-${field}`}
        >
          <option value="">{t("wz.spec.unset")}</option>
          {options.map((o) => (
            <option key={o.ar} value={o.ar}>
              {lang === "en" ? o.en : o.ar}
            </option>
          ))}
          <option value="__other">{t("wz.spec.other")}</option>
        </select>
      )}
      {(other || options.length === 0) && (
        <input
          id={options.length === 0 ? uid : undefined}
          aria-label={options.length ? `${t(`wz.spec.${field}`)} - ${t("wz.spec.other")}` : undefined}
          value={value}
          placeholder={t("wz.spec.other_placeholder")}
          onChange={(e) => onChange(e.target.value)}
          data-testid={`wz-spec-${field}-other`}
        />
      )}
    </div>
  );
}

function BrandField({ payload, update, brands, t, error, brandRequest }: { payload: DraftPayload; update: CommonProps["update"]; brands: BrandOption[]; t: (k: string) => string; error: string | null; brandRequest: DraftBrandRequest | null }) {
  const uid = useId();
  const [query, setQuery] = useState("");
  const [userOpen, setOpen] = useState(false);
  // A rejected request needs a new choice: the chooser opens by itself.
  const open = userOpen || brandRequest?.status === "REJECTED";
  const real = brands.filter((b) => !b.is_no_brand);
  const q = query.trim().toLowerCase();
  const matches = q ? real.filter((b) => b.name.toLowerCase().includes(q)).slice(0, 8) : real.slice(0, 8);
  const exact = real.some((b) => b.name.trim().toLowerCase() === q);
  const brand = payload.brand;
  const chosenName =
    brand?.mode === "none" ? t("wz.brand.none") : brand?.mode === "existing" ? (real.find((b) => b.id === brand.brand_id)?.name ?? "…") : brand?.mode === "request" ? brand.name : null;

  const choose = (b: DraftPayload["brand"]) => {
    update((p) => ({ ...p, brand: b }));
    setOpen(false);
    setQuery("");
  };

  return (
    <div className="wz-field" data-testid="wz-brand">
      <label htmlFor={uid}>
        {t("wz.brand")} <span className="wz-req">*</span>
      </label>
      {chosenName && !open ? (
        <div className="wz-chosen">
          <span data-testid="wz-brand-chosen">{fill(t("wz.brand.chosen"), { name: chosenName })}</span>
          <button type="button" className="button-link" onClick={() => setOpen(true)}>{t("wz.brand.change")}</button>
        </div>
      ) : (
        <div className="wz-combo">
          <input
            id={uid}
            role="combobox"
            aria-expanded={q ? "true" : "false"}
            aria-controls={`${uid}-list`}
            aria-autocomplete="list"
            placeholder={t("wz.brand.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="wz-brand-input"
          />
          {q && (
            <ul id={`${uid}-list`} role="listbox" className="wz-combo-list">
              {matches.map((b) => (
                <li key={b.id} role="option" aria-selected={brand?.mode === "existing" && brand.brand_id === b.id}>
                  <button type="button" onClick={() => choose({ mode: "existing", brand_id: b.id })}>{b.name}</button>
                </li>
              ))}
              {!exact && (
                <li role="option" aria-selected={false}>
                  <button type="button" onClick={() => choose({ mode: "request", name: query.trim() })} data-testid="wz-brand-request">
                    {fill(t("wz.brand.request"), { name: query.trim() })}
                  </button>
                </li>
              )}
            </ul>
          )}
          <button type="button" className="button-link wz-brand-none" onClick={() => choose({ mode: "none" })} data-testid="wz-brand-none">
            {t("wz.brand.none")}
          </button>
        </div>
      )}
      {brand?.mode === "request" && (
        <div className={`wz-brand-status wz-brand-status-${(brandRequest?.status ?? "PENDING").toLowerCase()}`} role="status" data-testid="wz-brand-status" data-status={brandRequest?.status ?? "PENDING"}>
          {brandRequest?.status === "APPROVED" ? (
            <p>{fill(t("wz.brand.approved"), { name: brandRequest.name })}</p>
          ) : brandRequest?.status === "REJECTED" ? (
            <>
              <p>{fill(t("wz.brand.rejected"), { name: brandRequest.name, reason: brandRequest.rejection_reason ?? "" })}</p>
              <p>{t("wz.brand.rejected_next")}</p>
            </>
          ) : (
            <>
              <p>{fill(t("wz.brand.request_note"), { name: brand.name })}</p>
              <p><strong>{t("wz.brand.pending")}</strong></p>
            </>
          )}
        </div>
      )}
      <FieldError id={`${uid}-err`} text={error} />
    </div>
  );
}

// ------------------------------------------------------------- step 2: colours and images

export function StepImages({ payload, update, taxonomy, lang, t, showProblems, colorName, vendorId, edit }: CommonProps & { vendorId: string }) {
  const existingColor = (key: string) => !!edit?.existing_colors.includes(key);
  const [busy, setBusy] = useState<Record<string, number>>({});
  /** Phase A++ (item 6): the server-read size of each image uploaded in this visit - advice only. */
  const [advice, setAdvice] = useState<Record<string, ImageAdvice[]>>({});
  const [uploadError, setUploadError] = useState<string | null>(null);
  /** Product colours: a name being typed that would repeat another colour's - held here, never sent. */
  const [typing, setTyping] = useState<Record<string, { ar?: string; en?: string }>>({});
  const chosen = payload.colors ?? [];
  const families = (taxonomy?.colors ?? []).slice().sort((a, b) => a.sort_order - b.sort_order);
  const familyOf = (code: string | null) => families.find((f) => f.code === code) ?? null;
  const familyName = (code: string | null) => {
    const f = familyOf(code);
    return f ? (lang === "en" ? f.name_en || f.name_ar : f.name_ar) : "";
  };
  const full = chosen.length >= MAX_PRODUCT_COLORS;

  /** The quick path: a family adds a colour named after it ("name 2" when the product already has that name). */
  function addColor(family: string) {
    update((p) => {
      const list = p.colors ?? [];
      if (list.length >= MAX_PRODUCT_COLORS) return p;
      const f = familyOf(family);
      const key = nextColorKey(list.map((c) => c.key), family);
      const name_ar = autoColorName(list.map((c) => c.name_ar), f?.name_ar ?? family);
      return { ...p, colors: [...list, { key, family, name_ar, images: [] }] };
    });
  }
  function removeColor(key: string) {
    update((p) => {
      const sizes = { ...(p.sizes ?? {}) };
      delete sizes[key];
      return pruneVersions({ ...p, colors: (p.colors ?? []).filter((c) => c.key !== key), sizes });
    });
    setTyping((x) => {
      const next = { ...x };
      delete next[key];
      return next;
    });
  }
  function moveColor(key: string, d: number) {
    update((p) => {
      const list = (p.colors ?? []).slice();
      const i = list.findIndex((c) => c.key === key);
      const j = i + d;
      if (i < 0 || j < 0 || j >= list.length) return p;
      [list[i], list[j]] = [list[j], list[i]];
      return { ...p, colors: list };
    });
  }
  const patchColor = (key: string, f: (c: DraftColor) => DraftColor) =>
    update((p) => ({ ...p, colors: (p.colors ?? []).map((c) => (c.key === key ? f(c) : c)) }));
  const setImages = (key: string, f: (images: string[]) => string[]) => patchColor(key, (c) => ({ ...c, images: f(c.images) }));
  /** The Arabic name is unique in the product (the server's rule); a clash stays here with a message. */
  const nameTakenBy = (key: string, name: string) =>
    name.trim() ? chosen.find((c) => c.key !== key && normalizeColorName(c.name_ar) === normalizeColorName(name)) ?? null : null;
  function typeNameAr(key: string, value: string) {
    setTyping((x) => ({ ...x, [key]: { ...x[key], ar: value } }));
    if (!nameTakenBy(key, value)) patchColor(key, (c) => ({ ...c, name_ar: value }));
  }
  function setFamily(key: string, family: string) {
    patchColor(key, (c) => {
      // the quick-path name follows the family; a name the seller typed stays
      const wasAuto = !c.family || normalizeColorName(c.name_ar).startsWith(normalizeColorName(familyOf(c.family)?.name_ar ?? "\u0000"));
      const others = chosen.filter((x) => x.key !== key).map((x) => x.name_ar);
      return { ...c, family, name_ar: wasAuto ? autoColorName(others, familyOf(family)?.name_ar ?? family) : c.name_ar };
    });
  }
  /** A HEX very close to another colour's: a warning only. */
  const nearHex = (key: string, hex: string | null | undefined) => {
    if (!hex) return null;
    const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const [r, g, b] = rgb(hex);
    return chosen.find((c) => {
      if (c.key === key || !c.hex) return false;
      const [r2, g2, b2] = rgb(c.hex);
      return Math.hypot(r - r2, g - g2, b - b2) < 24;
    }) ?? null;
  };

  async function upload(key: string, files: FileList | null, onDone: (url: string) => void, room: number) {
    if (!files?.length) return;
    setUploadError(null);
    const list = Array.from(files).slice(0, Math.max(0, room));
    if (list.length < files.length) setUploadError(fill(t("wz.images.limit"), { n: MAX_IMAGES_PER_COLOR }));
    for (const file of list) {
      setBusy((b) => ({ ...b, [key]: (b[key] ?? 0) + 1 }));
      try {
        const { url, width, height } = await uploadVendorImage(vendorId, file);
        setAdvice((a) => ({ ...a, [url]: imageAdvice(width, height) }));
        onDone(url);
      } catch (err) {
        setUploadError(fill(t("wz.images.failed"), { msg: apiErrorMessage(err, lang as "ar" | "en") }));
      } finally {
        setBusy((b) => ({ ...b, [key]: (b[key] ?? 1) - 1 }));
      }
    }
  }
  const addImages = (c: DraftColor, files: FileList | null) =>
    upload(c.key, files, (url) => setImages(c.key, (imgs) => (imgs.length < MAX_IMAGES_PER_COLOR && !imgs.includes(url) ? [...imgs, url] : imgs)), MAX_IMAGES_PER_COLOR - c.images.length);

  const move = (images: string[], i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= images.length) return images;
    const next = images.slice();
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  };

  return (
    <div className="wz-fields">
      <fieldset className="wz-field">
        <legend>{t("wz.pcolors.title")} <span className="wz-pcolors-count">{fill(t("wz.pcolors.count"), { n: chosen.length, max: MAX_PRODUCT_COLORS })}</span></legend>
        <p className="wz-hint">{t("wz.pcolors.note")}</p>
        <div className="wz-chip-row wz-family-row" data-testid="wz-colors">
          {families.map((f) => {
            const n = chosen.filter((x) => x.family === f.code).length;
            const name = lang === "en" ? f.name_en || f.name_ar : f.name_ar;
            return (
              <button
                key={f.code}
                type="button"
                className={`wz-chip${n > 0 ? " wz-chip-has" : ""}`}
                disabled={full}
                onClick={() => addColor(f.code)}
                aria-label={fill(t("wz.pcolors.add_family"), { family: name })}
                data-testid={`wz-color-${f.code}`}
              >
                <span className="wz-swatch" style={{ background: f.hex ?? "transparent" }} aria-hidden="true" />
                {name}
                {n > 0 && <span className="wz-family-n" aria-hidden="true">{n}</span>}
                <span className="wz-family-plus" aria-hidden="true">+</span>
              </button>
            );
          })}
        </div>
        {full && <p className="wz-hint" role="status">{t("wz.pcolors.limit")}</p>}
        {showProblems && chosen.length === 0 && <p className="wz-field-error" role="alert">{t("wz.p.COLOR_REQUIRED")}</p>}
      </fieldset>

      {chosen.length > 0 && <h3 className="wz-sub">{t("wz.images.title")}</h3>}
      {chosen.length > 0 && <p className="wz-hint" data-testid="wz-images-guide">{t("wz.images.guide")}</p>}
      {uploadError && <p className="wz-field-error" role="alert">{uploadError}</p>}
      <ol className="wz-pcolors">
        {chosen.map((c, idx) => {
          const typedAr = typing[c.key]?.ar ?? c.name_ar;
          const taken = nameTakenBy(c.key, typedAr);
          const near = nearHex(c.key, c.hex);
          const fam = familyOf(c.family);
          return (
            <li key={c.key} className="wz-color-card wz-pcolor" aria-label={colorName(c.key)} data-testid={`wz-images-${c.key}`}>
              <div className="wz-pcolor-head">
                <span className="wz-pcolor-swatch" style={{ background: swatchBackground({ swatch_url: c.swatch, hex: c.hex, family_hex: fam?.hex }) }} aria-hidden="true" />
                <div className="wz-pcolor-title">
                  <strong>{colorName(c.key)}</strong>
                  <span className="muted">
                    {familyName(c.family) || t("wz.pcolors.no_family")}
                    {idx === 0 && <span className="wz-pcolor-default"> · {t("wz.pcolors.default")}</span>}
                  </span>
                </div>
                <div className="wz-pcolor-tools">
                  <button type="button" aria-label={fill(t("wz.pcolors.up"), { color: colorName(c.key) })} disabled={idx === 0} onClick={() => moveColor(c.key, -1)} data-testid={`wz-color-up-${c.key}`}>↑</button>
                  <button type="button" aria-label={fill(t("wz.pcolors.down"), { color: colorName(c.key) })} disabled={idx === chosen.length - 1} onClick={() => moveColor(c.key, 1)} data-testid={`wz-color-down-${c.key}`}>↓</button>
                  {!existingColor(c.key) && (
                    <button type="button" className="wz-danger" aria-label={fill(t("wz.pcolors.remove"), { color: colorName(c.key) })} onClick={() => removeColor(c.key)} data-testid={`wz-color-remove-${c.key}`}>✕</button>
                  )}
                </div>
              </div>
              <div className="wz-pcolor-fields">
                <div className="wz-field">
                  <label htmlFor={`pc-ar-${c.key}`}>{t("wz.pcolors.name_ar")} <span className="wz-req">*</span></label>
                  <input
                    id={`pc-ar-${c.key}`}
                    type="text"
                    dir="rtl"
                    maxLength={COLOR_NAME_MAX}
                    value={typedAr}
                    aria-invalid={taken ? true : undefined}
                    aria-describedby={taken ? `pc-ar-err-${c.key}` : undefined}
                    onChange={(e) => typeNameAr(c.key, e.target.value)}
                    data-testid={`wz-color-name-${c.key}`}
                  />
                  {taken && (
                    <p id={`pc-ar-err-${c.key}`} className="wz-field-error" role="alert" data-testid={`wz-color-name-error-${c.key}`}>
                      {fill(t("wz.pcolors.name_taken"), { name: typedAr.trim() })}
                    </p>
                  )}
                  {showProblems && !taken && !c.name_ar.trim() && <p className="wz-field-error" role="alert">{t("wz.p.COLOR_NAME_REQUIRED")}</p>}
                </div>
                <div className="wz-field">
                  <label htmlFor={`pc-en-${c.key}`}>{t("wz.pcolors.name_en")}</label>
                  <input
                    id={`pc-en-${c.key}`}
                    type="text"
                    dir="ltr"
                    maxLength={COLOR_NAME_MAX}
                    value={c.name_en ?? ""}
                    placeholder={c.name_ar}
                    aria-describedby={`pc-en-hint-${c.key}`}
                    onChange={(e) => patchColor(c.key, (x) => ({ ...x, name_en: e.target.value }))}
                    data-testid={`wz-color-name-en-${c.key}`}
                  />
                  <p id={`pc-en-hint-${c.key}`} className="wz-hint">{t("wz.pcolors.name_en_hint")}</p>
                </div>
                <div className="wz-field">
                  <label htmlFor={`pc-fam-${c.key}`}>{t("wz.pcolors.family")}</label>
                  <select id={`pc-fam-${c.key}`} value={c.family ?? ""} disabled={existingColor(c.key)} title={existingColor(c.key) ? t("wz.edit.locked_family") : undefined} onChange={(e) => setFamily(c.key, e.target.value)} data-testid={`wz-color-family-${c.key}`}>
                    {!c.family && <option value="">{t("wz.pcolors.no_family")}</option>}
                    {families.map((f) => (
                      <option key={f.code} value={f.code}>{lang === "en" ? f.name_en || f.name_ar : f.name_ar}</option>
                    ))}
                  </select>
                  {showProblems && !c.family && <p className="wz-field-error" role="alert">{fill(t("wz.p.COLOR_FAMILY_REQUIRED"), { color: colorName(c.key) })}</p>}
                </div>
                <div className="wz-field">
                  <span className="wz-pcolor-label" id={`pc-hex-l-${c.key}`}>{t("wz.pcolors.hex")}</span>
                  <div className="wz-pcolor-hex">
                    <input
                      type="color"
                      aria-labelledby={`pc-hex-l-${c.key}`}
                      value={c.hex ?? fam?.hex ?? "#cccccc"}
                      onChange={(e) => patchColor(c.key, (x) => ({ ...x, hex: e.target.value.toLowerCase() }))}
                      data-testid={`wz-color-hex-${c.key}`}
                    />
                    <span dir="ltr" className="muted">{c.hex ?? "—"}</span>
                    {c.hex && <button type="button" className="button-link" onClick={() => patchColor(c.key, (x) => ({ ...x, hex: null }))}>{t("wz.pcolors.hex_clear")}</button>}
                  </div>
                  {near && <p className="wz-hint wz-pcolor-warn" role="status" data-testid={`wz-color-hex-warn-${c.key}`}>{fill(t("wz.pcolors.hex_close"), { name: near.name_ar })}</p>}
                </div>
                <div className="wz-field">
                  <span className="wz-pcolor-label">{t("wz.pcolors.swatch")}</span>
                  <div className="wz-pcolor-hex">
                    {c.swatch && <span className="wz-pcolor-swatch wz-pcolor-swatch-sm" style={{ background: swatchBackground({ swatch_url: c.swatch }) }} aria-hidden="true" />}
                    <label className="button-link">
                      <input type="file" accept="image/jpeg,image/png,image/webp" className="visually-hidden" onChange={(e) => { void upload(c.key, e.target.files, (url) => patchColor(c.key, (x) => ({ ...x, swatch: url })), 1); e.target.value = ""; }} data-testid={`wz-color-swatch-${c.key}`} />
                      {c.swatch ? t("wz.pcolors.swatch_change") : t("wz.pcolors.swatch_add")}
                    </label>
                    {c.swatch && <button type="button" className="button-link wz-danger" onClick={() => patchColor(c.key, (x) => ({ ...x, swatch: null }))}>{t("wz.pcolors.swatch_remove")}</button>}
                  </div>
                </div>
              </div>
              <div className="wz-color-card-head">
                <span>{t("wz.pcolors.images")}</span>
                <span className="muted">{fill(t("wz.images.count"), { n: c.images.length })}</span>
              </div>
              <ol className="wz-images">
                {c.images.map((url, i) => (
                  <li key={url} className={`wz-image${i === 0 ? " wz-image-main" : ""}`}>
                    {/* The seller's own uploads, served by the API host. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={url} alt={`${colorName(c.key)} ${i + 1}`} />
                    <ImageAdviceBadge advice={advice[url]} t={t} />
                    {i === 0 ? (
                      <span className="wz-image-badge">★ {t("wz.images.main")}</span>
                    ) : (
                      <button type="button" className="wz-image-btn" onClick={() => setImages(c.key, (imgs) => [imgs[i], ...imgs.filter((_, k) => k !== i)])}>★ {t("wz.images.make_main")}</button>
                    )}
                    <div className="wz-image-tools">
                      <button type="button" aria-label={t("wz.images.earlier")} disabled={i === 0} onClick={() => setImages(c.key, (imgs) => move(imgs, i, -1))}>{lang === "en" ? "←" : "→"}</button>
                      <button type="button" aria-label={t("wz.images.later")} disabled={i === c.images.length - 1} onClick={() => setImages(c.key, (imgs) => move(imgs, i, 1))}>{lang === "en" ? "→" : "←"}</button>
                      <button type="button" aria-label={t("wz.images.remove")} onClick={() => setImages(c.key, (imgs) => imgs.filter((_, k) => k !== i))}>✕</button>
                    </div>
                  </li>
                ))}
                {c.images.length < MAX_IMAGES_PER_COLOR && (
                  <li className="wz-image wz-image-add">
                    <label>
                      <input type="file" accept="image/jpeg,image/png,image/webp" multiple className="visually-hidden" onChange={(e) => { void addImages(c, e.target.files); e.target.value = ""; }} data-testid={`wz-upload-${c.key}`} />
                      <span>{busy[c.key] ? fill(t("wz.images.uploading"), { n: busy[c.key] }) : `+ ${t("wz.images.add")}`}</span>
                    </label>
                  </li>
                )}
              </ol>
              {c.images.length === 0 && <p className={showProblems ? "wz-field-error" : "wz-hint"}>{t("wz.images.missing")}</p>}
            </li>
          );
        })}
      </ol>
      {chosen.length > 0 && (
        <SharedImagesEditor
          vendorId={vendorId}
          urls={payload.shared_images ?? []}
          onChange={(f) => update((p) => ({ ...p, shared_images: f(p.shared_images ?? []) }))}
          t={t}
          lang={lang}
          advice={advice}
          onAdvice={(url, a) => setAdvice((x) => ({ ...x, [url]: a }))}
        />
      )}
    </div>
  );
}

/** A coded specification (closed list) or a free one (common choices + «أخرى»). */
function SpecChoice(props: { field: string; value: string; onChange: (v: string) => void; lang: string; t: (k: string) => string }) {
  return isCodedSpec(props.field) ? <CodedSpecField {...props} /> : <SpecField {...props} />;
}

/** Phase A++ (item 4): fit / stretch / occasion - one choice; care - several (closed lists, codes). */
function CodedSpecField({ field, value, onChange, lang, t }: { field: string; value: string; onChange: (v: string) => void; lang: string; t: (k: string) => string }) {
  const uid = useId();
  const list = CODED_SPECS[field];
  const chosen = specCodesOf(field, value);
  const legacy = chosen.filter((x) => !list.some((o) => o.code === x));
  if (MULTI_SPECS.has(field)) {
    return (
      <fieldset className="wz-field wz-spec">
        <legend>{t(`wz.spec.${field}`)}</legend>
        <div className="wz-chip-row">
          {list.map((o) => {
            const on = chosen.includes(o.code);
            return (
              <button key={o.code} type="button" className={`wz-chip${on ? " wz-chip-on" : ""}`} aria-pressed={on}
                onClick={() => onChange((on ? chosen.filter((x) => x !== o.code) : list.filter((x) => x.code === o.code || chosen.includes(x.code)).map((x) => x.code)).join(","))}
                data-testid={`wz-spec-${field}-${o.code}`}>
                {lang === "en" ? o.en : o.ar}
              </button>
            );
          })}
        </div>
      </fieldset>
    );
  }
  return (
    <div className="wz-field wz-spec">
      <label htmlFor={uid}>{t(`wz.spec.${field}`)}</label>
      <select id={uid} value={value} onChange={(e) => onChange(e.target.value)} data-testid={`wz-spec-${field}`}>
        <option value="">{t("wz.spec.unset")}</option>
        {legacy.map((x) => (
          <option key={x} value={x}>{x}</option>
        ))}
        {list.map((o) => (
          <option key={o.code} value={o.code}>{lang === "en" ? o.en : o.ar}</option>
        ))}
      </select>
    </div>
  );
}

// ------------------------------------------------------------- step 3: sizes

/** Phase A++ (item 5): «العارضة» - optional; the size is one of the product's own. */
export function StepModel({ payload, update, taxonomy, t, showProblems }: CommonProps) {
  const order = (code: string) => taxonomy?.sizes.find((x) => x.code === code)?.sort_order ?? 0;
  const sizes = [...draftSizes(payload)]
    .sort((a, b) => order(a) - order(b))
    .map((code) => ({ code, label: taxonomy?.sizes.find((x) => x.code === code)?.label ?? code }));
  if (sizes.length === 0) return null;
  const m = payload.model ?? null;
  // The server's rule decides (offer-presentation.ts); this only words it while typing.
  const problem = !m || (m.height_cm === null && !m.size)
    ? null
    : m.height_cm === null || !m.size
      ? "MODEL_INCOMPLETE"
      : m.height_cm < MODEL_HEIGHT_MIN_CM || m.height_cm > MODEL_HEIGHT_MAX_CM
        ? "MODEL_HEIGHT_RANGE"
        : !sizes.some((s) => s.code === m.size)
          ? "MODEL_SIZE_NOT_IN_PRODUCT"
          : null;
  return (
    <ModelInputs
      value={m}
      onChange={(model) => update((p) => ({ ...p, model }))}
      sizes={sizes}
      t={t}
      error={showProblems && problem ? t(`wz.p.${problem}`) : null}
    />
  );
}

/** The sizes of the chosen system only - one system for the whole product. */
export function StepSizes({ payload, update, taxonomy, t, showProblems, colorName, edit }: CommonProps) {
  const existingVersion = (color: string, size: string) => !!edit?.existing_versions.includes(versionKey(color, size));
  const uid = useId();
  const [query, setQuery] = useState("");
  const colors = payload.colors ?? [];
  const systems = sizeSystemsFor(payload.audience);
  const suggested = suggestedSizeSystem(payload.audience, payload.category);
  const inferred = Object.values(payload.sizes ?? {}).flat().map(sizeSystemOf)[0];
  const chosen = payload.size_system ?? inferred ?? null;
  const system: SizeSystem = chosen && systems.includes(chosen) ? chosen : suggested;
  const all = (taxonomy?.sizes ?? []).filter((s) => sizeSystemOf(s.code) === system).sort((a, b) => a.sort_order - b.sort_order);
  const q = query.trim().toLowerCase();
  const shown = q ? all.filter((s) => s.label.toLowerCase().includes(q) || s.code.toLowerCase().includes(q)) : all;

  function chooseSystem(next: SizeSystem) {
    if (next === system && payload.size_system === next) return;
    const hasSizes = Object.values(payload.sizes ?? {}).some((l) => l.some((code) => sizeSystemOf(code) !== next));
    if (hasSizes && !window.confirm(t(measurementsEmpty(payload.measurements) ? "wz.size_system.change_confirm" : "wz.size_system.change_confirm_measures"))) return;
    update((p) =>
      pruneVersions({
        ...p,
        size_system: next,
        sizes: Object.fromEntries(
          (p.colors ?? []).map((c) => [c.key, next === "ONE_SIZE" ? ["ONE_SIZE"] : (p.sizes?.[c.key] ?? []).filter((code) => sizeSystemOf(code) === next)]),
        ),
      }),
    );
  }
  const setSizes = (color: string, f: (list: string[]) => string[]) =>
    update((p) => pruneVersions({ ...p, size_system: system, sizes: { ...(p.sizes ?? {}), [color]: f(p.sizes?.[color] ?? []) } }));

  if (colors.length === 0) return <p className="wz-hint" data-testid="wz-sizes-colors-first">{t("wz.sizes.colors_first")}</p>;

  return (
    <div className="wz-fields">
      <fieldset className="wz-field">
        <legend>{t("wz.size_system")}</legend>
        <p className="wz-hint">{t("wz.size_system.note")}</p>
        <div className="wz-choice-row" role="radiogroup" data-testid="wz-size-system">
          {systems.map((sys) => (
            <label key={sys} className={`wz-choice${system === sys ? " wz-choice-on" : ""}`} data-testid={`wz-size-system-${sys}`}>
              <input type="radio" name={`${uid}-system`} checked={system === sys} disabled={!!edit} onChange={() => chooseSystem(sys)} />
              {t(`wz.size_system.${sys}`)}
              {sys === suggested && <span className="wz-badge">{t("wz.size_system.suggested")}</span>}
            </label>
          ))}
        </div>
      </fieldset>

      {all.length > 8 && (
        <div className="wz-field wz-search">
          <label htmlFor={`${uid}-q`}>{t("wz.sizes.search")}</label>
          <input id={`${uid}-q`} type="search" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="wz-size-search" />
        </div>
      )}

      {colors.map((c, i) => {
        const picked = payload.sizes?.[c.key] ?? [];
        return (
          <fieldset key={c.key} className="wz-field wz-size-set" data-testid={`wz-sizes-${c.key}`}>
            <legend>{fill(t("wz.sizes.for"), { color: colorName(c.key) })}</legend>
            {system === "ONE_SIZE" ? (
              <p className="wz-hint">{t("wz.size_system.ONE_SIZE")}</p>
            ) : (
              <div className="wz-chip-row">
                {shown.map((s) => {
                  const on = picked.includes(s.code);
                  const locked = on && existingVersion(c.key, s.code);
                  return (
                    <button key={s.code} type="button" className={`wz-chip${on ? " wz-chip-on" : ""}${locked ? " wz-chip-locked" : ""}`} aria-pressed={on} disabled={locked} title={locked ? t("wz.edit.existing_size") : undefined} onClick={() => setSizes(c.key, (l) => (on ? l.filter((x) => x !== s.code) : [...l, s.code]))} data-testid={`wz-size-${c.key}-${s.code}`}>
                      {s.label}
                    </button>
                  );
                })}
              </div>
            )}
            {i > 0 && system !== "ONE_SIZE" && (payload.sizes?.[colors[0].key] ?? []).length > 0 && (
              <div className="wz-mini-actions">
                <button type="button" className="button-link" onClick={() => setSizes(c.key, (l) => [...new Set([...(edit ? l.filter((x) => existingVersion(c.key, x)) : []), ...(payload.sizes?.[colors[0].key] ?? [])])])} data-testid={`wz-sizes-copy-${c.key}`}>
                  {fill(t("wz.sizes.copy_from"), { color: colorName(colors[0].key) })}
                </button>
              </div>
            )}
            {showProblems && picked.length === 0 && <p className="wz-field-error" role="alert">{fill(t("wz.p.COLOR_SIZE_REQUIRED"), { color: colorName(c.key) })}</p>}
          </fieldset>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------- step 3: measurements

/**
 * The product's own measurements table (cm, the garment itself): optional.
 * The seller first chooses the measurements that matter for this piece
 * (nothing is pre-chosen - a dress might be chest, waist and length); each
 * chosen one becomes a column whose value every size of the product needs.
 * Deleting a size or changing the size system removes its row
 * (pruneVersions) - inside the existing confirmation.
 */
export function StepMeasurements({ payload, update, taxonomy, t, showProblems }: CommonProps) {
  const uid = useId();
  const allowed = measureKeysFor(payload.category, payload.audience);
  const order = (code: string) => taxonomy?.sizes.find((x) => x.code === code)?.sort_order ?? 0;
  const sizes = [...draftSizes(payload)].sort((a, b) => order(a) - order(b));
  const sizeLabel = (code: string) => taxonomy?.sizes.find((x) => x.code === code)?.label ?? code;
  const m = payload.measurements ?? null;
  const keys = allowed.filter((k) => (m?.keys ?? []).includes(k));
  /** What is being typed in a cell (a value like «90.» is kept as typed until it is a number). */
  const [typing, setTyping] = useState<Record<string, string>>({});
  const missing = missingMeasurements(payload);

  if (!payload.category || allowed.length === 0) {
    return (
      <section className="wz-field wz-measure" aria-labelledby={`${uid}-h`} data-testid="wz-measure">
        <h3 id={`${uid}-h`} className="wz-subhead">{t("wz.measure")}</h3>
        <p className="wz-hint">{t("wz.measure.none")}</p>
      </section>
    );
  }

  const setKeys = (next: MeasureKey[]) =>
    update((p) => {
      if (next.length === 0) return { ...p, measurements: null };
      const cur = p.measurements ?? { keys: [], values: {} };
      const values = Object.fromEntries(
        Object.entries(cur.values).map(([size, row]) => [size, Object.fromEntries(Object.entries(row).filter(([k]) => next.includes(k as MeasureKey)))]),
      );
      return { ...p, measurements: { keys: next, values } };
    });
  const setCell = (size: string, key: MeasureKey, raw: string) => {
    const cell = `${size}|${key}`;
    setTyping((x) => ({ ...x, [cell]: raw }));
    const text = raw.replace(",", ".").trim();
    const value = text === "" ? null : Number(text);
    if (value !== null && (!Number.isFinite(value) || !/^\d+(\.\d)?$/.test(text))) return;
    update((p) => {
      const cur = p.measurements ?? { keys, values: {} };
      const row = { ...(cur.values[size] ?? {}) };
      if (value === null) delete row[key];
      else row[key] = value;
      return { ...p, measurements: { keys: cur.keys, values: { ...cur.values, [size]: row } } };
    });
  };

  return (
    <section className="wz-field wz-measure" aria-labelledby={`${uid}-h`} data-testid="wz-measure">
      <h3 id={`${uid}-h`} className="wz-subhead">
        {t("wz.measure")} <span className="wz-opt">({t("wz.optional")})</span>
      </h3>
      <p className="wz-hint">{t("wz.measure.note")}</p>
      {sizes.length === 0 ? (
        <p className="wz-hint" data-testid="wz-measure-sizes-first">{t("wz.measure.sizes_first")}</p>
      ) : (
        <>
          <fieldset className="wz-measure-keys">
            <legend className="wz-hint">{t("wz.measure.keys")}</legend>
            <div className="wz-chip-row">
              {allowed.map((k) => {
                const on = keys.includes(k);
                return (
                  <button
                    key={k}
                    type="button"
                    className={`wz-chip${on ? " wz-chip-on" : ""}`}
                    aria-pressed={on}
                    onClick={() => setKeys(on ? keys.filter((x) => x !== k) : allowed.filter((x) => x === k || keys.includes(x)))}
                    data-testid={`wz-measure-key-${k}`}
                  >
                    {t(`wz.key.${k}`)}
                  </button>
                );
              })}
            </div>
          </fieldset>
          {keys.length === 0 ? (
            <p className="wz-hint" data-testid="wz-measure-choose">{t("wz.measure.choose_first")}</p>
          ) : (
          <div className="wz-grid-wrap">
            <table className="wz-grid wz-measure-grid" data-testid="wz-measure-grid">
              <thead>
                <tr>
                  <th scope="col">{t("wz.measure.size")}</th>
                  {keys.map((k) => (
                    <th key={k} scope="col" title={fill(t("wz.measure.range"), { min: MEASURE_LIMITS_CM[k][0], max: MEASURE_LIMITS_CM[k][1] })}>
                      {t(`wz.key.${k}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sizes.map((size) => (
                  <tr key={size}>
                    <th scope="row">{sizeLabel(size)}</th>
                    {keys.map((k) => {
                      const cell = `${size}|${k}`;
                      const v = m?.values[size]?.[k];
                      const shown = typing[cell] ?? (typeof v === "number" ? String(v) : "");
                      const [lo, hi] = MEASURE_LIMITS_CM[k];
                      const bad = typeof v === "number" && (v < lo || v > hi);
                      const empty = showProblems && missing.some((x) => x.size === size && x.key === k);
                      return (
                        <td key={k} data-state={bad || empty ? "error" : typeof v === "number" ? "filled" : "empty"}>
                          <input
                            type="text"
                            inputMode="decimal"
                            dir="ltr"
                            className="wz-cell-input"
                            aria-label={fill(t("wz.measure.cell"), { key: t(`wz.key.${k}`), size: sizeLabel(size) })}
                            aria-invalid={bad || empty || undefined}
                            value={shown}
                            onChange={(e) => setCell(size, k, e.target.value)}
                            onBlur={() => setTyping((x) => {
                              const n = { ...x };
                              delete n[cell];
                              return n;
                            })}
                            data-testid={`wz-measure-${size}-${k}`}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
          <div className="wz-mini-actions">
            {missing.length > 0 && <span className={showProblems ? "wz-field-error" : "wz-hint"} data-testid="wz-measure-missing">{fill(t("wz.measure.missing"), { n: missing.length })}</span>}
            {!measurementsEmpty(m) && (
              <button
                type="button"
                className="button-link wz-danger"
                onClick={() => {
                  if (window.confirm(t("wz.measure.clear_confirm"))) update((p) => ({ ...p, measurements: null }));
                }}
                data-testid="wz-measure-clear"
              >
                {t("wz.measure.clear")}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------- step 4: stock and price

type CellState = "unsaved" | "saving" | "saved" | "stored" | "error";

/**
 * Stock as ONE grid per branch: a row per colour (its main image and name),
 * a column per size of the product; a size the colour does not come in is a
 * disabled «—». Tab moves cell to cell, Enter saves and goes down, the
 * arrows move between cells. Each cell shows whether the server has its
 * value; one line says the state of all of them. Quick fill per row, per
 * column or everything; row and column totals. SKUs are internal and
 * generated (never a field for the seller).
 */
export function StepStock({
  payload, update, taxonomy, lang, t, showProblems, colorName, branches, confirmed, saveState, onRetry, saveNow, copyStock, edit,
}: CommonProps & {
  branches: BranchOption[] | null;
  confirmed: DraftPayload | null;
  saveState: SaveState;
  onRetry: () => void;
  saveNow: () => Promise<boolean>;
  copyStock?: (from: string, to: string) => Promise<{ ok: true } | { ok: false; error: unknown }>;
}) {
  const uid = useId();
  const list = branches ?? [];
  const [branchPick, setBranch] = useState<string | null>(null);
  const branchId = branchPick && list.some((b) => b.id === branchPick) ? branchPick : (list[0]?.id ?? null);
  const branch = list.find((b) => b.id === branchId) ?? null;
  const [fillValue, setFillValue] = useState("");
  /** Phase A++ (item 2): «نسخ من فرع…» - the source, a pending overwrite question, the outcome. */
  const [copyFrom, setCopyFrom] = useState("");
  const [copyAsk, setCopyAsk] = useState(false);
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyMsg, setCopyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const order = (code: string) => taxonomy?.sizes.find((x) => x.code === code)?.sort_order ?? 0;
  const sizeLabel = (code: string) => taxonomy?.sizes.find((x) => x.code === code)?.label ?? code;
  const colors = (payload.colors ?? []).filter((c) => (payload.sizes?.[c.key] ?? []).length > 0);
  const columns = [...draftSizes(payload)].sort((a, b) => order(a) - order(b));
  const branchIds = list.map((b) => b.id);
  const qty = (v: string) => Math.max(0, Math.min(100000, Math.floor(Number(v.replace(/[^\d]/g, "")) || 0)));
  const rtl = lang !== "en";
  const has = (color: string, size: string) => (payload.sizes?.[color] ?? []).includes(size);
  /** Edit drafts: an existing version's stock is changed on the stock screen only. */
  const existingVersion = (color: string, size: string) => !!edit?.existing_versions.includes(versionKey(color, size));
  const at = (color: string, size: string) => (branchId ? stockFor(payload, color, size, branchId) : 0);

  const cellState = (color: string, size: string): CellState => {
    if (!branchId) return "unsaved";
    const mine = stockFor(payload, color, size, branchId);
    const server = confirmed ? stockFor(confirmed, color, size, branchId) : null;
    if (server === mine) return saveState.kind === "saved" && saveState.justNow ? "saved" : "stored";
    if (saveState.kind === "saving") return "saving";
    if (saveState.kind === "error") return "error";
    return "unsaved";
  };
  const states = colors.flatMap((c) => columns.filter((s) => has(c.key, s)).map((s) => cellState(c.key, s)));
  const overall: "saved" | "saving" | "unsaved" | "error" = states.includes("error")
    ? "error"
    : states.includes("saving")
      ? "saving"
      : states.includes("unsaved")
        ? "unsaved"
        : "saved";

  const set = (changes: { color: string; size: string }[], q: number) => {
    const open = changes.filter((c) => !existingVersion(c.color, c.size));
    if (!branchId || open.length === 0) return;
    update((p) => withQuantities(p, branchIds, open.map((c) => ({ ...c, branchId, q }))));
  };
  const fillQ = fillValue.trim() === "" ? null : qty(fillValue);
  const cellId = (r: number, c: number) => `${uid}-cell-${r}-${c}`;
  /** Moves to the nearest cell that exists in that direction (a «—» is skipped). */
  function move(r: number, c: number, dr: number, dc: number) {
    let nr = r + dr;
    let nc = c + dc;
    while (nr >= 0 && nr < colors.length && nc >= 0 && nc < columns.length) {
      if (has(colors[nr].key, columns[nc]) && !existingVersion(colors[nr].key, columns[nc])) {
        const el = document.getElementById(cellId(nr, nc)) as HTMLInputElement | null;
        el?.focus();
        el?.select();
        return;
      }
      nr += dr;
      nc += dc;
    }
  }
  function onCellKey(e: React.KeyboardEvent<HTMLInputElement>, r: number, c: number) {
    const forward = rtl ? "ArrowLeft" : "ArrowRight";
    const backward = rtl ? "ArrowRight" : "ArrowLeft";
    if (e.key === "Enter") {
      e.preventDefault();
      void saveNow();
      move(r, c, 1, 0);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      move(r, c, 1, 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(r, c, -1, 0);
    } else if (e.key === forward) {
      e.preventDefault();
      move(r, c, 0, 1);
    } else if (e.key === backward) {
      e.preventDefault();
      move(r, c, 0, -1);
    }
  }
  const others = list.filter((b) => b.id !== branchId);
  const copySource = others.some((b) => b.id === copyFrom) ? copyFrom : (others[0]?.id ?? "");
  const targetHasStock = colors.some((c) => columns.some((s) => has(c.key, s) && at(c.key, s) > 0));
  async function runCopy() {
    if (!copyStock || !branchId || !copySource) return;
    setCopyAsk(false);
    setCopyBusy(true);
    setCopyMsg(null);
    const res = await copyStock(copySource, branchId);
    setCopyBusy(false);
    setCopyMsg(res.ok ? { ok: true, text: t("wz.copystock.done") } : { ok: false, text: `${t("wz.copystock.failed")} ${apiErrorMessage(res.error, lang === "en" ? "en" : "ar")}` });
  }

  return (
    <div className="wz-fields">
      <div className="wz-field">
        <label htmlFor={`${uid}-price`}>
          {t("wz.price.one")} <span className="wz-req">*</span>
        </label>
        <input id={`${uid}-price`} type="number" inputMode="decimal" min={0} step="0.5" value={payload.price ?? ""} aria-describedby={`${uid}-price-ex`}
          onChange={(e) => update((p) => ({ ...p, price: e.target.value === "" ? null : Math.max(0, Number(e.target.value)) || null }))} data-testid="wz-price" />
        <p id={`${uid}-price-ex`} className="wz-hint">{t("wz.price.one_note")}</p>
        {showProblems && !payload.price && <p className="wz-field-error" role="alert">{t("wz.p.PRICE_REQUIRED")}</p>}
      </div>
      <DiscountFields
        price={payload.price ?? null}
        value={payload.discount ?? null}
        onChange={(discount) => update((p) => ({ ...p, discount }))}
        t={t}
        error={showProblems ? (() => {
          const code = discountProblem(payload.price, payload.discount);
          return code ? t(`wz.p.DISCOUNT.${code}`) : null;
        })() : null}
      />

      {colors.length === 0 ? (
        <p className="wz-hint" data-testid="wz-stock-sizes-first">{t("wz.stock.sizes_first")}</p>
      ) : list.length === 0 ? (
        <p className="wz-hint">{t("wz.no_branches")}</p>
      ) : (
        <>
          {list.length > 1 && (
            <div className="wz-branch-tabs" role="tablist" aria-label={t("wz.stock.branch")} data-testid="wz-branch-tabs">
              {list.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  role="tab"
                  id={`${uid}-tab-${b.id}`}
                  aria-selected={b.id === branchId}
                  aria-controls={`${uid}-panel`}
                  tabIndex={b.id === branchId ? 0 : -1}
                  className={`wz-branch-tab${b.id === branchId ? " wz-branch-tab-on" : ""}`}
                  onClick={() => {
                    void saveNow();
                    setBranch(b.id);
                    setCopyAsk(false);
                    setCopyMsg(null);
                  }}
                  data-testid={`wz-branch-${b.id}`}
                >
                  {b.name}
                </button>
              ))}
            </div>
          )}

          <div role={list.length > 1 ? "tabpanel" : undefined} id={`${uid}-panel`} aria-labelledby={list.length > 1 && branchId ? `${uid}-tab-${branchId}` : undefined}>
            <div className="wz-grid-tools">
              <p className={`wz-grid-state wz-grid-state-${overall}`} role="status" aria-live="polite" data-testid="wz-grid-state" data-state={overall}>
                {overall === "saved" ? "✓ " : overall === "error" ? "⚠ " : ""}
                {t(`wz.grid.state.${overall}`)}
                {overall === "error" && (
                  <>
                    {" "}
                    <button type="button" className="button-link" onClick={onRetry} data-testid="wz-grid-retry">{t("wz.save.retry")}</button>
                  </>
                )}
              </p>
              <div className="wz-grid-fill" role="group" aria-label={t("wz.grid.fill")}>
                <label htmlFor={`${uid}-fill`}>{t("wz.grid.fill_value")}</label>
                <input id={`${uid}-fill`} type="text" inputMode="numeric" dir="ltr" className="wz-cell-input" value={fillValue} onChange={(e) => setFillValue(e.target.value.replace(/[^\d]/g, ""))} data-testid="wz-grid-fill-value" />
                <button
                  type="button"
                  className="button-link"
                  disabled={fillQ === null}
                  onClick={() => set(colors.flatMap((c) => columns.filter((s) => has(c.key, s)).map((s) => ({ color: c.key, size: s }))), fillQ ?? 0)}
                  data-testid="wz-grid-fill-all"
                >
                  {t("wz.grid.fill_all")}
                </button>
              </div>
            </div>
            {edit && (
              <p className="wz-hint wz-edit-locked" data-testid="wz-edit-stock-hint">{t("wz.edit.stock_existing_hint")}</p>
            )}
            {copyStock && !edit && others.length > 0 && (
              <div className="wz-copystock" role="group" aria-label={t("wz.copystock.title")} data-testid="wz-copystock">
                <label htmlFor={`${uid}-copyfrom`}>{fill(t("wz.copystock.label"), { branch: branch?.name ?? "" })}</label>
                <select id={`${uid}-copyfrom`} value={copySource} disabled={copyBusy} onChange={(e) => { setCopyFrom(e.target.value); setCopyAsk(false); }} data-testid="wz-copystock-from">
                  {others.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="button-link"
                  disabled={copyBusy || !copySource}
                  onClick={() => (targetHasStock ? setCopyAsk(true) : void runCopy())}
                  data-testid="wz-copystock-run"
                >
                  {copyBusy ? t("wz.copystock.busy") : t("wz.copystock.run")}
                </button>
                {copyAsk && (
                  <p className="wz-copystock-ask" role="alert" data-testid="wz-copystock-ask">
                    {fill(t("wz.copystock.overwrite"), { branch: branch?.name ?? "" })}{" "}
                    <button type="button" className="button" onClick={() => void runCopy()} data-testid="wz-copystock-confirm">{t("wz.copystock.confirm")}</button>{" "}
                    <button type="button" className="button-link" onClick={() => setCopyAsk(false)} data-testid="wz-copystock-cancel">{t("ws.confirm.cancel")}</button>
                  </p>
                )}
                {copyMsg && (
                  <p className={copyMsg.ok ? "wz-copystock-done" : "error-text"} role={copyMsg.ok ? "status" : "alert"} data-testid={copyMsg.ok ? "wz-copystock-done" : "wz-copystock-error"}>
                    {copyMsg.text}
                  </p>
                )}
              </div>
            )}
            <p className="wz-hint" id={`${uid}-keys`}>{t("wz.grid.keys")}</p>
            <div className="wz-grid-wrap" data-testid="wz-grid-wrap">
              <table className="wz-grid wz-stock-grid" data-testid="wz-stock-grid" aria-describedby={`${uid}-keys`}>
                <caption className="visually-hidden">{fill(t("wz.grid.caption"), { branch: branch?.name ?? "" })}</caption>
                <thead>
                  <tr>
                    <th scope="col" className="wz-grid-colorhead">{t("wz.grid.color")}</th>
                    {columns.map((size) => (
                      <th key={size} scope="col">
                        <span>{sizeLabel(size)}</span>
                        <button
                          type="button"
                          className="wz-grid-fill-btn"
                          disabled={fillQ === null}
                          aria-label={fill(t("wz.grid.fill_col"), { size: sizeLabel(size) })}
                          title={fill(t("wz.grid.fill_col"), { size: sizeLabel(size) })}
                          onClick={() => set(colors.filter((c) => has(c.key, size)).map((c) => ({ color: c.key, size })), fillQ ?? 0)}
                          data-testid={`wz-grid-fill-col-${size}`}
                        >
                          ⤓
                        </button>
                      </th>
                    ))}
                    <th scope="col">{t("wz.grid.total")}</th>
                  </tr>
                </thead>
                <tbody>
                  {colors.map((c, r) => {
                    const rowTotal = columns.reduce((n, s) => n + (has(c.key, s) ? at(c.key, s) : 0), 0);
                    return (
                      <tr key={c.key} data-testid={`wz-grid-row-${c.key}`}>
                        <th scope="row" className="wz-grid-colorcell">
                          <span className="wz-grid-color">
                            {c.images[0] ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={c.images[0]} alt="" className="wz-stock-thumb" />
                            ) : (
                              <span className="wz-stock-thumb wz-stock-thumb-empty" aria-hidden="true" />
                            )}
                            <span className="wz-grid-swatch" style={{ background: swatchBackground({ swatch_url: c.swatch, hex: c.hex, family_hex: taxonomy?.colors.find((f) => f.code === c.family)?.hex }) }} aria-hidden="true" />
                            <span>{colorName(c.key)}</span>
                            <button
                              type="button"
                              className="wz-grid-fill-btn"
                              disabled={fillQ === null}
                              aria-label={fill(t("wz.grid.fill_row"), { color: colorName(c.key) })}
                              title={fill(t("wz.grid.fill_row"), { color: colorName(c.key) })}
                              onClick={() => set(columns.filter((s) => has(c.key, s)).map((s) => ({ color: c.key, size: s })), fillQ ?? 0)}
                              data-testid={`wz-grid-fill-row-${c.key}`}
                            >
                              {rtl ? "⇠" : "⇢"}
                            </button>
                          </span>
                        </th>
                        {columns.map((size, col) => {
                          if (!has(c.key, size)) {
                            return (
                              <td key={size} className="wz-grid-na" data-testid={`wz-cell-${c.key}-${size}`} data-state="na">
                                <span aria-hidden="true">—</span>
                                <span className="visually-hidden">{t("wz.grid.na")}</span>
                              </td>
                            );
                          }
                          if (existingVersion(c.key, size)) {
                            return (
                              <td key={size} className="wz-grid-locked" data-testid={`wz-cell-${c.key}-${size}`} data-state="existing">
                                <span>{t("wz.edit.stock_existing")}</span>
                              </td>
                            );
                          }
                          const st = cellState(c.key, size);
                          const v = at(c.key, size);
                          return (
                            <td key={size} data-testid={`wz-cell-${c.key}-${size}`} data-state={st}>
                              <input
                                id={cellId(r, col)}
                                type="text"
                                inputMode="numeric"
                                dir="ltr"
                                className="wz-cell-input"
                                aria-label={fill(t("wz.grid.cell"), { color: colorName(c.key), size: sizeLabel(size), branch: branch?.name ?? "" })}
                                aria-invalid={st === "error" || undefined}
                                value={v === 0 ? "" : String(v)}
                                readOnly={copyBusy}
                                placeholder="0"
                                onChange={(e) => set([{ color: c.key, size }], qty(e.target.value))}
                                onBlur={() => void saveNow()}
                                onKeyDown={(e) => onCellKey(e, r, col)}
                                onFocus={(e) => e.currentTarget.select()}
                                data-testid={`wz-qty-${c.key}-${size}`}
                              />
                              <span className={`wz-cell-mark wz-cell-mark-${st}`} aria-hidden="true">
                                {st === "saved" || st === "stored" ? "✓" : st === "error" ? "⚠" : st === "saving" ? "…" : "•"}
                              </span>
                            </td>
                          );
                        })}
                        <td className="wz-grid-total" data-testid={`wz-row-total-${c.key}`}>{rowTotal}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row" className="wz-grid-colorcell">{t("wz.grid.total")}</th>
                    {columns.map((size) => (
                      <td key={size} className="wz-grid-total" data-testid={`wz-col-total-${size}`}>
                        {colors.reduce((n, c) => n + (has(c.key, size) ? at(c.key, size) : 0), 0)}
                      </td>
                    ))}
                    <td className="wz-grid-total" data-testid="wz-grid-total">
                      {colors.reduce((n, c) => n + columns.reduce((m, s) => m + (has(c.key, s) ? at(c.key, s) : 0), 0), 0)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {showProblems && !edit && colors.length > 0 && colors.every((c) => columns.every((s) => !has(c.key, s) || at(c.key, s) === 0)) && (
              <p className="wz-hint">{t("wz.p.STOCK_REQUIRED")}</p>
            )}
          </div>

        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------- step 5: review and publish

export function StepReview({
  payload, update, taxonomy, lang, t, colorName, brands, branches, versions, problems, hints, checking, problemText, goToProblem, barcodeSlot,
}: CommonProps & {
  /** «باركود المنتج للمحل»: shown right under the price */
  barcodeSlot?: ReactNode;
  brands: BrandOption[];
  branches: BranchOption[];
  versions: { color: string; size: string }[];
  /** What still prevents publishing (the server's publish check once it answered). */
  problems: DraftProblem[];
  /** Suggestions that never block (a measurements table). */
  hints: DraftProblem[];
  checking: boolean;
  problemText: (code: string) => string;
  goToProblem: (p: DraftProblem) => void;
}) {
  const uid = useId();
  const category = taxonomy?.categories.find((c) => c.code === payload.category);
  const brand = payload.brand;
  const brandName =
    brand?.mode === "none" ? t("wz.brand.none") : brand?.mode === "existing" ? (brands.find((b) => b.id === brand.brand_id)?.name ?? "—") : brand?.mode === "request" ? `${brand.name} (${t("wz.brand.request").split(":")[0]})` : "—";
  const totals = branches.map((b) => ({ name: b.name, n: versions.reduce((sum, v) => sum + stockFor(payload, v.color, v.size, b.id), 0) }));
  const specs = Object.entries(payload.specs ?? {});
  const m = payload.measurements;

  return (
    <div className="wz-fields">
      {problems.length > 0 ? (
        <div className="wz-missing" data-testid="wz-missing">
          <strong>{t("wz.missing.title")}</strong>
          <ul>
            {problems.map((p) => (
              <li key={p.code} data-code={p.code}>
                {problemText(p.code)}{" "}
                <button type="button" className="button-link" onClick={() => goToProblem(p)} data-testid={`wz-go-${p.step}`}>{t("wz.missing.go")}</button>
              </li>
            ))}
          </ul>
          <p className="wz-hint">{t("wz.publish.disabled_hint")}</p>
        </div>
      ) : (
        <p className="wz-ready" role="status" data-testid="wz-ready">{checking ? t("wz.publish.checking") : `✓ ${t("wz.publish.ready")}`}</p>
      )}
      {hints.map((h) => (
        <p key={h.code} className="wz-gentle-hint" data-testid={`wz-hint-${h.code}`}>
          {t(`wz.hint.${h.code}`)}{" "}
          <button type="button" className="button-link" onClick={() => goToProblem(h)}>{t("wz.hint.add")}</button>
        </p>
      ))}

      <div className="wz-field">
        <label htmlFor={`${uid}-dar`}>{t("wz.desc_ar")} <span className="wz-opt">({t("wz.optional")})</span></label>
        <textarea id={`${uid}-dar`} dir="rtl" rows={3} value={payload.description_ar ?? ""} onChange={(e) => update((p) => ({ ...p, description_ar: e.target.value }))} aria-describedby={`${uid}-dex`} data-testid="wz-desc-ar" />
        <p id={`${uid}-dex`} className="wz-hint">{t("wz.desc.example")}</p>
      </div>
      <div className="wz-field">
        <label htmlFor={`${uid}-den`}>{t("wz.desc_en")} <span className="wz-opt">({t("wz.optional")})</span></label>
        <textarea id={`${uid}-den`} dir="ltr" rows={3} value={payload.description_en ?? ""} onChange={(e) => update((p) => ({ ...p, description_en: e.target.value }))} />
      </div>

      <section className="wz-summary" aria-labelledby={`${uid}-sum`} data-testid="wz-summary">
        <h3 id={`${uid}-sum`}>{t("wz.summary")}</h3>
        <dl>
          <dt>{t("wz.summary.audience_category")}</dt>
          <dd>{payload.audience ? t(`wz.audience.${payload.audience}`) : "—"} · {category ? (lang === "en" ? category.name_en || category.name_ar : category.name_ar) : "—"}</dd>
          <dt>{t("wz.summary.brand")}</dt>
          <dd>{brandName}</dd>
          <dt>{t("wz.summary.specs")}</dt>
          <dd>{specs.length ? specs.map(([k, v]) => `${t(`wz.spec.${k}`)}: ${v}`).join(" · ") : "—"}</dd>
          {(payload.composition || payload.country_of_origin) && (
            <>
              <dt>{t("wz.summary.composition")}</dt>
              <dd data-testid="wz-summary-composition">
                {[
                  ...(payload.composition?.parts ?? []).map((p) => `${t(`wz.part.${p.part}`)}: ${partText(p, lang as Lang)}`),
                  ...(payload.country_of_origin ? [`${t("comp.origin_line")}: ${countryName(payload.country_of_origin, lang as Lang)}`] : []),
                ].join(" · ")}
              </dd>
            </>
          )}
          <dt>{t("wz.summary.colors")}</dt>
          <dd>{(payload.colors ?? []).map((c) => `${colorName(c.key)} (${fill(t("wz.images.count"), { n: c.images.length })})`).join(" · ") || "—"}</dd>
          <dt>{t("wz.summary.versions")}</dt>
          <dd data-testid="wz-summary-versions">{versions.length}</dd>
          <dt>{t("wz.summary.measure")}</dt>
          <dd data-testid="wz-summary-measure">
            {measurementsEmpty(m) ? t("wz.summary.measure_none") : fill(t("wz.summary.measure_sizes"), { n: draftSizes(payload).length, k: m!.keys.length })}
          </dd>
          <dt>{t("wz.summary.price")}</dt>
          <dd data-testid="wz-summary-price">
            {payload.price ? `${payload.price} ₪` : "—"}
            {payload.price && payload.discount?.mode === "sale" && payload.discount.sale_price !== null
              ? ` - ${fill(t("discount.summary.sale"), { to: payload.discount.sale_price })}`
              : payload.price && payload.discount?.mode === "window" && payload.discount.percent !== null
                ? ` - ${fill(t("discount.summary.window"), { pct: payload.discount.percent, from: payload.discount.start_at ? new Date(payload.discount.start_at).toLocaleString(lang === "en" ? "en-GB" : "ar") : "—", to: payload.discount.end_at ? new Date(payload.discount.end_at).toLocaleString(lang === "en" ? "en-GB" : "ar") : "—" })}`
                : ""}
          </dd>
        </dl>
        {barcodeSlot}
        <dl>
          <dt>{t("wz.summary.stock")}</dt>
          <dd data-testid="wz-summary-stock">{totals.map((x) => `${x.name}: ${x.n}`).join(" · ") || "—"}</dd>
        </dl>
      </section>
    </div>
  );
}
