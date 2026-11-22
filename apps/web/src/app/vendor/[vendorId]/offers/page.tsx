"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CopyProductDialog } from "@/components/product-wizard/CopyProductDialog";
import { EditProductButton } from "@/components/product-wizard/EditProductButton";
import { IconBell, IconCollections, IconCopy, IconDrafts, IconEye, IconPlus, IconUpload } from "@/components/product-wizard/wizardIcons";
import { ManagePanel, type PanelView } from "@/components/owner/ManagePanel";
import { EmptyState, ErrorBanner } from "@/components/States";
import { ApiError, apiFetch } from "@/lib/api";
import { clearSession, getSessionToken } from "@/lib/session";
import { loginRedirectHref } from "@/lib/loginRedirect";
import "@/lib/collectionsText";
import { useHighlightParam, useScrollToHighlight } from "@/lib/highlightParam";
import { fill } from "@/lib/offerWizardText";
import "@/lib/offerWizardText";
import { useLang, useT } from "@/lib/useLang";

/** Where a version lives (GET .../offer-variants/:id/locate). */
interface LocatedVersion {
  variant_id: string;
  offer_id: string;
  title_ar: string;
  title_en: string;
  color_name_ar: string | null;
  color_name_en: string | null;
  color_code: string | null;
  size_code: string | null;
  size: string | null;
}

interface OfferDto {
  id: string;
  title_ar: string;
  title_en: string;
  status: "DRAFT" | "ACTIVE" | "INACTIVE" | "ARCHIVED";
  canonical_product_id: string | null;
  brand_id: string | null;
  price_is_offer_level?: boolean;
  edit_via_draft?: boolean;
}

// Sprint 13 (list) + Sprint 17 (owner catalog: create/edit/archive,
// PDR-036 templates, brand, media, pricing/discounts, import, matching)
// - the real, reachable catalog management UI. Backend authorization
// (VendorMembershipGuard + @RequireVendorRole('OWNER')) is the actual
// boundary; this page just hides owner-only actions from anyone else.
// Visual pass: the same warm language as «مسوداتي» (.wz-start) - one wine
// primary («+ منتج جديد»), «مسوداتي» secondary, import quieter still, and
// the products in a warm card that becomes one card per product on a phone.
export default function OwnerOffersPage() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const t = useT();
  const lang = useLang();
  const [offers, setOffers] = useState<OfferDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The workspace's one large panel (new product, edit, details, import); null = closed. */
  const [panel, setPanel] = useState<PanelView | null>(null);
  /** Phase A++ (item 1): «نسخ كمنتج جديد» - the product being copied. */
  const [copying, setCopying] = useState<{ id: string; title: string } | null>(null);
  // 2026-11-18: a low-stock store notification opened this page for one
  // version (?stock_variant=&branch=): which product, colour and size - the
  // row is marked, with the branch stock and the details one tap away.
  const stockVariant = useHighlightParam("stock_variant");
  const stockBranch = useHighlightParam("branch");
  const [located, setLocated] = useState<LocatedVersion | "missing" | null>(null);
  useEffect(() => {
    if (!stockVariant) return;
    let cancelled = false;
    apiFetch<LocatedVersion>(`/vendors/${params.vendorId}/offer-variants/${encodeURIComponent(stockVariant)}/locate`)
      .then((r) => {
        if (!cancelled) setLocated(r);
      })
      .catch(() => {
        if (!cancelled) setLocated("missing");
      });
    return () => {
      cancelled = true;
    };
  }, [stockVariant, params.vendorId]);
  const notifiedOffer = located && located !== "missing" ? located.offer_id : null;
  useScrollToHighlight(notifiedOffer ? `[data-offer-id="${CSS.escape(notifiedOffer)}"]` : null, Boolean(offers?.length));

  function load() {
    apiFetch<OfferDto[]>(`/vendors/${params.vendorId}/offers`)
      .then(setOffers)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          router.replace(loginRedirectHref());
          return;
        }
        setError(err instanceof ApiError ? err.message : t("catalog.load_failed"));
      });
  }

  // ?open=collections (the old «الأقسام» link, the product page's «إدارة مجموعات المتجر»)
  // opens «مجموعات المتجر» in the management window once the page is up.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    // read once from the page's own URL after mount (not available in the static render)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (q.get("open") === "collections") setPanel({ kind: "collections" });
    // a product's own collections (its details page outside the window)
    else if (q.get("open") === "offer-collections" && q.get("offer")) setPanel({ kind: "offer-collections", offerId: q.get("offer")!, title: "" });
  }, []);

  useEffect(() => {
    if (!getSessionToken()) {
      router.replace(loginRedirectHref());
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.vendorId]);

  /** A plain click opens the screen in the large panel; a new-tab click keeps the page link. */
  function inPanel(e: React.MouseEvent, view: PanelView) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    setPanel(view);
  }

  const title = (o: OfferDto) => (lang === "en" ? o.title_en || o.title_ar : o.title_ar);

  return (
    <div className="page-shell wz-start owner-catalog">
      <header className="wz-start-head owner-catalog-head">
        <div className="wz-start-intro">
          <h1 className="page-title">{t("catalog.title")}</h1>
          <p className="wz-lead">{t("catalog.lead")}</p>
        </div>
        <div className="owner-catalog-tools">
          <Link href={`/vendor/${params.vendorId}/offers/import`} onClick={(e) => inPanel(e, { kind: "import" })} className="owner-tertiary" aria-label={t("catalog.import")} title={t("catalog.import")}>
            <IconUpload /> <span className="owner-label">{t("catalog.import")}</span>
          </Link>
          {/* «مجموعات المتجر»: opens in the same management window (never a card, a second panel or a modal) */}
          <button type="button" className="button-link owner-secondary" onClick={() => setPanel({ kind: "collections" })} aria-label={t("col.open")} title={t("col.open")} data-testid="offers-collections">
            <IconCollections /> <span className="owner-label">{t("col.open")}</span>
          </button>
          <Link href={`/vendor/${params.vendorId}/offers/new`} className="button-link owner-secondary" aria-label={t("wz.start.drafts")} title={t("wz.start.drafts")}>
            <IconDrafts /> <span className="owner-label">{t("wz.start.drafts")}</span>
          </Link>
          {/* Phase A: the same wizard panel as the storefront's «إضافة منتج» (this table has no audience/category filter to pass). */}
          <button type="button" className="button owner-primary" onClick={() => setPanel({ kind: "wizard", open: { draftId: null } })} data-testid="offers-add-product">
            <IconPlus /> {t("catalog.new")}
          </button>
        </div>
      </header>
      {error && <ErrorBanner message={error} />}
      {stockVariant && located === "missing" && <p className="wz-hint" role="status">{t("notif.locate_missing")}</p>}
      {located && located !== "missing" && (
        <div className="owner-notified" role="status" data-testid="offers-low-stock">
          <span className="owner-notified-icon" aria-hidden="true"><IconBell /></span>
          <span className="owner-notified-text">
            <strong>{fill(t("notif.locate_title"), { title: lang === "en" && located.title_en ? located.title_en : located.title_ar })}</strong>
            <span>
              {fill(t("notif.locate_version"), {
                color: (lang === "en" ? located.color_name_en : null) ?? located.color_name_ar ?? located.color_code ?? "—",
                size: located.size ?? located.size_code ?? "—",
              })}
            </span>
          </span>
          <span className="owner-notified-actions">
            {stockBranch && (
              <Link href={`/vendor/${params.vendorId}/branches/${stockBranch}/stock?variant=${encodeURIComponent(located.variant_id)}`} className="button-link owner-secondary" data-testid="offers-low-stock-branch">
                {t("notif.locate_stock")}
              </Link>
            )}
            <button type="button" className="button-link wz-ghost" onClick={() => setPanel({ kind: "details", offerId: located.offer_id })}>
              {t("panel.details")}
            </button>
          </span>
        </div>
      )}
      {!offers && !error && <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 1240 }} />}
      {offers && offers.length === 0 && (
        <EmptyState title={t("catalog.empty.title")} message={t("catalog.empty.lead")}>
          <button type="button" className="button owner-primary" onClick={() => setPanel({ kind: "wizard", open: { draftId: null } })}>
            <IconPlus /> {t("catalog.new")}
          </button>
        </EmptyState>
      )}
      {offers && offers.length > 0 && (
        <section className="owner-table-card" aria-labelledby="owner-catalog-count">
          <h2 id="owner-catalog-count" className="owner-table-title">
            {t("catalog.products")} <span className="wz-start-count">{offers.length}</span>
          </h2>
          <table className="owner-table">
            <thead>
              <tr>
                <th scope="col">{t("catalog.col.title")}</th>
                <th scope="col">{t("catalog.col.status")}</th>
                <th scope="col">{t("catalog.col.brand")}</th>
                <th scope="col">{t("catalog.col.matched")}</th>
                <th scope="col">
                  <span className="visually-hidden">{t("catalog.col.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {offers.map((o) => (
                <tr key={o.id} data-testid={`offers-row-${o.id}`} data-offer-id={o.id} className={notifiedOffer === o.id ? "is-notified" : undefined} aria-current={notifiedOffer === o.id ? "true" : undefined}>
                  <th scope="row" className="owner-cell-title">
                    <span className="owner-title-line">
                      <span className="owner-title-text">{title(o)}</span>
                      {/* the owner's read-only details page: a quiet eye beside the name (the words stay in aria-label and title) */}
                      <Link href={`/vendor/${params.vendorId}/offers/${o.id}/details`} onClick={(e) => inPanel(e, { kind: "details", offerId: o.id })} className="owner-title-eye" aria-label={`${t("catalog.details_of")}: ${title(o)}`} title={`${t("catalog.details_of")}: ${title(o)}`} data-testid={`offers-details-${o.id}`}>
                        <IconEye />
                      </Link>
                    </span>
                  </th>
                  <td data-label={t("catalog.col.status")}>
                    <span className={`owner-status owner-status-${o.status.toLowerCase()}`}>{t(`catalog.status.${o.status}`)}</span>
                  </td>
                  <td data-label={t("catalog.col.brand")}>{o.brand_id ? t("catalog.brand.set") : "—"}</td>
                  <td data-label={t("catalog.col.matched")}>{o.canonical_product_id ? t("catalog.yes") : t("catalog.no")}</td>
                  <td className="owner-cell-actions">
                    <EditProductButton vendorId={params.vendorId} offer={o} onOpen={(draftId) => setPanel({ kind: "wizard", open: { draftId }, title: t("edit.button") })} className="button owner-row-edit" />
                    <button type="button" className="button-link wz-ghost owner-row-copy" onClick={() => setCopying({ id: o.id, title: o.title_ar })} aria-label={`${t("copy.button")}: ${title(o)}`} title={t("copy.button")} data-testid={`offers-copy-${o.id}`}>
                      <IconCopy /> <span className="owner-label">{t("copy.button")}</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {copying && (
        <CopyProductDialog
          vendorId={params.vendorId}
          from={{ offer_id: copying.id }}
          title={copying.title}
          onCancel={() => setCopying(null)}
          onCopied={(draftId) => {
            setCopying(null);
            setPanel({ kind: "wizard", open: { draftId } });
          }}
        />
      )}
      {panel && (
        <ManagePanel
          vendorId={params.vendorId}
          initial={panel}
          onClose={() => {
            setPanel(null);
            load();
          }}
        />
      )}
    </div>
  );
}
