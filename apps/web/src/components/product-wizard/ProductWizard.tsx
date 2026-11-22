"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { ErrorBanner } from "@/components/States";
import { apiFetch, ApiError } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiErrors";
import {
  draftVersions,
  isMeaningful,
  localPublishProblems,
  measurementsEmpty,
  stepOf,
  type Audience,
  type DraftPayload,
  type DraftProblem,
  type EditReview,
  type PublishCheck,
} from "@/lib/offerWizard";
import { fill } from "@/lib/offerWizardText";
import "@/lib/offerWizardText";
import { useTaxonomy } from "@/lib/taxonomy";
import { useDraftAutosave, type SaveState } from "@/lib/useDraftAutosave";
import { useLang, useT } from "@/lib/useLang";
import { useSignInGuard } from "@/lib/useSignInGuard";
import { colorDisplayName } from "@/lib/colorName";
import { CopyProductDialog } from "./CopyProductDialog";
import { EditReviewPanel } from "./EditReviewPanel";
import { WizardAside } from "./WizardAside";
import { IconBack, IconClose, IconDrafts, IconEdit } from "./wizardIcons";
import { OfferCollectionsField } from "@/components/owner/collections/OfferCollectionsField";
import "@/lib/collectionsText";
import { showToast } from "@/lib/toast";
import { StoreBarcodeField } from "./StoreBarcodeField";
import { StepDetails, StepImages, StepMeasurements, StepModel, StepReview, StepSizes, StepStock, type BranchOption, type BrandOption } from "./steps";

/** Phase A+: five flat steps. */
const STEP_KEYS = ["wz.step1", "wz.step2", "wz.step3", "wz.step4", "wz.step5"];
const LAST = STEP_KEYS.length;
/** How long the publish check waits after the last save before asking the server. */
const CHECK_DELAY_MS = 400;
/** Problems only the server can judge (kept from its last answer while a newer change is being saved). */
const serverOnly = (code: string) =>
  ["BRAND_PENDING", "BRAND_NOT_FOUND", "BRANCH_NOT_FOUND"].includes(code) ||
  code.startsWith("STORE_BARCODE:") ||
  code.startsWith("SIZE_GUIDE_MISMATCH") ||
  (code.startsWith("MEASUREMENTS:") && code !== "MEASUREMENTS:SIZE_GUIDE_INCOMPLETE");

/** Where the wizard was opened from: defaults only, always changeable. */
export interface WizardContext {
  audience?: Audience | null;
  category?: string | null;
}

/** How the wizard ended (panel mode). */
export type WizardResult =
  /** Closed with nothing real entered: nothing exists on the server. */
  | { kind: "closed" }
  /** Closed after its information was saved in the draft. */
  | { kind: "saved"; draftId: string; audience: Audience | null; category: string | null }
  /** The product was created (and published when `published`). */
  | { kind: "created"; offerId: string; published: boolean; audience: Audience | null; category: string | null }
  /** Edit drafts: the changes were applied to the published product. */
  | { kind: "applied"; offerId: string };

/**
 * The product-entry wizard for a NEW product - the same component in the
 * store's panel (storefront «إضافة منتج», the products table) and on its own
 * page (a direct link to a draft). Five flat steps on one server-side draft,
 * created only with the seller's first real information and saved as she
 * goes. Two actions: «حفظ كمسودة» (saves and closes) and «نشر» (creates and
 * publishes in ONE request - once). What still prevents publishing comes
 * from the server's read-only publish check, the same judgement «نشر» runs.
 */
export function ProductWizard({
  vendorId,
  draftId,
  context,
  mode,
  onClose,
  onOpenDraft,
  closeRef,
  onBack,
  backLabel,
}: {
  vendorId: string;
  draftId: string | null;
  context?: WizardContext;
  mode: "panel" | "page";
  onClose?: (result: WizardResult) => void;
  onOpenDraft?: (draftId: string) => void;
  /** Panel mode: set to this wizard's own close (Esc, the backdrop's owner). */
  closeRef?: MutableRefObject<(() => void) | null>;
  /** Panel mode, opened from another view in the same panel: «رجوع» saves the same way as × and returns to that view. */
  onBack?: (result: WizardResult) => void;
  /** «رجوع»'s accessible name, naming where it goes («رجوع إلى تفاصيل المنتج»). */
  backLabel?: string;
}) {
  const router = useRouter();
  const t = useT();
  const lang = useLang();
  const taxonomy = useTaxonomy();
  const initial = useMemo<DraftPayload>(
    () => ({ step: 1, audience: context?.audience ?? null, category: context?.category ?? null }),
    [context?.audience, context?.category],
  );
  const draft = useDraftAutosave(vendorId, draftId, { initial });
  const signInIfLost = useSignInGuard();
  const lostError = draft.state.kind === "missing" || draft.state.kind === "error" ? draft.state.error : null;
  useEffect(() => {
    if (lostError) signInIfLost(lostError);
  }, [lostError, signInIfLost]);
  const { payload, state, update, brandRequest, edit } = draft;
  const brandRejected = payload.brand?.mode === "request" && brandRequest?.status === "REJECTED";
  const brandPending = payload.brand?.mode === "request" && brandRequest?.status === "PENDING";
  const step = stepOf(payload);
  // The steps opened in this visit - exactly those (a step jumped over is not "visited").
  const [seen, setSeen] = useState<ReadonlySet<number>>(() => new Set());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [brands, setBrands] = useState<BrandOption[]>([]);
  // «باركود المنتج للمحل»: offered while the store's barcodes are on (the cashier answers)
  const [storeBarcodeOn, setStoreBarcodeOn] = useState(false);
  useEffect(() => {
    let cancelled = false;
    apiFetch(`/vendors/${vendorId}/cashier`)
      .then(() => !cancelled && setStoreBarcodeOn(true))
      .catch(() => !cancelled && setStoreBarcodeOn(false));
    return () => {
      cancelled = true;
    };
  }, [vendorId]);
  const [branches, setBranches] = useState<BranchOption[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<{ text: string; offerId?: string } | null>(null);
  const [check, setCheck] = useState<PublishCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [showProblems, setShowProblems] = useState(false);
  const [closeError, setCloseError] = useState(false);
  const [closing, setClosing] = useState(false);
  const [draftsOpen, setDraftsOpen] = useState(false);
  /** Phase A++ (item 1): «نسخ كمنتج جديد» from the list. */
  const [copying, setCopying] = useState<{ from: { offer_id: string } | { draft_id: string }; title: string } | null>(null);
  /** Edit drafts: «مراجعة التعديلات», the choices of a conflict, and the actions. */
  const [review, setReview] = useState<EditReview | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [choices, setChoices] = useState<Record<string, "mine" | "current">>({});
  const [rebasing, setRebasing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [otherDrafts, setOtherDrafts] = useState<{ id: string; kind: "draft" | "offer"; title: string; label: string }[] | null>(null);

  useEffect(() => {
    apiFetch<BrandOption[]>("/brands", { auth: false }).then(setBrands).catch(() => setBrands([]));
    apiFetch<BranchOption[]>(`/vendors/${vendorId}/branches`)
      .then((list) => setBranches(list.filter((b) => !b.archived_at)))
      .catch(() => setBranches([]));
  }, [vendorId]);

  // The server's publish check (read-only): asked again shortly after each save.
  const draftKey = draft.id;
  const confirmedPayload = draft.confirmed;
  const brandStatus = brandRequest?.status ?? null;
  useEffect(() => {
    if (!draftKey) {
      setCheck(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setChecking(true);
      try {
        const r = await apiFetch<PublishCheck>(`/vendors/${vendorId}/offer-drafts/${draftKey}/publish-check`);
        if (!cancelled) setCheck(r);
      } catch {
        // No answer: the page's own list stays; «نشر» stays off until one comes.
      } finally {
        if (!cancelled) setChecking(false);
      }
    }, CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [vendorId, draftKey, confirmedPayload, brandStatus]);

  // Edit drafts: the review is asked again after each save while on the last step.
  const onReviewStep = edit !== null && stepOf(payload) === LAST;
  const [reviewTick, setReviewTick] = useState(0);
  useEffect(() => {
    if (!onReviewStep || !draftKey) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setReviewLoading(true);
      try {
        const r = await apiFetch<EditReview>(`/vendors/${vendorId}/offer-drafts/${draftKey}/review`);
        if (!cancelled) setReview(r);
      } catch {
        // no answer: the last review stays
      } finally {
        if (!cancelled) setReviewLoading(false);
      }
    }, CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [vendorId, draftKey, confirmedPayload, onReviewStep, reviewTick]);

  async function goTo(n: number) {
    setSeen((v) => new Set([...v, step, n]));
    update((p) => ({ ...p, step: n, layout: 5 }));
    await draft.saveNow();
    requestAnimationFrame(() => headingRef.current?.focus());
  }

  /** Product colours: a colour by its key - its own name (English empty: the Arabic one); unnamed: its family's. */
  const colorName = (key: string) => {
    const c = payload.colors?.find((x) => x.key === key);
    if (c && c.name_ar.trim()) return colorDisplayName(c, lang);
    const f = taxonomy.data?.colors.find((x) => x.code === (c?.family ?? key));
    return f ? (lang === "en" ? f.name_en || f.name_ar : f.name_ar) : key;
  };
  const sizeLabel = (code: string) => taxonomy.data?.sizes.find((x) => x.code === code)?.label ?? code;
  const problemText = (code: string) => {
    const [key, rest] = [code.split(":")[0], code.split(":").slice(1).join(":")];
    if (key === "MEASUREMENTS") {
      const specific = `wz.p.MEASUREMENTS.${rest}`;
      return t(specific) !== specific ? t(specific) : t("wz.p.MEASUREMENTS");
    }
    if (key === "SPEC_INVALID") return fill(t("wz.p.SPEC_INVALID"), { spec: t(`wz.spec.${rest}`) });
    if (key === "DISCOUNT") {
      const specific = `wz.p.DISCOUNT.${rest}`;
      return t(specific) !== specific ? t(specific) : t("wz.p.DISCOUNT");
    }
    if (key === "SIZE_GUIDE_MISMATCH") return fill(t("wz.p.SIZE_GUIDE_MISMATCH"), { sizes: rest.split(",").map(sizeLabel).join("، ") });
    if (key.startsWith("COMPOSITION_")) return fill(t(`wz.p.${key}`), { part: t(`wz.part.${rest}`) });
    if (key === "STORE_BARCODE") {
      const [problem, ...title] = rest.split(":");
      const specific = `wzb.p.${problem}`;
      return fill(t(specific) !== specific ? t(specific) : t("wzb.p.generic"), { title: title.join(":") });
    }
    return fill(t(`wz.p.${key}`), { color: rest ? colorName(rest) : "" });
  };
  const goToProblem = (p: DraftProblem) => {
    void goTo(p.step).then(() => {
      if (p.step === 3 && (p.code.startsWith("MEASUREMENTS") || p.code === "MEASUREMENTS_SUGGESTED")) {
        requestAnimationFrame(() => document.querySelector('[data-testid="wz-measure"]')?.scrollIntoView({ block: "start" }));
      }
      if (p.step === 5 && p.code.startsWith("STORE_BARCODE")) {
        requestAnimationFrame(() => document.querySelector('[data-testid="wz-store-barcode"]')?.scrollIntoView({ block: "center" }));
      }
      if (p.step === 1 && (p.code.startsWith("COMPOSITION") || p.code === "ORIGIN_SUGGESTED")) {
        requestAnimationFrame(() => document.querySelector('[data-testid="wz-composition"]')?.scrollIntoView({ block: "start" }));
      }
    });
  };

  const category = taxonomy.data?.categories.find((c) => c.code === payload.category) ?? null;
  const path = [
    payload.audience ? t(`wz.audience.${payload.audience}`) : null,
    category ? (lang === "en" ? category.name_en || category.name_ar : category.name_ar) : null,
  ].filter(Boolean).join(" › ");

  /** Close: nothing real entered -> just close (no draft, no question); otherwise save first, then close. */
  async function requestClose(done: ((result: WizardResult) => void) | undefined = onClose) {
    if (closing) return;
    setCloseError(false);
    // Decided on what is entered NOW (not on whether a save has happened
    // yet): a name typed a moment ago is saved - and the draft created -
    // before the panel closes.
    if (draft.currentId() === null && !isMeaningful(payload)) {
      done?.({ kind: "closed" });
      return;
    }
    setClosing(true);
    const ok = state.kind === "conflict" || state.kind === "closed" ? true : await draft.saveNow();
    setClosing(false);
    if (!ok) {
      setCloseError(true);
      return;
    }
    done?.({ kind: "saved", draftId: draft.currentId()!, audience: payload.audience ?? null, category: payload.category ?? null });
  }
  useEffect(() => {
    if (closeRef) closeRef.current = () => void requestClose();
  });

  /** After «نشر»: the panel closes on the published product; the page goes to it. */
  function published(offerId: string) {
    if (mode === "panel" && onClose) {
      onClose({ kind: "created", offerId, published: true, audience: payload.audience ?? null, category: payload.category ?? null });
    } else {
      router.push(`/vendor/${vendorId}/offers/${offerId}`);
    }
  }

  /** «نشر»: everything saved first, then ONE request that creates and publishes (the server refuses a second one). */
  /** The collections' names as the review showed them (a deleted one keeps its name in the message). */
  const collectionNames = useRef(new Map<string, string>());

  async function publish() {
    if (submitting) return;
    setSubmitError(null);
    setShowProblems(true);
    setSubmitting(true);
    try {
      if (!(await draft.saveNow()) || !draft.currentId()) {
        setSubmitting(false);
        return;
      }
      const res = await apiFetch<{
        offer_id: string;
        collections_skipped?: { id: string; name: string | null; reason: "DELETED" | "FULL" }[];
      }>(`/vendors/${vendorId}/offer-drafts/${draft.currentId()}/publish`, {
        method: "POST",
        body: { expected_revision: draft.revision() },
      });
      // «مجموعات المتجر»: a collection deleted or full meanwhile did not stop
      // the publish - but it is said, by name, never skipped silently
      const skipped = res.collections_skipped ?? [];
      if (skipped.length > 0) {
        const list = skipped
          .map((c) => fill(t(`pub.reason.${c.reason}`), { name: c.name ?? collectionNames.current.get(c.id) ?? t("pub.deleted_name") }))
          .join("، ");
        showToast(fill(t("pub.collections_skipped"), { list }), "warning");
      }
      published(res.offer_id);
    } catch (err) {
      setSubmitting(false);
      if (signInIfLost(err)) return;
      if (err instanceof ApiError && err.code === "DRAFT_NOT_PUBLISHABLE") {
        // The server's own reasons: the list and the marks follow them.
        setCheck((c) => ({
          draft_id: draft.currentId()!,
          revision: draft.revision(),
          status: "OPEN",
          offer_id: null,
          ready: false,
          problems: err.details as DraftProblem[],
          hints: c?.hints ?? [],
        }));
      } else if (err instanceof ApiError && err.code === "DRAFT_CLOSED") {
        // Already published (another tab, a double click): that one product.
        const offerId = (err.details[0] as { offer_id?: string | null } | undefined)?.offer_id;
        if (offerId) published(offerId);
        else setSubmitError({ text: t("wz.closed") });
      } else if (err instanceof ApiError && err.code === "DRAFT_REVISION_CONFLICT") {
        await draft.reload();
      } else if (err instanceof ApiError && ["SELLER_SKU_ALREADY_EXISTS", "UPLOAD_NOT_USABLE", "BRANCH_NOT_FOUND"].includes(err.code)) {
        setSubmitError({ text: t(`wz.err.${err.code}`) });
      } else {
        setSubmitError({ text: t("wz.err.publish_generic") });
      }
    }
  }

  /** Edit drafts: back on the product (the panel closes on it; the page goes to it). */
  function backToProduct(applied: boolean) {
    if (!edit) return;
    if (mode === "panel" && onClose) onClose(applied ? { kind: "applied", offerId: edit.offer_id } : { kind: "closed" });
    else router.push(`/vendor/${vendorId}/offers/${edit.offer_id}`);
  }

  /** «تطبيق التعديلات»: everything saved first, then ONE request - all of it, or nothing. */
  async function applyEdit() {
    if (submitting || !edit) return;
    setSubmitError(null);
    setShowProblems(true);
    setSubmitting(true);
    try {
      if (!(await draft.saveNow()) || !draft.currentId()) {
        setSubmitting(false);
        return;
      }
      await apiFetch(`/vendors/${vendorId}/offer-drafts/${draft.currentId()}/apply`, {
        method: "POST",
        body: { expected_revision: draft.revision() },
      });
      backToProduct(true);
    } catch (err) {
      setSubmitting(false);
      if (signInIfLost(err)) return;
      if (err instanceof ApiError && err.code === "EDIT_CONFLICT") {
        // the product changed meanwhile: the review shows the groups
        setReviewTick((n) => n + 1);
      } else if (err instanceof ApiError && err.code === "DRAFT_NOT_PUBLISHABLE") {
        setCheck((c) => ({
          draft_id: draft.currentId()!,
          revision: draft.revision(),
          status: "OPEN",
          offer_id: null,
          ready: false,
          problems: err.details as DraftProblem[],
          hints: c?.hints ?? [],
        }));
      } else if (err instanceof ApiError && err.code === "DRAFT_REVISION_CONFLICT") {
        await draft.reload();
      } else if (err instanceof ApiError && ["EDIT_NOT_PUBLISHABLE", "EDIT_BRAND_PENDING", "SELLER_SKU_ALREADY_EXISTS"].includes(err.code)) {
        setSubmitError({ text: t(`wz.edit.err.${err.code}`) });
      } else if (err instanceof ApiError && err.code.startsWith("EDIT_")) {
        setSubmitError({ text: apiErrorMessage(err, lang === "en" ? "en" : "ar") });
      } else {
        setSubmitError({ text: t("wz.edit.err.generic") });
      }
    }
  }

  /** «تحديث المسودة»: the draft takes the product's current state for the chosen groups. */
  async function rebase() {
    if (rebasing || !review) return;
    setRebasing(true);
    setSubmitError(null);
    try {
      if (!(await draft.saveNow())) return;
      await apiFetch(`/vendors/${vendorId}/offer-drafts/${draft.currentId()}/rebase`, {
        method: "POST",
        body: { expected_revision: draft.revision(), choices },
      });
      setChoices({});
      await draft.reload();
      setReviewTick((n) => n + 1);
    } catch (err) {
      if (signInIfLost(err)) return;
      if (err instanceof ApiError && err.code === "EDIT_CHOICE_REQUIRED") setReviewTick((n) => n + 1);
      else setSubmitError({ text: apiErrorMessage(err, lang === "en" ? "en" : "ar") });
    } finally {
      setRebasing(false);
    }
  }

  /** «تجاهل التعديلات»: the draft is removed; the product stays exactly as it is. */
  async function discardEdit() {
    if (discarding || !draft.currentId() || !window.confirm(t("wz.edit.discard_confirm"))) return;
    setDiscarding(true);
    try {
      await draft.saveNow();
      await apiFetch(`/vendors/${vendorId}/offer-drafts/${draft.currentId()}?expected_revision=${draft.revision()}`, { method: "DELETE" });
      backToProduct(false);
    } catch (err) {
      setDiscarding(false);
      if (signInIfLost(err)) return;
      if (err instanceof ApiError && err.code === "DRAFT_REVISION_CONFLICT") await draft.reload();
      else setSubmitError({ text: apiErrorMessage(err, lang === "en" ? "en" : "ar") });
    }
  }

  /** «حفظ كمسودة»: saved, then closed (the panel) or back to «مسوداتي» (the page). */
  /**
   * Phase A++ (item 3): «معاينة» in a new tab - the window is opened at once
   * (so the browser allows it), then pointed at the preview once every
   * change is on the server, so it shows exactly what was entered.
   */
  async function openPreview() {
    const id = draft.currentId();
    if (!id) return;
    const url = `/vendor/${vendorId}/offers/drafts/${id}/preview`;
    const w = window.open("", "_blank");
    await draft.saveNow();
    if (w) w.location.href = url;
    else router.push(url);
  }

  async function saveAndClose() {
    if (mode === "panel") {
      await requestClose();
      return;
    }
    if (edit) {
      if (await draft.saveNow()) backToProduct(false);
      else setCloseError(true);
      return;
    }
    if (await draft.saveNow()) router.push(`/vendor/${vendorId}/offers/new`);
    else setCloseError(true);
  }

  async function toggleDrafts() {
    const open = !draftsOpen;
    setDraftsOpen(open);
    if (!open) return;
    try {
      // One «مسوداتي»: open drafts and products created but not published yet (imports too).
      const r = await apiFetch<{ items: { id: string; kind: "draft" | "offer"; title: string; label: string }[] }>(`/vendors/${vendorId}/unpublished-products`);
      setOtherDrafts(r.items.filter((d) => d.id !== draft.currentId()));
    } catch {
      setOtherDrafts([]);
    }
  }
  async function openOther(id: string) {
    if ((draft.currentId() !== null || isMeaningful(payload)) && !(await draft.saveNow())) {
      setCloseError(true);
      return;
    }
    onOpenDraft?.(id);
  }
  /** An unpublished product is completed and published on its own page. */
  async function openOffer(id: string) {
    if ((draft.currentId() !== null || isMeaningful(payload)) && !(await draft.saveNow())) {
      setCloseError(true);
      return;
    }
    router.push(`/vendor/${vendorId}/offers/${id}`);
  }

  const versions = useMemo(() => draftVersions(payload), [payload]);
  // The server's answer decides once it is about what is saved now; while a
  // newer change is being saved, the page's own list (plus what only the
  // server can tell, from its last answer) stands in.
  const upToDate = check !== null && !draft.dirty && state.kind === "saved" && check.revision === draft.revision();
  const local = localPublishProblems(payload);
  if (brandRejected) local.push({ code: "BRAND_REJECTED", step: 1 });
  if (brandPending) local.push({ code: "BRAND_PENDING", step: 1 });
  // a new product is published only with its store barcode (while the store's barcodes are on)
  if (!edit && storeBarcodeOn) {
    const b = payload.store_barcode;
    const given = (b?.mode === "external" && b.code.trim() !== "") || (b?.mode === "generate" && Boolean(b.code));
    if (!given) local.push({ code: "STORE_BARCODE:BARCODE_MISSING", step: 5 });
  }
  const problems: DraftProblem[] = upToDate && check
    ? check.problems
    : [...local, ...(check?.problems ?? []).filter((p) => serverOnly(p.code) && !local.some((l) => l.code === p.code))];
  // quiet suggestions - each only while what it suggests is still missing on the page
  const hints: DraftProblem[] = (check?.hints ?? []).filter((h) =>
    h.code === "MEASUREMENTS_SUGGESTED" ? measurementsEmpty(payload.measurements) : h.code === "COMPOSITION_SUGGESTED" ? !payload.composition : h.code === "ORIGIN_SUGGESTED" ? !payload.country_of_origin : true,
  );
  const canPublish = upToDate && check !== null && check.ready && problems.length === 0 && !submitting;
  // Edit drafts: a paused product is applied even with problems (they are notes);
  // an active one must pass; never while the product changed underneath.
  const canApply =
    edit !== null &&
    upToDate &&
    review !== null &&
    !reviewLoading &&
    !submitting &&
    review.conflict.length === 0 &&
    (review.groups.length > 0 || review.new_versions > 0) &&
    (review.offer_status !== "ACTIVE" || problems.length === 0);
  const stepKey = (i: number) => (edit && i === LAST - 1 ? "wz.edit.step5" : STEP_KEYS[i]);
  /** ✓ only when a visited step meets its conditions; a visited step with something missing: a quiet warning; not visited yet: its number. */
  const stepStatus = (n: number): "current" | "done" | "warn" | "todo" => {
    if (n === step) return "current";
    // Opened in this visit, or (a draft reopened later) before the step it was saved at.
    const visited = seen.has(n) || (draft.opened !== null && n < stepOf(draft.opened));
    if (!visited) return "todo";
    const missing = n === LAST ? problems.length > 0 : problems.some((p) => p.step === n);
    return missing ? "warn" : "done";
  };

  if (state.kind === "loading") {
    return <div className={mode === "page" ? "page-shell" : "wz-body"}><div className="skeleton" style={{ height: 160, maxWidth: 880 }} /></div>;
  }
  if (state.kind === "missing") {
    return (
      <div className={mode === "page" ? "page-shell" : "wz-body"}>
        <ErrorBanner message={apiErrorMessage(state.error, lang)} />
        <Link href={`/vendor/${vendorId}/offers/new`} className="button-link">{t("wz.start.drafts")}</Link>
      </div>
    );
  }

  const title = (payload.title_ar ?? "").trim() || (payload.title_en ?? "").trim() || t("wz.draft_title_new");
  const props = { payload, update, taxonomy: taxonomy.data, lang, t, showProblems, colorName, edit };
  const heading = edit
    ? fill(t("wz.edit.title"), { title: edit.title_ar ?? title })
    : draft.id !== null || title !== t("wz.draft_title_new")
      ? title
      : t("wz.panel.title");
  const back = lang === "en" ? "←" : "→";
  const next = lang === "en" ? "→" : "←";

  return (
    <div className={`wz wz-mode-${mode}${mode === "page" ? " page-shell" : ""}`} data-testid="wz">
      {/* Layout only: a fixed header (context, save state, drafts, back, close), the
          steps under it, a body that alone scrolls, and a fixed footer of actions. */}
      <header className="wz-head">
        <div className="wz-head-bar">
          {mode === "panel" && onBack && (
            <button type="button" className="wz-close wzp-back" onClick={() => void requestClose(onBack)} aria-label={backLabel ?? t("panel.back")} title={backLabel ?? t("panel.back")} data-testid="wzp-back">
              <IconBack />
            </button>
          )}
          <div className="wz-head-title">
            {/* «منتج جديد» until a draft exists; then its name («مسودة جديدة» until a name is typed). */}
            <h1 className="wz-heading" id="wz-panel-title" data-testid="wz-draft-title">
              {heading}
            </h1>
            <span className="wz-context-line">
              {path && (
                <span className="wz-context-chip" data-testid="wz-context">
                  {path}
                </span>
              )}
              {!edit && (
              <button
                type="button"
                className="button-link wz-context-change"
                onClick={() => {
                  void goTo(1);
                  requestAnimationFrame(() => (document.querySelector('[data-testid="wz-audience"] input') as HTMLInputElement | null)?.focus());
                }}
                data-testid="wz-context-change"
              >
                <IconEdit /> {t("wz.panel.change")}
              </button>
              )}
            </span>
          </div>
          <div className="wz-head-tools">
            {mode === "panel" && onOpenDraft && (
              <div className="wz-drafts">
                <button type="button" className="wz-drafts-button" aria-expanded={draftsOpen} onClick={() => void toggleDrafts()} data-testid="wz-panel-drafts">
                  <IconDrafts /> <span>{t("wz.panel.drafts")}</span>
                </button>
                {draftsOpen && (
                  <ul className="wz-drafts-list" data-testid="wz-panel-drafts-list">
                    {otherDrafts === null ? null : otherDrafts.length === 0 ? (
                      <li className="muted">{t("wz.panel.drafts_none")}</li>
                    ) : (
                      otherDrafts.map((d) => (
                        <li key={d.id} data-kind={d.kind}>
                          <button type="button" className="button-link" onClick={() => void (d.kind === "offer" ? openOffer(d.id) : openOther(d.id))} data-testid={`wz-drafts-item-${d.kind}`}>
                            {d.title}
                          </button>
                          <span className="wz-drafts-label">{d.kind === "offer" ? t("wz.drafts.offer") : t(`wz.card.${d.label}`)}</span>
                          <button type="button" className="button-link wz-drafts-copy" onClick={() => setCopying({ from: d.kind === "offer" ? { offer_id: d.id } : { draft_id: d.id }, title: d.title })} data-testid={`wz-drafts-copy-${d.kind}`}>
                            {t("copy.button")}
                          </button>
                        </li>
                      ))
                    )}
                  </ul>
                )}
              </div>
            )}
            {mode === "panel" && (
              // × closes the same way the old «العودة إلى المنتجات» did: saved first when something was entered.
              <button type="button" className="wz-close" onClick={() => void requestClose()} aria-label={t("wz.panel.close")} title={t("wz.panel.close")} data-testid="wz-panel-close">
                <IconClose />
              </button>
            )}
          </div>
        </div>
        {edit && (
          <div className="wz-edit-strip" data-testid="wz-edit-strip">
            <span>{t("wz.edit.strip")}</span>
            {edit.edited_by_other_recently && (
              <span className="wz-edit-presence" role="status" data-testid="wz-edit-presence">{t("wz.edit.presence")}</span>
            )}
          </div>
        )}
        {closeError && (
          <p className="wz-submit-error" role="alert" data-testid="wz-close-error">
            {t("wz.panel.close_failed")}{" "}
            <button type="button" className="button-link" onClick={draft.retry}>{t("wz.save.retry")}</button>
          </p>
        )}
        <nav aria-label={t("wz.steps")}>
          <ol className="wz-steps">
            {STEP_KEYS.map((key, i) => {
              const n = i + 1;
              const status = stepStatus(n);
              return (
                <li key={key} className={`wz-step wz-step-${status}`}>
                  <button type="button" onClick={() => void goTo(n)} aria-current={n === step ? "step" : undefined} data-testid={`wz-step-${n}`} data-status={status}>
                    <span className="wz-step-num" aria-hidden="true">{status === "done" ? "✓" : status === "warn" ? "!" : n}</span>
                    <span className="wz-step-label">{t(stepKey(i))}</span>
                    {(status === "done" || status === "warn") && <span className="visually-hidden"> - {t(`wz.step.${status}`)}</span>}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
      </header>

      <div className="wz-body" data-testid="wz-body">
        {state.kind === "conflict" && (
          <div className="wz-conflict" role="alertdialog" aria-labelledby="wz-conflict-title" data-testid="wz-conflict">
            <strong id="wz-conflict-title">{t("wz.conflict.title")}</strong>
            <p>{t("wz.conflict.body")}</p>
            <div className="wz-actions">
              <button type="button" className="button" onClick={() => void draft.takeServerVersion()} data-testid="wz-conflict-load">{t("wz.conflict.load")}</button>
              <button type="button" className="button-link" onClick={() => void draft.keepMine()} data-testid="wz-conflict-keep">{t("wz.conflict.keep")}</button>
            </div>
          </div>
        )}
        {state.kind === "closed" && (
          <div className="wz-conflict" role="status">
            <p>{t("wz.closed")}</p>
            {state.offerId && <Link href={`/vendor/${vendorId}/offers/${state.offerId}`} className="button">{t("wz.closed.offer")}</Link>}
          </div>
        )}

        {/* Visual pass: the form, and beside it (wide screens) the product as it is taking shape. */}
        <div className="wz-layout">
        <section className={mode === "panel" ? "wz-form" : "card wz-panel"} aria-labelledby="wz-step-title">
          <h2 id="wz-step-title" className={mode === "panel" ? "visually-hidden" : undefined} tabIndex={-1} ref={headingRef}>
            {fill(t("wz.step_of"), { n: step })}: {t(stepKey(step - 1))}
          </h2>
          <div key={String(step)} className="wz-fade">
            {step === 1 && (
              <StepDetails
                {...props}
                brands={brands}
                brandRequest={brandRequest}
                onCopyAsNew={edit && onOpenDraft ? () => setCopying({ from: { offer_id: edit.offer_id }, title: edit.title_ar ?? title }) : undefined}
              />
            )}
            {step === 2 && <StepImages {...props} vendorId={vendorId} />}
            {step === 3 && (
              <>
                <StepSizes {...props} />
                <StepMeasurements {...props} />
                <StepModel {...props} />
              </>
            )}
            {step === 4 && <StepStock {...props} branches={branches} confirmed={draft.confirmed} saveState={state} onRetry={draft.retry} saveNow={draft.saveNow} copyStock={edit ? undefined : draft.copyStock} />}
            {step === 5 && draft.currentId() && (
              <p className="wz-preview-row">
                <button type="button" className="button-link" onClick={() => void openPreview()} data-testid="wz-preview">
                  {t("wz.preview.open")}
                </button>{" "}
                <span className="muted">{t("wz.preview.note")}</span>
              </p>
            )}
            {/* «مجموعات المتجر» (optional): a new product - chosen here, joined on publish;
                an edit - the product's collections, saved directly (not through the edit draft). */}
            {step === 5 && (
              <OfferCollectionsField
                vendorId={vendorId}
                offerId={edit ? edit.offer_id : null}
                mode={edit ? "direct" : "draft"}
                onLoaded={(list) => {
                  for (const c of list) collectionNames.current.set(c.id, c.name_ar);
                }}
                value={edit ? undefined : (payload.sections ?? [])}
                onChange={edit ? undefined : (ids) => update((p) => ({ ...p, sections: ids }))}
              />
            )}
            {step === 5 && edit && (
              <EditReviewPanel
                review={review}
                loading={reviewLoading || !upToDate}
                problems={problems}
                problemText={problemText}
                goToProblem={goToProblem}
                choices={choices}
                setChoice={(g, v) => setChoices((c) => ({ ...c, [g]: v }))}
                onRebase={() => void rebase()}
                rebasing={rebasing}
                colorName={colorName}
                sizeLabel={sizeLabel}
                t={t}
                lang={lang}
              />
            )}
            {step === 5 && !edit && (
              <StepReview
                {...props}
                brands={brands}
                branches={branches ?? []}
                versions={versions}
                problems={problems}
                hints={hints}
                checking={checking || !upToDate}
                problemText={problemText}
                goToProblem={goToProblem}
                barcodeSlot={
                  storeBarcodeOn || payload.store_barcode ? (
                    <StoreBarcodeField
                      vendorId={vendorId}
                      payload={payload}
                      update={update}
                      t={t}
                      problems={problems
                        .filter((p) => p.code.startsWith("STORE_BARCODE:") && p.code !== "STORE_BARCODE:BARCODE_MISSING")
                        .map((p) => problemText(p.code))}
                      onGoToPrint={() =>
                        void draft.saveNow().then((ok) => {
                          if (ok) router.push(`/vendor/${vendorId}/labels`);
                        })
                      }
                    />
                  ) : null
                }
              />
            )}
          </div>

          {submitError && (
            <div className="wz-submit-error" role="alert" data-testid="wz-submit-error">
              <p>{submitError.text}</p>
              {submitError.offerId && <Link href={`/vendor/${vendorId}/offers/${submitError.offerId}`} className="button">{t("wz.closed.offer")}</Link>}
            </div>
          )}
        </section>
        <WizardAside
          payload={payload}
          taxonomy={taxonomy.data ?? null}
          title={edit ? (payload.title_ar ?? "").trim() || heading : heading}
          path={path}
          branchIds={(branches ?? []).map((b) => b.id)}
          colorName={colorName}
          t={t}
        />
        </div>
      </div>

      {copying && onOpenDraft && (
        <CopyProductDialog
          vendorId={vendorId}
          from={copying.from}
          title={copying.title}
          onCancel={() => setCopying(null)}
          onCopied={(id) => {
            setCopying(null);
            void openOther(id);
          }}
        />
      )}
      <footer className="wz-footer">
        <SaveIndicator state={state} onRetry={draft.retry} t={t} lang={lang === "en" ? "en" : "ar"} />
        <div className="wz-actions wz-nav">
          <button
            type="button"
            className="button-link wz-save-draft"
            disabled={state.kind === "conflict" || state.kind === "closed" || closing}
            onClick={() => void saveAndClose()}
            data-testid="wz-save-later"
          >
            {edit ? t("wz.edit.save_later") : t("wz.save_draft")}
          </button>
          {edit && (
            <button type="button" className="button-link wz-danger-link" disabled={discarding || submitting} onClick={() => void discardEdit()} data-testid="wz-edit-discard">
              {t("wz.edit.discard")}
            </button>
          )}
          {step > 1 && (
            <button type="button" className="button-link" onClick={() => void goTo(step - 1)} data-testid="wz-back">
              {back} {t("wz.back")}
            </button>
          )}
          {step < LAST && (
            <button type="button" className="button" onClick={() => void goTo(step + 1)} data-testid="wz-next">
              {t("wz.next")} {next}
            </button>
          )}
          {step === LAST && edit && (
            <button type="button" className="button" disabled={!canApply} onClick={() => void applyEdit()} data-testid="wz-edit-apply">
              {submitting ? t("wz.edit.applying") : t("wz.edit.apply")}
            </button>
          )}
          {step === LAST && !edit && (
            <button
              type="button"
              className="button"
              disabled={!canPublish}
              aria-describedby={problems.length > 0 ? "wz-missing-note" : undefined}
              onClick={() => void publish()}
              data-testid="wz-publish"
            >
              {submitting ? t("wz.publishing") : t("wz.publish")}
            </button>
          )}
          {step === LAST && problems.length > 0 && (
            <span id="wz-missing-note" className="visually-hidden">{t("wz.publish.disabled_hint")}</span>
          )}
        </div>
      </footer>
    </div>
  );
}

function SaveIndicator({ state, onRetry, t, lang }: { state: SaveState; onRetry: () => void; t: (k: string) => string; lang: "ar" | "en" }) {
  let body: React.ReactNode = null;
  if (state.kind === "local") body = <span className="muted">{t("wz.save.local")}</span>;
  if (state.kind === "saving") body = <span>{t("wz.save.saving")}</span>;
  if (state.kind === "saved") body = <span className="wz-save-ok"><span className="wz-save-dot" aria-hidden="true">✓</span> {t("wz.save.saved")}</span>;
  if (state.kind === "error" && state.error instanceof ApiError && (state.error.code === "COLOR_NAME_TAKEN" || state.error.code.startsWith("EDIT_"))) {
    // the server refused a repeated colour name, or (edit drafts) a change a
    // published product does not take: the draft is as it was; say why
    body = <span className="wz-save-error">⚠ {apiErrorMessage(state.error, lang)}</span>;
  } else if (state.kind === "error") {
    body = (
      <span className="wz-save-error">
        ⚠ {t("wz.save.error")} <button type="button" className="button-link" onClick={onRetry} data-testid="wz-save-retry">{t("wz.save.retry")}</button>
      </span>
    );
  }
  if (state.kind === "conflict") body = <span className="wz-save-error">⚠ {t("wz.conflict.title")}</span>;
  return (
    <div className="wz-save" role="status" aria-live="polite" data-testid="wz-save-state" data-state={state.kind}>
      {body}
    </div>
  );
}
