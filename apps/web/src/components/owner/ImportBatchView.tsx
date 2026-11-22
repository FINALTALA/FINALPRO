"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ProductWizardPanel } from "@/components/product-wizard/ProductWizardPanel";
import { IconAlert, IconBack, IconCheck, IconEye, IconImage } from "@/components/product-wizard/wizardIcons";
import { ErrorBanner } from "@/components/States";
import { apiFetch, ApiError } from "@/lib/api";
import "@/lib/batchText";
import { gateReason, problemMessage, problemWhere, type ImportProblem } from "@/lib/importProblems";
import { fill } from "@/lib/offerWizardText";
import { useT } from "@/lib/useLang";
import { fillPos } from "@/lib/storePosText";
import { SmallConfirm } from "./collections/SmallConfirm";
import { DraftDetailsView } from "./DraftDetailsView";
import { BarcodeResolveView, type MissingBarcodeItem } from "@/components/pos/BarcodeResolveView";
import { usePrintList } from "@/lib/printList";
import "@/lib/storePosText";

interface BatchItem {
  id: string;
  ref: string | null;
  title: string;
  state: "OPEN" | "PUBLISHED" | "CLOSED";
  offer_id: string | null;
  revision: number;
  thumbnail: string | null;
  colors: number;
  sizes: number;
  branches: number;
  images: number;
  /** the product's store barcode (null: «ينقصه باركود قبل النشر») */
  barcode?: { code: string; display_code: string; format: LabelFormat; source: "EXTERNAL" | "GENERATED" } | null;
}
type LabelFormat = "EAN13" | "EAN8" | "UPCA" | "CODE128";
/** A draft's label (every page of the batch) - what «إضافة ملصقات المحدد» adds. */
interface BatchLabel {
  id: string;
  offer_id: string | null;
  title_ar: string;
  title_en: string;
  price: number | null;
  code: string;
  display_code: string;
  format: LabelFormat;
}
interface BatchDto {
  batch_id: string;
  file_name: string;
  zip_file_name: string | null;
  drafts_total: number;
  counts: { open: number; published: number; closed: number };
  not_created: { ref: string; title: string; reason: "REJECTED" | "DUPLICATE" | "NOT_CHOSEN" | "NEEDS_BARCODE"; errors: ImportProblem[] }[];
  open_ids: string[];
  labels?: BatchLabel[];
  page: number;
  pages: number;
  items: BatchItem[];
}
interface PreflightItem {
  draft_id: string;
  title: string;
  revision: number | null;
  ready: boolean;
  state: "OPEN" | "PUBLISHED" | "CLOSED" | "NOT_FOUND";
  offer_id: string | null;
  problems: { code: string }[];
}
interface RunDto {
  id: string;
  status: "RUNNING" | "DONE";
  import_batch_id: string | null;
  total: number;
  counts: { pending: number; published: number; refused: number; already: number };
  items: { draft_id: string; title: string; state: "PENDING" | "PUBLISHED" | "REFUSED" | "ALREADY"; offer_id: string | null; problems: { code: string }[] }[];
}

/** What the batch's screen keeps while the owner reviews a draft and comes back (this tab only). */
interface Kept {
  selected: string[];
  page: number;
  runId: string | null;
}
const keyOf = (batchId: string) => `fp.importBatch.${batchId}`;
function readKept(batchId: string): Kept {
  try {
    const raw = window.sessionStorage.getItem(keyOf(batchId));
    if (raw) return { selected: [], page: 1, runId: null, ...(JSON.parse(raw) as Partial<Kept>) };
  } catch {
    // storage blocked: start fresh
  }
  return { selected: [], page: 1, runId: null };
}
function writeKept(batchId: string, k: Kept) {
  try {
    window.sessionStorage.setItem(keyOf(batchId), JSON.stringify(k));
  } catch {
    // storage blocked: the screen still works, the choice is just not kept
  }
}

const PAGE_SIZE = 24;

/**
 * «دفعة الاستيراد» (2026-11-18): ONE import's own drafts - never the store's
 * other drafts - as «مسوداتي»-style cards (main image, name, colours,
 * sizes, branches, «مستورد», open or published), each choosable, with
 * «مراجعة وتعديل» (the wizard, in the same window) and an eye for the
 * read-only details; what was not created, and why, folded away.
 * «نشر المحدد»: a preflight with the publish gate itself (ready / not and
 * why), then - after an explicit confirmation - a run on the server over
 * the ready ones only, each product whole or not at all; it carries on if
 * the window is closed; the end says what was published, what was not
 * (and why), what was published already. The choice and the page are kept
 * when the owner goes to review a draft and comes back.
 */
export function ImportBatchView({
  vendorId,
  batchId,
  embedded = false,
  onReview,
  onDetails,
  onOpenOffer,
  onImportAnother,
  onPrintLabels,
}: {
  vendorId: string;
  batchId: string;
  embedded?: boolean;
  /** In the management window: «مراجعة وتعديل» opens the wizard there. */
  onReview?: (draftId: string) => void;
  /** In the management window: the eye opens the draft's read-only details there. */
  onDetails?: (draftId: string, title: string) => void;
  /** In the management window: a published product's details. */
  onOpenOffer?: (offerId: string) => void;
  onImportAnother?: () => void;
  /** In the management window: «طباعة ملصقات» opens there (else its page). */
  onPrintLabels?: () => void;
}) {
  const t = useT();
  const [kept, setKept] = useState<Kept>(() => (typeof window === "undefined" ? { selected: [], page: 1, runId: null } : readKept(batchId)));
  const [batch, setBatch] = useState<BatchDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<PreflightItem[] | null>(null);
  // chosen drafts that still have no store barcode: resolved before the preflight
  const [needBarcode, setNeedBarcode] = useState<MissingBarcodeItem[] | null>(null);
  const printList = usePrintList(vendorId);
  const router = useRouter();
  const printLabels = () => (onPrintLabels ? onPrintLabels() : router.push(`/vendor/${vendorId}/labels`));
  const [confirming, setConfirming] = useState(false);
  // «أُضيفت X ملصقات إلى قائمة الطباعة» (added - not printed yet)
  const [labelsToast, setLabelsToast] = useState<{ added: number; missing: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<RunDto | null>(null);
  // standalone page only: the wizard and the details open here
  const [localWizard, setLocalWizard] = useState<string | null>(null);
  const [localDetails, setLocalDetails] = useState<string | null>(null);
  const headRef = useRef<HTMLHeadingElement>(null);

  const keep = useCallback(
    (next: Partial<Kept>) =>
      setKept((k) => {
        const n = { ...k, ...next };
        writeKept(batchId, n);
        return n;
      }),
    [batchId],
  );

  const load = useCallback(
    (page: number) =>
      apiFetch<BatchDto>(`/vendors/${vendorId}/product-import/${batchId}?page=${page}&page_size=${PAGE_SIZE}`)
        .then((b) => {
          setBatch(b);
          // a draft published or closed since can no longer be chosen
          setKept((k) => {
            const n = { ...k, page: b.page, selected: k.selected.filter((id) => b.open_ids.includes(id)) };
            writeKept(batchId, n);
            return n;
          });
        })
        .catch((err: unknown) => setError(err instanceof ApiError && err.status === 404 ? t("bp.not_found") : t("bp.load_failed"))),
    [vendorId, batchId, t],
  );

  useEffect(() => {
    void load(kept.page);
    // a run of THIS batch already going (another tab, a closed window), or the last one this tab started for it
    void apiFetch<{ run: RunDto | null }>(`/vendors/${vendorId}/bulk-publish/current?import_batch_id=${encodeURIComponent(batchId)}`)
      .then(async (c) => {
        if (c.run) setRun(c.run);
        else if (kept.runId) {
          const r = await apiFetch<RunDto>(`/vendors/${vendorId}/bulk-publish/${kept.runId}`);
          if (r.import_batch_id === batchId) setRun(r);
        }
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorId, batchId]);

  // a running run is followed until it is done
  const runId = run?.id ?? null;
  const running = run?.status === "RUNNING";
  useEffect(() => {
    if (!runId || !running) return;
    const timer = window.setInterval(() => {
      void apiFetch<RunDto>(`/vendors/${vendorId}/bulk-publish/${runId}`)
        .then((r) => {
          setRun(r);
          if (r.status === "DONE") void load(kept.page);
        })
        .catch(() => undefined);
    }, 1200);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, running, vendorId]);

  const selected = useMemo(() => new Set(kept.selected), [kept.selected]);
  const openIds = batch?.open_ids ?? [];
  const allSelected = openIds.length > 0 && openIds.every((id) => selected.has(id));
  const toggle = (id: string) => keep({ selected: selected.has(id) ? kept.selected.filter((x) => x !== id) : [...kept.selected, id] });

  /** Only the chosen drafts' barcodes go to this device's print list. */
  function addSelectedLabels() {
    const labels = (batch?.labels ?? []).filter((l) => selected.has(l.id));
    printList.add(labels.map((l) => ({ code: l.code, display_code: l.display_code, format: l.format, title_ar: l.title_ar, title_en: l.title_en, offer_id: l.offer_id, price: l.price })));
    setLabelsToast({ added: labels.length, missing: kept.selected.length - labels.length });
  }

  async function runPreflight(ids: string[]) {
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch<{ items: PreflightItem[] }>(`/vendors/${vendorId}/bulk-publish/preflight`, { method: "POST", body: { draft_ids: ids } });
      // the barcode first: a chosen draft without one opens the decision, never only a refusal
      const missing = r.items.filter((i) => i.problems.some((p) => p.code === "STORE_BARCODE:BARCODE_MISSING"));
      if (missing.length > 0) {
        setNeedBarcode(missing.map((i) => ({ draft_id: i.draft_id, title: i.title })));
        setPreflight(null);
        return;
      }
      setNeedBarcode(null);
      setPreflight(r.items);
      requestAnimationFrame(() => headRef.current?.focus());
    } catch {
      setError(t("bp.preflight_failed"));
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    const ready = (preflight ?? []).filter((p) => p.ready && p.revision !== null);
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch<RunDto>(`/vendors/${vendorId}/bulk-publish`, {
        method: "POST",
        body: { import_batch_id: batchId, items: ready.map((p) => ({ draft_id: p.draft_id, expected_revision: p.revision })) },
      });
      setRun(r);
      keep({ runId: r.id });
      setPreflight(null);
    } catch (err) {
      if (err instanceof ApiError && err.code === "BULK_PUBLISH_RUNNING") {
        // this batch's own run (another tab) is shown; another batch's run is only named
        const c = await apiFetch<{ run: RunDto | null }>(`/vendors/${vendorId}/bulk-publish/current?import_batch_id=${encodeURIComponent(batchId)}`).catch(() => null);
        if (c?.run) {
          setError(t("bp.already_running"));
          setRun(c.run);
          setPreflight(null);
        } else setError(t("bp.already_running_other"));
      } else setError(t("bp.start_failed"));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  function closeRun() {
    setRun(null);
    keep({ runId: null });
    void load(kept.page);
  }

  const review = (id: string) => (onReview ? onReview(id) : setLocalWizard(id));
  const details = (id: string, title: string) => (onDetails ? onDetails(id, title) : setLocalDetails(id));
  const offerLink = (offerId: string, label: string, testId: string) =>
    onOpenOffer ? (
      <button type="button" className="owner-quiet-link" onClick={() => onOpenOffer(offerId)} data-testid={testId}>{label}</button>
    ) : (
      <Link href={`/vendor/${vendorId}/offers/${offerId}/details`} className="owner-quiet-link" data-testid={testId}>{label}</Link>
    );

  // «wz-start»: the same cards and words as «مسوداتي»
  const shell = embedded ? "wz-start owner-catalog owner-import owner-embedded bp" : "page-shell wz-start owner-catalog owner-import bp";

  if (localDetails) {
    return (
      <div className={shell}>
        <button type="button" className="owner-quiet-link bp-local-back" onClick={() => setLocalDetails(null)}>
          <IconBack /> {t("bp.title")}
        </button>
        <DraftDetailsView vendorId={vendorId} draftId={localDetails} embedded onReview={(id) => { setLocalDetails(null); setLocalWizard(id); }} />
      </div>
    );
  }

  // ---- the chosen drafts without a store barcode: enter / scan, or generate ----------
  if (needBarcode) {
    return (
      <div className={shell}>
        <BarcodeResolveView
          vendorId={vendorId}
          items={needBarcode}
          onBack={() => setNeedBarcode(null)}
          onContinue={() => {
            setNeedBarcode(null);
            void runPreflight(kept.selected);
          }}
          onPrintLabels={printLabels}
        />
      </div>
    );
  }

  // ---- the run: going, then its end -------------------------------------------------
  if (run) {
    const done = run.status === "DONE";
    const by = (s: RunDto["items"][number]["state"]) => run.items.filter((i) => i.state === s);
    const finished = run.total - run.counts.pending;
    return (
      <div className={shell} data-testid="bp-run" data-state={run.status}>
        <header className="wz-start-head">
          <div className="wz-start-intro">
            <h1 className="page-title" tabIndex={-1}>{done ? t("bp.run.done_title") : t("bp.run.title")}</h1>
          </div>
        </header>
        {error && <ErrorBanner message={error} />}
        {!done && (
          <section className="owner-card bp-progress" aria-live="polite" data-testid="bp-progress">
            <progress max={run.total} value={finished} aria-label={t("bp.run.title")} />
            <p><strong>{fill(t("bp.run.progress"), { n: finished, total: run.total })}</strong></p>
            <p className="muted">{t("bp.run.keep_going")}</p>
          </section>
        )}
        {done && (
          <section className="owner-card bp-summary" role="status" data-testid="bp-result">
            <ul className="imp-counts">
              <li className="imp-count imp-imported" data-testid="bp-count-published">{fill(t("bp.run.published"), { n: run.counts.published })}</li>
              <li className={`imp-count imp-invalid${run.counts.refused === 0 ? " is-zero" : ""}`} data-testid="bp-count-refused">{fill(t("bp.run.refused"), { n: run.counts.refused })}</li>
              <li className={`imp-count imp-skipped${run.counts.already === 0 ? " is-zero" : ""}`} data-testid="bp-count-already">{fill(t("bp.run.already"), { n: run.counts.already })}</li>
            </ul>
          </section>
        )}
        {by("REFUSED").length > 0 && (
          <section className="imp-part imp-part-rejected" aria-labelledby="bp-refused-title">
            <h2 id="bp-refused-title">{t("bp.run.refused_title")}</h2>
            <ul className="imp-rejects">
              {by("REFUSED").map((i) => (
                <li key={i.draft_id} className="imp-reject" data-testid={`bp-refused-${i.draft_id}`}>
                  <div className="imp-reject-head">
                    <span className="imp-reject-icon" aria-hidden="true"><IconAlert /></span>
                    <strong dir="auto">{i.title}</strong>
                  </div>
                  <ul className="imp-reasons">
                    {[...new Set(i.problems.map((p) => gateReason(t, p.code)))].map((r) => (
                      <li key={r}><span className="imp-reason">{r}</span></li>
                    ))}
                  </ul>
                  <button type="button" className="button-link owner-secondary" onClick={() => review(i.draft_id)}>{t("bp.review")}</button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {(by("PUBLISHED").length > 0 || by("ALREADY").length > 0) && (
          <section className="imp-part" aria-labelledby="bp-pub-title">
            <h2 id="bp-pub-title">{t("bp.run.published_title")}</h2>
            <ul className="imp-rows">
              {[...by("PUBLISHED"), ...by("ALREADY")].map((i) => (
                <li key={i.draft_id} className="imp-row imp-imported" data-testid={`bp-published-${i.draft_id}`}>
                  <span className="imp-row-icon" aria-hidden="true"><IconCheck /></span>
                  <span className="imp-row-main">
                    <strong dir="auto">{i.title}</strong>
                    <span className="imp-row-state">{i.state === "ALREADY" ? t("bp.state.ALREADY") : t("bp.state.PUBLISHED")}</span>
                  </span>
                  {i.offer_id && offerLink(i.offer_id, t("bp.open_product"), `bp-open-${i.draft_id}`)}
                </li>
              ))}
            </ul>
          </section>
        )}
        {done && (
          <div className="imp-actions">
            {by("REFUSED").length > 0 && (
              <button
                type="button"
                className="button owner-primary"
                onClick={() => {
                  const ids = by("REFUSED").map((i) => i.draft_id);
                  keep({ selected: ids, runId: null });
                  setRun(null);
                  void runPreflight(ids);
                }}
                data-testid="bp-retry"
              >
                {t("bp.retry")}
              </button>
            )}
            <button type="button" className="button-link owner-secondary" onClick={closeRun} data-testid="bp-back-to-batch">{t("bp.back_to_batch")}</button>
          </div>
        )}
        {done && run.counts.published > 0 && printList.items.length > 0 && (
          <p className="bp-print-hint" data-testid="bp-print-labels">
            {t("bpb.after_publish")}{" "}
            <button type="button" className="owner-quiet-link" onClick={printLabels}>{fillPos(t("pl.go"), { n: printList.items.length })}</button>
          </p>
        )}
      </div>
    );
  }

  // ---- the preflight: ready / not, before an explicit confirmation ------------------
  if (preflight) {
    const ready = preflight.filter((p) => p.ready);
    const notReady = preflight.filter((p) => !p.ready);
    return (
      <div className={shell} data-testid="bp-preflight">
        <header className="wz-start-head">
          <div className="wz-start-intro">
            <h1 className="page-title" ref={headRef} tabIndex={-1}>{t("bp.pre.title")}</h1>
            <p className="wz-lead">{t("bp.pre.lead")}</p>
          </div>
        </header>
        {error && <ErrorBanner message={error} />}
        <section className="owner-card bp-summary" role="status">
          <ul className="imp-counts">
            <li className="imp-count imp-imported" data-testid="bp-pre-ready">{fill(t("bp.pre.ready"), { n: ready.length })}</li>
            <li className={`imp-count imp-invalid${notReady.length === 0 ? " is-zero" : ""}`} data-testid="bp-pre-not-ready">{fill(t("bp.pre.not_ready"), { n: notReady.length })}</li>
          </ul>
          <div className="imp-head-actions">
            <button type="button" className="button owner-primary" disabled={busy || ready.length === 0} onClick={() => setConfirming(true)} data-testid="bp-confirm">
              {fill(t("bp.pre.publish"), { n: ready.length })}
            </button>
            <button type="button" className="button-link wz-ghost" onClick={() => setPreflight(null)} data-testid="bp-pre-back">{t("bp.back_to_batch")}</button>
          </div>
        </section>
        {notReady.length > 0 && (
          <section className="imp-part imp-part-rejected" aria-labelledby="bp-not-title">
            <h2 id="bp-not-title">{t("bp.pre.not_ready_title")}</h2>
            <ul className="imp-rejects">
              {notReady.map((p) => (
                <li key={p.draft_id} className="imp-reject" data-testid={`bp-not-ready-${p.draft_id}`}>
                  <div className="imp-reject-head">
                    <span className="imp-reject-icon" aria-hidden="true"><IconAlert /></span>
                    <strong dir="auto">{p.title}</strong>
                  </div>
                  <ul className="imp-reasons">
                    {[...new Set(p.problems.map((x) => gateReason(t, x.code)))].map((r) => (
                      <li key={r}><span className="imp-reason">{r}</span></li>
                    ))}
                  </ul>
                  {p.state === "OPEN" && (
                    <button type="button" className="button-link owner-secondary" onClick={() => review(p.draft_id)} data-testid={`bp-review-${p.draft_id}`}>{t("bp.review")}</button>
                  )}
                  {p.state === "PUBLISHED" && p.offer_id && offerLink(p.offer_id, t("bp.open_product"), `bp-open-${p.draft_id}`)}
                </li>
              ))}
            </ul>
          </section>
        )}
        {ready.length > 0 && (
          <details className="imp-part imp-details">
            <summary>{fill(t("bp.pre.ready_list"), { n: ready.length })}</summary>
            <ul className="imp-file-list">
              {ready.map((p) => (
                <li key={p.draft_id} dir="auto">{p.title}</li>
              ))}
            </ul>
          </details>
        )}
        {confirming && (
          <SmallConfirm
            title={fill(t("bp.confirm.title"), { n: ready.length })}
            lead={t("bp.confirm.lead")}
            confirmLabel={fill(t("bp.pre.publish"), { n: ready.length })}
            cancelLabel={t("bp.confirm.cancel")}
            tone="primary"
            busy={busy}
            onConfirm={() => void start()}
            onCancel={() => setConfirming(false)}
          />
        )}
      </div>
    );
  }

  // ---- the batch: its drafts ---------------------------------------------------------
  return (
    <div className={shell} data-testid="import-batch">
      <header className="wz-start-head">
        <div className="wz-start-intro">
          <h1 className="page-title">{t("bp.title")}</h1>
          {batch && (
            <p className="wz-lead" role="status" data-testid="bp-created">
              {fill(t("bp.created"), { n: batch.drafts_total })}
              {batch.counts.published > 0 && <> · {fill(t("bp.published_n"), { n: batch.counts.published })}</>}
            </p>
          )}
          {batch && <p className="muted imp-files" dir="auto">{[batch.file_name, batch.zip_file_name].filter(Boolean).join(" + ")}</p>}
        </div>
      </header>
      {error && <ErrorBanner message={error} />}
      {!batch && !error && <div className="skeleton" style={{ height: 120, maxWidth: 880 }} />}

      {batch && batch.not_created.length > 0 && (
        <details className="imp-part imp-details bp-not-created" data-testid="bp-not-created">
          <summary>{fill(t("bp.not_created"), { n: batch.not_created.length })}</summary>
          <ul className="imp-rejects">
            {batch.not_created.map((p) => (
              <li key={p.ref} className="imp-reject">
                <div className="imp-reject-head">
                  <strong dir="auto">{p.title}</strong>
                  <span className="imp-product-state">{t(`imp.skip.${p.reason}`)}</span>
                </div>
                {p.errors.length > 0 && (
                  <ul className="imp-reasons">
                    {p.errors.map((e, i) => (
                      <li key={i}>
                        <span className="imp-reason">{problemMessage(t, e)}</span>
                        <span className="imp-reason-where">{problemWhere(t, e)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {batch && (
        <section className="wz-drafts bp-drafts" aria-labelledby="bp-drafts-title">
          <div className="imp-part-head">
            <h2 id="bp-drafts-title">{t("bp.drafts")} <span className="wz-start-count">{batch.drafts_total}</span></h2>
          </div>
          {/* the batch's actions, fixed right above its cards */}
          {openIds.length > 0 && (
            <div className="bp-actionbar" role="region" aria-label={t("bp.bar")} data-testid="bp-bar">
              <label className="imp-check-label">
                <input type="checkbox" checked={allSelected} onChange={() => keep({ selected: allSelected ? [] : [...openIds] })} data-testid="bp-select-all" />
                {fill(t("bp.select_all"), { n: openIds.length })}
              </label>
              <span className="bp-actionbar-count" aria-live="polite" data-testid="bp-selected-count">
                <strong>{fill(t("bp.selected_of"), { n: kept.selected.length, total: openIds.length })}</strong>
              </span>
              {kept.selected.length > 0 && (
                <button type="button" className="button-link wz-ghost" onClick={() => keep({ selected: [] })} data-testid="bp-clear">{t("bp.clear")}</button>
              )}
              <span className="bp-actionbar-spacer" />
              <button type="button" className="button owner-secondary" disabled={kept.selected.length === 0} onClick={addSelectedLabels} data-testid="bp-add-labels">
                {t("bp.add_labels")}
              </button>
              <button type="button" className="button owner-primary" disabled={busy || kept.selected.length === 0} aria-busy={busy} onClick={() => void runPreflight(kept.selected)} data-testid="bp-publish-selected">
                {t("bp.publish_selected")}
              </button>
              {labelsToast && (
                <p className="bp-toast" role="status" data-testid="bp-labels-toast">
                  <span aria-hidden="true">✓</span> {fill(t("bp.labels_added"), { n: labelsToast.added })}
                  {labelsToast.missing > 0 && <> {fill(t("bp.labels_missing"), { n: labelsToast.missing })}</>}{" "}
                  <button type="button" className="owner-quiet-link" onClick={printLabels} data-testid="bp-open-print">{t("bp.open_print")}</button>
                  <button type="button" className="bp-toast-close" onClick={() => setLabelsToast(null)} aria-label={t("bp.clear")}>×</button>
                </p>
              )}
            </div>
          )}
          <ul className="wz-draft-list bp-list">
            {batch.items.map((d) => {
              const open = d.state === "OPEN";
              const chosen = selected.has(d.id);
              return (
                <li key={d.id} className={`wz-draft-item bp-card${chosen ? " is-chosen" : ""}${open ? "" : " is-published"}`} data-testid={`bp-card-${d.ref}`} data-state={d.state}>
                  <input
                    type="checkbox"
                    className="bp-check"
                    checked={chosen}
                    disabled={!open}
                    onChange={() => toggle(d.id)}
                    aria-label={fill(t("bp.choose"), { title: d.title })}
                    data-testid={`bp-choose-${d.ref}`}
                  />
                  {d.thumbnail ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={d.thumbnail} alt="" className="wz-draft-thumb" />
                  ) : (
                    <span className="wz-draft-thumb wz-draft-thumb-empty" aria-hidden="true"><IconImage /></span>
                  )}
                  <div className="wz-draft-text">
                    <strong className="wz-draft-name" dir="auto">{d.title}</strong>
                    <span className="wz-draft-meta">
                      <span className={`wz-draft-chip${open ? "" : " bp-chip-published"}`}>{t(`bp.state.${d.state}`)}</span>
                      <span className="wz-draft-chip wz-draft-chip-imported">{t("drafts.imported")}</span>
                      {open && (d.barcode ? (
                        <span className="wz-draft-chip bp-chip-barcode-ok" data-testid={`bp-barcode-${d.ref}`}>{t("bpb.ready")}</span>
                      ) : (
                        <span className="wz-draft-chip bp-chip-barcode-missing" data-testid={`bp-barcode-${d.ref}`}>{t("bpb.missing")}</span>
                      ))}
                    </span>
                    <span className="wz-draft-when">{fill(t("bp.card.counts"), { colors: d.colors, sizes: d.sizes, branches: d.branches, images: d.images })}</span>
                  </div>
                  <div className="wz-draft-actions">
                    {open && (
                      <button type="button" className="button" onClick={() => review(d.id)} data-testid={`bp-review-${d.ref}`}>{t("bp.review")}</button>
                    )}
                    {d.state === "PUBLISHED" && d.offer_id && offerLink(d.offer_id, t("bp.open_product"), `bp-open-${d.ref}`)}
                    <button
                      type="button"
                      className="wz-close bp-eye"
                      onClick={() => details(d.id, d.title)}
                      aria-label={fill(t("bp.details_of"), { title: d.title })}
                      title={fill(t("bp.details_of"), { title: d.title })}
                      data-testid={`bp-details-${d.ref}`}
                    >
                      <IconEye />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          {batch.pages > 1 && (
            <nav className="bp-pages" aria-label={t("bp.pages")}>
              <button type="button" className="button-link owner-secondary" disabled={batch.page <= 1} onClick={() => void load(batch.page - 1)} data-testid="bp-page-prev">{t("bp.page_prev")}</button>
              <span aria-current="page">{fill(t("bp.page_of"), { n: batch.page, total: batch.pages })}</span>
              <button type="button" className="button-link owner-secondary" disabled={batch.page >= batch.pages} onClick={() => void load(batch.page + 1)} data-testid="bp-page-next">{t("bp.page_next")}</button>
            </nav>
          )}
          {onImportAnother && (
            <div className="imp-actions">
              <button type="button" className="button-link wz-ghost" onClick={onImportAnother}>{t("imp.done.again")}</button>
            </div>
          )}
        </section>
      )}

      {localWizard && (
        <ProductWizardPanel
          vendorId={vendorId}
          open={{ draftId: localWizard }}
          onClose={() => {
            setLocalWizard(null);
            void load(kept.page);
          }}
        />
      )}
    </div>
  );
}
