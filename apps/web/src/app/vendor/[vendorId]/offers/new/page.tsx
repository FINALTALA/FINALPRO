"use client";

import { IconCopy, IconPlus, IconTrash } from "@/components/product-wizard/wizardIcons";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { CopyProductDialog } from "@/components/product-wizard/CopyProductDialog";
import { ProductWizardPanel, type WizardOpen } from "@/components/product-wizard/ProductWizardPanel";
import { ErrorBanner } from "@/components/States";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiErrors";
import { fill } from "@/lib/offerWizardText";
import "@/lib/offerWizardText";
import "@/lib/importText";
import { useLang, useT } from "@/lib/useLang";
import { useSignInGuard } from "@/lib/useSignInGuard";

/** Phase A+: a product created but not published yet (from the wizard, the classic form or an import). */
interface UnpublishedOffer {
  id: string;
  kind: "offer";
  title: string;
  label: "DRAFT" | "BRAND_PENDING";
  thumbnail: string | null;
}

interface DraftListItem {
  id: string;
  title: string;
  step: number;
  revision: number;
  thumbnail: string | null;
  updated_at: string;
  /** Created by the product import (then completed here, in the wizard). */
  imported?: boolean;
}

// Product-entry wizard: «مسوداتي» and «منتج جديد». Phase A: «منتج جديد» opens
// the wizard's panel WITHOUT creating anything - the draft exists only from
// the seller's first real information; «متابعة» reopens a saved draft there.
// Phase A+: ONE «مسوداتي» - open drafts and products created but not
// published yet (imports too); such a product is completed and published
// on its own page.
export default function NewProductStartPage() {
  const params = useParams<{ vendorId: string }>();
  const t = useT();
  const lang = useLang();
  const [drafts, setDrafts] = useState<DraftListItem[] | null>(null);
  const [offers, setOffers] = useState<UnpublishedOffer[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [wizard, setWizard] = useState<WizardOpen | null>(null);
  /** Phase A++ (item 1): «نسخ كمنتج جديد» - a draft or an unpublished product. */
  const [copying, setCopying] = useState<{ from: { offer_id: string } | { draft_id: string }; title: string } | null>(null);
  // TB-34: no session / a 401 -> sign-in, back to this page afterwards.
  const signInIfLost = useSignInGuard();

  const load = useCallback(() => {
    apiFetch<{ items: DraftListItem[] }>(`/vendors/${params.vendorId}/offer-drafts`)
      .then((r) => setDrafts(r.items))
      .catch((err) => {
        if (signInIfLost(err)) return;
        setError(err);
        setDrafts([]);
      });
    apiFetch<{ items: ({ kind: "draft" } | UnpublishedOffer)[] }>(`/vendors/${params.vendorId}/unpublished-products`)
      .then((r) => setOffers(r.items.filter((x): x is UnpublishedOffer => x.kind === "offer")))
      .catch(() => setOffers([]));
  }, [params.vendorId, signInIfLost]);
  useEffect(load, [load]);


  async function discard(d: DraftListItem) {
    if (!window.confirm(t("wz.start.discard_confirm"))) return;
    try {
      await apiFetch(`/vendors/${params.vendorId}/offer-drafts/${d.id}?expected_revision=${d.revision}`, { method: "DELETE" });
      load();
    } catch (err) {
      if (signInIfLost(err)) return;
      setError(err);
      load();
    }
  }

  const when = (iso: string) =>
    new Date(iso).toLocaleString(lang === "en" ? "en-GB" : "ar", { dateStyle: "medium", timeStyle: "short" });

  return (
    <div className="page-shell wz-start">
      <header className="wz-start-head">
        <div className="wz-start-intro">
          <h1 className="page-title">{t("wz.start.title")}</h1>
          <p className="wz-lead">{t("wz.start.lead")}</p>
        </div>
        <div className="wz-start-tools">
          <Link href={`/vendor/${params.vendorId}/offers`} className="button-link wz-start-back">{t("wz.start.back")}</Link>
          <button type="button" className="button wz-start-new" onClick={() => setWizard({ draftId: null })} data-testid="wz-start-new">
            <IconPlus /> {t("wz.start.new")}
          </button>
        </div>
      </header>
      {error !== null && <ErrorBanner message={apiErrorMessage(error, lang) || t("wz.start.failed")} />}

      <section className="wz-drafts" aria-labelledby="wz-drafts-title">
        <h2 id="wz-drafts-title">
          {t("wz.start.drafts")}
          {drafts !== null && <span className="wz-start-count">{(drafts?.length ?? 0) + offers.length}</span>}
        </h2>
        {drafts === null && <div className="skeleton" style={{ height: 72, maxWidth: 720 }} />}
        {drafts?.length === 0 && offers.length === 0 && <p className="muted">{t("wz.start.no_drafts")}</p>}
        <ul className="wz-draft-list">
          {drafts?.map((d) => (
            <li key={d.id} className="wz-draft-item" data-testid="wz-draft-item">
              {d.thumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={d.thumbnail} alt="" className="wz-draft-thumb" />
              ) : (
                <span className="wz-draft-thumb wz-draft-thumb-empty" aria-hidden="true" />
              )}
              <div className="wz-draft-text">
                <strong className="wz-draft-name">{d.title === "مسودة جديدة" ? t("wz.draft_title_new") : d.title}</strong>
                <span className="wz-draft-meta">
                  <span className="wz-draft-chip">{t("wz.card.DRAFT")}</span>
                  {d.imported && <span className="wz-draft-chip wz-draft-chip-imported" data-testid={`draft-imported-${d.id}`}>{t("drafts.imported")}</span>}
                  <span>{fill(t("wz.start.step"), { n: Math.min(5, d.step) })}</span>
                </span>
                <span className="wz-draft-progress" aria-hidden="true"><span style={{ inlineSize: `${(Math.min(5, d.step) / 5) * 100}%` }} /></span>
                <span className="wz-draft-when">{fill(t("wz.start.saved_at"), { t: when(d.updated_at) })}</span>
              </div>
              <div className="wz-draft-actions">
                <button type="button" className="button" onClick={() => setWizard({ draftId: d.id })} data-testid="wz-draft-continue">{t("wz.start.continue")}</button>
                <button type="button" className="button-link wz-ghost" onClick={() => setCopying({ from: { draft_id: d.id }, title: d.title })} data-testid="wz-draft-copy"><IconCopy /> {t("copy.button")}</button>
                <button type="button" className="button-link wz-danger" onClick={() => void discard(d)}><IconTrash /> {t("wz.start.discard")}</button>
              </div>
            </li>
          ))}
          {offers.map((o) => (
            <li key={o.id} className="wz-draft-item wz-draft-item-offer" data-testid="wz-unpublished-offer">
              {o.thumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={o.thumbnail} alt="" className="wz-draft-thumb" />
              ) : (
                <span className="wz-draft-thumb wz-draft-thumb-empty" aria-hidden="true" />
              )}
              <div className="wz-draft-text">
                <strong className="wz-draft-name">{o.title}</strong>
                <span className="wz-draft-meta">
                  <span className="wz-draft-chip wz-draft-chip-offer">{t("wz.drafts.offer")}</span>
                  <span>{t(`wz.card.${o.label}`)}</span>
                </span>
              </div>
              <div className="wz-draft-actions">
                <Link href={`/vendor/${params.vendorId}/offers/${o.id}`} className="button" data-testid="wz-unpublished-open">{t("wz.drafts.open_offer")}</Link>
                <button type="button" className="button-link wz-ghost" onClick={() => setCopying({ from: { offer_id: o.id }, title: o.title })} data-testid="wz-unpublished-copy"><IconCopy /> {t("copy.button")}</button>
              </div>
            </li>
          ))}
        </ul>
      </section>
      {copying && (
        <CopyProductDialog
          vendorId={params.vendorId}
          from={copying.from}
          title={copying.title}
          onCancel={() => setCopying(null)}
          onCopied={(draftId) => {
            setCopying(null);
            setWizard({ draftId });
            load();
          }}
        />
      )}
      {wizard && (
        <ProductWizardPanel
          vendorId={params.vendorId}
          open={wizard}
          onClose={() => {
            setWizard(null);
            load();
          }}
        />
      )}
    </div>
  );
}
