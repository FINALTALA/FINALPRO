"use client";

import { useEffect, useState } from "react";
import { ErrorBanner } from "@/components/States";
import { ModelInputs, SharedImagesEditor, type ImageAdvice, type ModelValue } from "@/components/product-wizard/presentation";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiErrors";
import "@/lib/offerWizardText";
import { useLang, useT } from "@/lib/useLang";

interface PresentationDto {
  model: ModelValue | null;
  shared_images: string[];
  sizes: { code: string; label: string }[];
}

/**
 * Phase A++ (items 5 and 6): a product's model information and its shared
 * images, edited after creation (PUT .../model and .../shared-images - the
 * same rules as the wizard). Removing a shared image removes only this
 * product's link to it; the file itself is never deleted from here.
 */
export default function OfferPresentationCard({ vendorId, offerId }: { vendorId: string; offerId: string }) {
  const t = useT();
  const lang = useLang();
  const base = `/vendors/${vendorId}/offers/${offerId}`;
  const [data, setData] = useState<PresentationDto | null>(null);
  const [model, setModel] = useState<ModelValue | null>(null);
  const [shared, setShared] = useState<string[]>([]);
  const [advice, setAdvice] = useState<Record<string, ImageAdvice[]>>({});
  const [busy, setBusy] = useState<"model" | "shared" | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<PresentationDto>(`${base}/presentation`)
      .then((d) => {
        setData(d);
        setModel(d.model);
        setShared(d.shared_images);
      })
      .catch((err) => setError(apiErrorMessage(err, lang)));
  }, [base, lang]);

  if (!data) return error ? <ErrorBanner message={error} /> : null;

  async function saveModel() {
    setBusy("model");
    setModelError(null);
    setNotice(null);
    try {
      const d = await apiFetch<PresentationDto>(`${base}/model`, {
        method: "PUT",
        body: { height_cm: model?.height_cm ?? null, size: model?.size ?? null },
      });
      setData(d);
      setModel(d.model);
      setNotice(t("pres.saved"));
    } catch (err) {
      setModelError(apiErrorMessage(err, lang));
    } finally {
      setBusy(null);
    }
  }

  async function saveShared() {
    setBusy("shared");
    setError(null);
    setNotice(null);
    try {
      const d = await apiFetch<PresentationDto>(`${base}/shared-images`, { method: "PUT", body: { urls: shared } });
      setData(d);
      setShared(d.shared_images);
      setNotice(t("pres.saved"));
    } catch (err) {
      setError(apiErrorMessage(err, lang));
    } finally {
      setBusy(null);
    }
  }

  const sharedChanged = JSON.stringify(shared) !== JSON.stringify(data.shared_images);
  const modelChanged = JSON.stringify(model) !== JSON.stringify(data.model);

  return (
    <section className="card" style={{ maxWidth: 720, marginTop: 16 }} aria-labelledby="offer-pres-h" data-testid="offer-presentation-card">
      <h3 id="offer-pres-h" style={{ marginTop: 0 }}>{t("pres.title")}</h3>
      <ModelInputs value={model} onChange={setModel} sizes={data.sizes} t={t} error={modelError} testid="offer-model" />
      <button type="button" className="button" onClick={() => void saveModel()} disabled={busy !== null || !modelChanged} data-testid="offer-model-save">
        {t("pres.save_model")}
      </button>
      <div style={{ marginTop: 16 }}>
        <SharedImagesEditor
          vendorId={vendorId}
          urls={shared}
          onChange={(f) => setShared((cur) => f(cur))}
          t={t}
          lang={lang}
          advice={advice}
          onAdvice={(url, a) => setAdvice((x) => ({ ...x, [url]: a }))}
          testid="offer-shared"
        />
        <button type="button" className="button" onClick={() => void saveShared()} disabled={busy !== null || !sharedChanged} data-testid="offer-shared-save">
          {t("pres.save_shared")}
        </button>
      </div>
      {error && <ErrorBanner message={error} />}
      {notice && <p className="muted" role="status" data-testid="offer-presentation-notice">{notice}</p>}
    </section>
  );
}
