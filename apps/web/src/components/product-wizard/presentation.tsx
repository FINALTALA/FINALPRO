"use client";

import { useId, useState } from "react";
import { uploadVendorImage } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiErrors";
import "@/lib/offerWizardText";

/**
 * Phase A++ (items 5 and 6): the model information, the images shared by
 * every colour, and the image-size advice - one set of controls used by
 * the wizard (steps 2 and 3) and by the product page's own card. The rules
 * themselves live on the server (offer-presentation.ts); these controls
 * only collect the values and show the server's problems.
 */

export const MAX_SHARED_IMAGES = 6;
export const MODEL_HEIGHT_MIN_CM = 100;
export const MODEL_HEIGHT_MAX_CM = 220;

export interface ModelValue {
  height_cm: number | null;
  size: string | null;
}

/** The recommended image: 3:4 (portrait), at least 900 x 1200. Advice only - never refused. */
export type ImageAdvice = "small" | "ratio";
export function imageAdvice(width: number | null | undefined, height: number | null | undefined): ImageAdvice[] {
  if (!width || !height) return [];
  const out: ImageAdvice[] = [];
  if (Math.min(width, height) < 900 || Math.max(width, height) < 1200) out.push("small");
  if (Math.abs(width / height - 3 / 4) > 0.1) out.push("ratio");
  return out;
}

/** «١٧٠» / «170 سم» -> 170; anything else -> null (the server checks the range). */
function heightOf(raw: string): number | null {
  const ascii = raw.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  const digits = ascii.replace(/[^\d]/g, "");
  return digits === "" ? null : Math.min(999, Number(digits));
}

export function ModelInputs({
  value,
  onChange,
  sizes,
  t,
  error,
  testid = "wz-model",
}: {
  value: ModelValue | null;
  onChange: (v: ModelValue | null) => void;
  sizes: { code: string; label: string }[];
  t: (k: string) => string;
  error?: string | null;
  testid?: string;
}) {
  const uid = useId();
  const v = value ?? { height_cm: null, size: null };
  const set = (next: ModelValue) => onChange(next.height_cm === null && !next.size ? null : next);
  return (
    <fieldset className="wz-field wz-model" data-testid={testid}>
      <legend>{t("wz.model.title")}</legend>
      <p className="wz-hint">{t("wz.model.note")}</p>
      <div className="wz-model-row">
        <div className="wz-model-cell">
          <label htmlFor={`${uid}-h`}>{t("wz.model.height")}</label>
          <input
            id={`${uid}-h`}
            type="text"
            inputMode="numeric"
            dir="ltr"
            className="wz-cell-input"
            value={v.height_cm ?? ""}
            placeholder="170"
            onChange={(e) => set({ ...v, height_cm: heightOf(e.target.value) })}
            aria-describedby={`${uid}-range`}
            data-testid={`${testid}-height`}
          />
          <span id={`${uid}-range`} className="muted">{t("wz.model.cm")}</span>
        </div>
        <div className="wz-model-cell">
          <label htmlFor={`${uid}-s`}>{t("wz.model.size")}</label>
          <select id={`${uid}-s`} value={v.size ?? ""} onChange={(e) => set({ ...v, size: e.target.value || null })} data-testid={`${testid}-size`}>
            <option value="">{t("wz.model.size_unset")}</option>
            {v.size && !sizes.some((s) => s.code === v.size) && <option value={v.size}>{v.size}</option>}
            {sizes.map((s) => (
              <option key={s.code} value={s.code}>{s.label}</option>
            ))}
          </select>
        </div>
        {value && (
          <button type="button" className="button-link wz-danger" onClick={() => onChange(null)} data-testid={`${testid}-clear`}>{t("wz.model.clear")}</button>
        )}
      </div>
      {error && <p className="wz-field-error" role="alert" data-testid={`${testid}-error`}>{error}</p>}
    </fieldset>
  );
}

/** The guidance under every image upload, and a warning badge on an image that does not follow it. */
export function ImageAdviceBadge({ advice, t }: { advice: ImageAdvice[] | undefined; t: (k: string) => string }) {
  if (!advice || advice.length === 0) return null;
  return (
    <span className="wz-image-warn" role="note" data-testid="wz-img-warn" data-advice={advice.join(",")}>
      ⚠ {advice.map((a) => t(`wz.images.warn.${a}`)).join(" · ")}
    </span>
  );
}

export function SharedImagesEditor({
  vendorId,
  urls,
  onChange,
  t,
  lang,
  advice,
  onAdvice,
  testid = "wz-shared",
}: {
  vendorId: string;
  urls: string[];
  onChange: (f: (urls: string[]) => string[]) => void;
  t: (k: string) => string;
  lang: string;
  advice: Record<string, ImageAdvice[]>;
  onAdvice: (url: string, a: ImageAdvice[]) => void;
  testid?: string;
}) {
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function add(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    const list = Array.from(files).slice(0, Math.max(0, MAX_SHARED_IMAGES - urls.length));
    if (list.length < files.length) setError(t("wz.shared.limit"));
    for (const file of list) {
      setBusy((b) => b + 1);
      try {
        const up = await uploadVendorImage(vendorId, file);
        onAdvice(up.url, imageAdvice(up.width, up.height));
        onChange((cur) => (cur.length < MAX_SHARED_IMAGES && !cur.includes(up.url) ? [...cur, up.url] : cur));
      } catch (err) {
        setError(apiErrorMessage(err, lang === "en" ? "en" : "ar"));
      } finally {
        setBusy((b) => b - 1);
      }
    }
  }

  return (
    <section className="wz-color-card wz-shared" aria-labelledby={`${testid}-h`} data-testid={testid}>
      <div className="wz-color-card-head">
        <strong id={`${testid}-h`}>{t("wz.shared.title")}</strong>
        <span className="muted">{urls.length}/{MAX_SHARED_IMAGES}</span>
      </div>
      <p className="wz-hint">{t("wz.shared.note")}</p>
      {error && <p className="wz-field-error" role="alert">{error}</p>}
      <ol className="wz-images">
        {urls.map((url, i) => (
          <li key={url} className="wz-image" data-testid={`${testid}-image`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt={`${t("wz.shared.title")} ${i + 1}`} />
            <ImageAdviceBadge advice={advice[url]} t={t} />
            <div className="wz-image-tools">
              <button type="button" aria-label={t("wz.images.remove")} onClick={() => onChange((cur) => cur.filter((u) => u !== url))} data-testid={`${testid}-remove-${i}`}>✕</button>
            </div>
          </li>
        ))}
        {urls.length < MAX_SHARED_IMAGES && (
          <li className="wz-image wz-image-add">
            <label>
              <input type="file" accept="image/jpeg,image/png,image/webp" multiple className="visually-hidden" onChange={(e) => { void add(e.target.files); e.target.value = ""; }} data-testid={`${testid}-upload`} />
              <span>{busy ? t("wz.shared.uploading") : `+ ${t("wz.shared.add")}`}</span>
            </label>
          </li>
        )}
      </ol>
    </section>
  );
}
