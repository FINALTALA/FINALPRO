"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ProductWizard, type WizardResult } from "@/components/product-wizard/ProductWizard";
import type { WizardOpen } from "@/components/product-wizard/ProductWizardPanel";
import { IconBack, IconClose } from "@/components/product-wizard/wizardIcons";
import { inManagementFrame, pushFrameScreen, reportFrameState, requestFrameEscape } from "@/lib/manageFrame";
import "@/lib/offerWizardText";
import { fill } from "@/lib/offerWizardText";
import { useT } from "@/lib/useLang";
import "@/lib/collectionsText";
import { CollectionEditView } from "./collections/CollectionEditView";
import { OfferCollectionsField } from "./collections/OfferCollectionsField";
import { CollectionPickerView } from "./collections/CollectionPickerView";
import { CollectionsView } from "./collections/CollectionsView";
import "@/lib/batchText";
import { DraftDetailsView } from "./DraftDetailsView";
import { ImportBatchView } from "./ImportBatchView";
import { ImportView } from "./ImportView";
import { OfferDetailsView } from "./OfferDetailsView";
import { LabelsScreen } from "@/components/pos/LabelsScreen";
import { OfferBarcodesManager } from "@/components/pos/OfferBarcodesManager";
import "@/lib/storePosText";

/** One screen of the workspace's large panel. */
export type PanelView = { kind: "wizard"; open: WizardOpen; /** the header title («منتج جديد» by default, «تعديل المنتج» for an edit) */ title?: string } | { kind: "details"; offerId: string }
  | { kind: "import" }
  // images in bulk: one import's drafts («دفعة الاستيراد») and a draft's read-only details
  | { kind: "import-batch"; batchId: string }
  | { kind: "draft-details"; draftId: string; title: string }
  // «مجموعات المتجر»: the list, one collection (null = a new one), its product picker
  | { kind: "collections" }
  | { kind: "collection"; id: string | null }
  | { kind: "collection-pick"; id: string; name: string }
  // one product's collections (from its details page)
  | { kind: "offer-collections"; offerId: string; title: string }
  /** «إدارة الباركود» of one product, and «طباعة ملصقات» (barcodes and in-store sales, 2026-11-20) */
  | { kind: "offer-barcodes"; offerId: string; title: string }
  | { kind: "labels" };

type Entry = { id: number; view: PanelView };
type Leave = "back" | "close";

/**
 * The workspace's ONE large panel for managing products: «منتج جديد»,
 * «تعديل المنتج», «التفاصيل» and «الاستيراد» opened from «المنتجات والعروض»
 * all show here - same size, edges and background - instead of a second
 * panel or a separate page. Opening a screen from another one replaces the
 * panel's content and adds «رجوع» back to it; × closes the whole panel and
 * leaves the products page exactly as it was (filters, scroll).
 *
 * Browser back: each screen adds a history entry with the SAME url (no
 * routing change; Next keeps its own state on it), so back steps through
 * the panel's screens and finally closes it. A screen with something
 * unsaved (the wizard) is saved first - the same save as its × - and stays
 * open if that save fails. The standalone routes (/offers/[id]/details,
 * /offers/import) are untouched for direct links and new tabs.
 *
 * Inside the store's management frame (the storefront's «إدارة» window,
 * an iframe) this is NOT a second panel: it fills the frame's content (no
 * backdrop, edges, shadow or × of its own), and the frame's header shows
 * the screen's title, the one «رجوع» and the one × (lib/manageFrame.ts).
 */
export function ManagePanel({ vendorId, initial, onClose }: { vendorId: string; initial: PanelView; onClose: () => void }) {
  const t = useT();
  const nextId = useRef(1);
  const [stack, setStack] = useState<Entry[]>([{ id: 0, view: initial }]);
  const stackRef = useRef(stack);
  const dialogRef = useRef<HTMLDivElement>(null);
  /** The wizard's own close (save first when something was entered). */
  const wizardCloseRef = useRef<(() => void) | null>(null);
  /** Where a wizard close that WE asked for should go once it has saved. */
  const pendingRef = useRef<Leave>("close");
  const ignorePops = useRef(0);
  const finished = useRef(false);
  const pushed = useRef(false);
  const onCloseRef = useRef(onClose);
  const [framed] = useState(() => inManagementFrame());
  /** The frame's × waiting for this panel to finish closing (after the wizard saved). */
  const frameDoneRef = useRef<(() => void) | null>(null);
  const titleRef = useRef("");
  const backTitleRef = useRef<string | null>(null);

  useEffect(() => {
    stackRef.current = stack;
  }, [stack]);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  function finish() {
    if (finished.current) return;
    finished.current = true;
    frameDoneRef.current?.();
    frameDoneRef.current = null;
    onCloseRef.current();
  }

  /** Leave the top screen: «رجوع» one screen (history follows), or close the whole panel. */
  function leave(how: Leave) {
    const depth = stackRef.current.length;
    if (how === "back" && depth > 1) {
      ignorePops.current += 1;
      window.history.back();
      setStack((s) => s.slice(0, -1));
      return;
    }
    ignorePops.current += 1;
    window.history.go(-depth);
    finish();
  }

  /** Leave, but let the wizard save first (it calls back through onClose/onBack when done). */
  function requestLeave(how: Leave) {
    const top = stackRef.current[stackRef.current.length - 1];
    if (top.view.kind === "wizard" && wizardCloseRef.current) {
      pendingRef.current = how;
      wizardCloseRef.current();
      return;
    }
    leave(how);
  }

  function push(view: PanelView) {
    const id = nextId.current++;
    setStack((s) => [...s, { id, view }]);
    window.history.pushState({ fpPanel: stackRef.current.length + 1 }, "");
  }

  function onWizardDone(result: WizardResult, how: Leave) {
    // published / applied from a screen inside the panel: back to that screen (it reloads)
    const back = how === "back" || ((result.kind === "created" || result.kind === "applied") && stackRef.current.length > 1);
    pendingRef.current = "close";
    leave(back ? "back" : "close");
  }

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    const previousRootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    if (!pushed.current) {
      pushed.current = true;
      window.history.pushState({ fpPanel: 1 }, "");
    }
    const onPop = () => {
      if (finished.current) return;
      if (ignorePops.current > 0) {
        ignorePops.current -= 1;
        return;
      }
      const s = stackRef.current;
      const top = s[s.length - 1];
      if (top.view.kind === "wizard" && wizardCloseRef.current) {
        // keep this screen's entry until the wizard has saved (if saving fails it stays open)
        window.history.pushState({ fpPanel: s.length }, "");
        pendingRef.current = "back";
        wizardCloseRef.current();
        return;
      }
      // a read-only screen: nothing to save - the browser already went back one entry
      if (s.length > 1) setStack((x) => x.slice(0, -1));
      else finish();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      document.body.style.overflow = previousOverflow;
      document.documentElement.style.overflow = previousRootOverflow;
      if (opener && document.contains(opener)) opener.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const top = stack[stack.length - 1];
  const depth = stack.length;
  const viewTitle = (v: PanelView): string => {
    switch (v.kind) {
      case "details":
        return t("panel.details");
      case "import":
        return t("panel.import");
      case "import-batch":
        return t("panel.import_batch");
      case "draft-details":
        return t("panel.draft_details");
      case "collections":
        return t("col.title");
      case "collection":
        return v.id ? t("col.edit_title") : t("col.new_title");
      case "collection-pick":
        return t("pick.title");
      case "offer-collections":
        return t("col.assign_title");
      case "offer-barcodes":
        return t("bc.manage");
      case "labels":
        return t("pos.labels.title");
      default:
        return v.title ?? t("catalog.new");
    }
  };

  // In the management frame: the frame's header carries this screen's title, «رجوع» and ×.
  useEffect(() => {
    if (!framed) return;
    return pushFrameScreen({
      title: () => titleRef.current,
      backTitle: () => backTitleRef.current,
      back: () => requestLeave("back"),
      close: (done) => {
        frameDoneRef.current = done;
        requestLeave("close");
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [framed]);
  useEffect(() => {
    titleRef.current = viewTitle(top.view);
    backTitleRef.current = stack.length > 1 ? viewTitle(stack[stack.length - 2].view) : null;
    if (framed) reportFrameState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [top.id, framed]);

  // each screen starts with its title focused (and announced)
  useEffect(() => {
    requestAnimationFrame(() => {
      const first = dialogRef.current?.querySelector<HTMLElement>("#wz-panel-title, #wzp-view-title");
      if (first) {
        if (!first.hasAttribute("tabindex")) first.setAttribute("tabindex", "-1");
        first.focus();
      } else dialogRef.current?.focus();
    });
  }, [top.id]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (framed) requestFrameEscape();
      else requestLeave("close");
      return;
    }
    // in the frame, Tab must still reach the frame's own «رجوع» and ×
    if (framed || e.key !== "Tab" || !dialogRef.current) return;
    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const view = top.view;
  return createPortal(
    <div className={framed ? "wzp-backdrop is-framed" : "wzp-backdrop"} data-testid="wz-panel-backdrop">
      <div
        ref={dialogRef}
        className={framed ? "wzp is-framed" : "wzp"}
        role={framed ? "region" : "dialog"}
        aria-modal={framed ? undefined : "true"}
        aria-labelledby={view.kind === "wizard" ? "wz-panel-title" : "wzp-view-title"}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        data-testid="wz-panel"
        data-view={view.kind}
      >
        {view.kind === "wizard" ? (
          <ProductWizard
            key={`${top.id}:${view.open.draftId ?? "new"}`}
            vendorId={vendorId}
            draftId={view.open.draftId}
            context={view.open.context}
            mode="panel"
            onClose={(r) => onWizardDone(r, pendingRef.current)}
            onBack={depth > 1 && !framed ? (r) => onWizardDone(r, "back") : undefined}
            backLabel={depth > 1 ? fill(t("panel.back_to"), { title: viewTitle(stack[depth - 2].view) }) : undefined}
            // switching to another draft from «مسوداتي» replaces this screen (no new history entry)
            onOpenDraft={(id) => setStack((s) => [...s.slice(0, -1), { id: nextId.current++, view: { kind: "wizard", open: { draftId: id } } }])}
            closeRef={wizardCloseRef}
          />
        ) : (
          <div className="wzp-view wz-mode-panel" key={top.id}>
            <header className="wz-head" hidden={framed}>
              <div className="wz-head-bar">
                {depth > 1 && (
                  <button type="button" className="wz-close wzp-back" onClick={() => leave("back")} aria-label={fill(t("panel.back_to"), { title: viewTitle(stack[depth - 2].view) })} title={fill(t("panel.back_to"), { title: viewTitle(stack[depth - 2].view) })} data-testid="wzp-back">
                    <IconBack />
                  </button>
                )}
                <div className="wz-head-title">
                  <p className="wz-heading" id="wzp-view-title">
                    {viewTitle(view)}
                  </p>
                </div>
                <div className="wz-head-tools">
                  <button type="button" className="wz-close" onClick={() => leave("close")} aria-label={t("wz.panel.close")} title={t("wz.panel.close")} data-testid="wzp-close">
                    <IconClose />
                  </button>
                </div>
              </div>
            </header>
            <div className="wzp-view-body">
              {view.kind === "details" ? (
                <OfferDetailsView
                  vendorId={vendorId}
                  offerId={view.offerId}
                  embedded
                  onEdit={(draftId) => push({ kind: "wizard", open: { draftId }, title: t("edit.button") })}
                  onManageCollections={(offerId, title) => push({ kind: "offer-collections", offerId, title })}
                  onManageBarcodes={(offerId, title) => push({ kind: "offer-barcodes", offerId, title })}
                />
              ) : view.kind === "import" ? (
                <ImportView
                  vendorId={vendorId}
                  embedded
                  onOpenDraft={(draftId) => push({ kind: "wizard", open: { draftId } })}
                  onBatchCreated={(batchId) => push({ kind: "import-batch", batchId })}
                />
              ) : view.kind === "import-batch" ? (
                <ImportBatchView
                  vendorId={vendorId}
                  batchId={view.batchId}
                  embedded
                  onReview={(draftId) => push({ kind: "wizard", open: { draftId }, title: t("bp.review") })}
                  onDetails={(draftId, title) => push({ kind: "draft-details", draftId, title })}
                  onOpenOffer={(offerId) => push({ kind: "details", offerId })}
                  onPrintLabels={() => push({ kind: "labels" })}
                />
              ) : view.kind === "draft-details" ? (
                <DraftDetailsView vendorId={vendorId} draftId={view.draftId} embedded onReview={(draftId) => push({ kind: "wizard", open: { draftId }, title: t("bp.review") })} />
              ) : view.kind === "collections" ? (
                <CollectionsView vendorId={vendorId} onEdit={(id) => push({ kind: "collection", id })} />
              ) : view.kind === "collection" ? (
                <CollectionEditView
                  vendorId={vendorId}
                  id={view.id}
                  onSaved={() => leave("back")}
                  onPick={(id, name) => push({ kind: "collection-pick", id, name })}
                />
              ) : view.kind === "offer-collections" ? (
                <div className="owner-catalog owner-embedded col-view" data-testid="offer-collections-view">
                  <h1 className="page-title col-title">{t("col.assign_title")}</h1>
                  <p className="wz-lead">{view.title ? fill(t("col.assign_lead"), { title: view.title }) : t("offer.collections_hint")}</p>
                  <OfferCollectionsField
                    vendorId={vendorId}
                    offerId={view.offerId}
                    mode="direct"
                    onSaved={() => leave("back")}
                    onManage={() => push({ kind: "collections" })}
                  />
                </div>
              ) : view.kind === "offer-barcodes" ? (
                <OfferBarcodesManager
                  vendorId={vendorId}
                  offerId={view.offerId}
                  onPrint={() => push({ kind: "labels" })}
                />
              ) : view.kind === "labels" ? (
                <LabelsScreen vendorId={vendorId} />
              ) : view.kind === "collection-pick" ? (
                <CollectionPickerView vendorId={vendorId} id={view.id} onAdded={() => leave("back")} />
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
