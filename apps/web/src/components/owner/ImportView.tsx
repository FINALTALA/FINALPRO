"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type DragEvent } from "react";
import { IconAlert, IconBack, IconDownload, IconImage, IconSheet, IconUpload } from "@/components/product-wizard/wizardIcons";
import { ErrorBanner } from "@/components/States";
import { BarcodeScanner } from "@/components/pos/BarcodeScanner";
import { BarcodeVisual } from "@/components/pos/BarcodeVisual";
import "@/lib/storePosText";
import { posErrorText } from "@/lib/storePosText";
import { apiFetch, ApiError, authHeadersFor } from "@/lib/api";
import { problemMessage, problemWhere, useAuthedImage, type ImportProblem as Problem } from "@/lib/importProblems";
import "@/lib/importText";
import "@/lib/batchText";
import { getSessionToken } from "@/lib/session";
import { loginRedirectHref } from "@/lib/loginRedirect";
import { fill } from "@/lib/offerWizardText";
import { useLang, useT } from "@/lib/useLang";
import { ImportBatchView } from "./ImportBatchView";

const MAX_FILE_BYTES = 5 * 1024 * 1024; // the API's MAX_IMPORT_FILE_BYTES
const MAX_ZIP_BYTES = 150 * 1024 * 1024; // the API's MAX_ZIP_BYTES
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api/v1";

interface CheckedProduct {
  ref: string;
  title: string;
  /** needs_barcode: complete apart from its barcode - fixed here, before any draft */
  status: "ready" | "needs_barcode" | "rejected";
  barcode: { code: string; display_code: string; format: "EAN13" | "EAN8" | "UPCA" | "CODE128"; source: "EXTERNAL" | "GENERATED" } | null;
  barcode_problems: Problem[];
  colors: number;
  versions: number;
  branches: number;
  errors: Problem[];
  warnings: Problem[];
  images: number;
  image_colors: { name: string; count: number }[];
  shared_images: number;
  duplicate_of: { kind: "product" | "draft" | "file"; id: string | null; title: string } | null;
  selectable: boolean;
  selected_by_default: boolean;
}
interface ZipSummary {
  file_name: string;
  bytes: number;
  staged: number;
  unused: string[];
  unused_count: number;
  ignored: string[];
  ignored_count: number;
}
interface CheckDto {
  batch_id: string;
  file_name: string;
  file_sha256: string;
  expires_at: string;
  same_file: { batch_id: string; at: string } | null;
  file_problems: Problem[];
  zip: ZipSummary | null;
  products: CheckedProduct[];
}
interface ConfirmDto {
  batch_id: string;
  created: { ref: string; title: string; draft_id: string }[];
}
interface BatchRow {
  id: string;
  file_name: string;
  status: string;
  products: number;
  drafts_created: number | null;
  created_at: string;
}

const UPLOAD_ERRORS = ["IMPORT_XLSX_ONLY", "IMPORT_XLSX_TOO_LARGE", "IMPORT_ZIP_REQUIRED", "IMPORT_ZIP_ONLY", "IMPORT_ZIP_TOO_LARGE", "PAYLOAD_TOO_LARGE"];

/** The check request, with the upload's progress (a 150 MB ZIP takes a while on a phone). */
function postCheck(vendorId: string, form: FormData, onProgress: (percent: number) => void): Promise<CheckDto> {
  const path = `/vendors/${vendorId}/product-import/check`;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE_URL}${path}`);
    for (const [k, v] of Object.entries(authHeadersFor(path) as Record<string, string>)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.upload.onload = () => onProgress(100);
    xhr.onerror = () => reject(new ApiError(0, "NETWORK_ERROR", ""));
    xhr.onload = () => {
      let body: { error?: { code?: string; message?: string } } & Partial<CheckDto> = {};
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch {
        // not JSON (a proxy's page): handled by the status below
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as CheckDto);
      else reject(new ApiError(xhr.status, xhr.status === 413 ? "PAYLOAD_TOO_LARGE" : (body?.error?.code ?? "UNKNOWN_ERROR"), body?.error?.message ?? ""));
    };
    xhr.send(form);
  });
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0);

/** A ready product's main image, from the check's private staging (never a public URL). */
function StagedThumb({ vendorId, batchId, product }: { vendorId: string; batchId: string; product: CheckedProduct }) {
  const t = useT();
  const url = useAuthedImage(product.status !== "rejected" ? `/vendors/${vendorId}/product-import/${batchId}/thumbnails/${encodeURIComponent(product.ref)}` : null);
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt={fill(t("imp.thumb_alt"), { title: product.title })} className="imp-thumb" data-testid={`import-thumb-${product.ref}`} />
  ) : (
    <span className="imp-thumb imp-thumb-empty" aria-hidden="true"><IconImage /></span>
  );
}

/**
 * «استيراد منتجات من ملف» (2026-11-18, images in bulk): the store's XLSX
 * template + one ZIP of the products' images -> a check that creates
 * nothing (the images wait privately) -> a result in separate parts: a
 * short head (the files, «لم يُنشأ شيء بعد», the counts, ONE action), the
 * ready products (chosen by default), the possible duplicates (not chosen
 * until included), the rejected ones (never choosable, each problem in
 * plain words) and the notes on the file and its images -> the chosen
 * products become complete unpublished drafts, and the batch's own screen
 * opens (in the management window: as its next screen).
 */
export function ImportView({
  vendorId,
  embedded = false,
  onOpenDraft,
  onBatchCreated,
}: {
  vendorId: string;
  embedded?: boolean;
  /** In the management window: open a draft in the wizard there. */
  onOpenDraft?: (draftId: string) => void;
  /** In the management window: the batch's screen opens as the window's next screen. */
  onBatchCreated?: (batchId: string) => void;
  /** (kept for callers of the older screen) */
  onOpenProduct?: (offerId: string) => void;
}) {
  const router = useRouter();
  const t = useT();
  const lang = useLang();
  const [file, setFile] = useState<File | null>(null);
  const [zip, setZip] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<CheckDto | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [includeDup, setIncludeDup] = useState<Set<string>>(new Set());
  const [again, setAgain] = useState(false);
  // the products that needed a barcode at the check: they stay in their part once fixed
  const [fixRefs, setFixRefs] = useState<string[]>([]);
  const [genPick, setGenPick] = useState<Set<string>>(new Set());
  const [genBusy, setGenBusy] = useState(false);
  const [genDone, setGenDone] = useState<number | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [doneBatch, setDoneBatch] = useState<string | null>(null);
  const [history, setHistory] = useState<BatchRow[] | null>(null);

  useEffect(() => {
    if (!getSessionToken()) {
      router.replace(loginRedirectHref());
      return;
    }
    apiFetch<BatchRow[]>(`/vendors/${vendorId}/product-import/batches`)
      .then(setHistory)
      .catch(() => setHistory([]));
  }, [vendorId, router, doneBatch]);

  async function downloadTemplate() {
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/vendors/${vendorId}/product-import/template?lang=${lang}`, {
        headers: authHeadersFor(`/vendors/${vendorId}/product-import/template`),
      });
      if (!res.ok) throw new Error(String(res.status));
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = lang === "en" ? "products-import-template.xlsx" : "قالب-استيراد-المنتجات.xlsx";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError(t("imp.template_failed"));
    }
  }

  /** Files dropped or chosen: the .xlsx and the .zip, in any order, together or one by one. */
  function pick(list: FileList | File[] | null) {
    const files = [...(list ?? [])];
    if (files.length === 0) return;
    for (const f of files) {
      if (/\.xlsx$/i.test(f.name)) {
        if (f.size > MAX_FILE_BYTES) return setError(t("imp.drop.too_big"));
      } else if (/\.zip$/i.test(f.name)) {
        if (f.size > MAX_ZIP_BYTES) return setError(t("imp.drop.zip_too_big"));
      } else return setError(t("imp.drop.bad_type"));
    }
    setError(null);
    for (const f of files) {
      if (/\.xlsx$/i.test(f.name)) setFile(f);
      else setZip(f);
    }
  }

  async function check() {
    if (!file) return setError(t("imp.drop.none"));
    if (!zip) return setError(t("imp.drop.no_zip"));
    setBusy(true);
    setError(null);
    setProgress(0);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("images", zip);
      const r = await postCheck(vendorId, form, setProgress);
      setChecked(r);
      setChosen(new Set(r.products.filter((p) => p.selected_by_default).map((p) => p.ref)));
      setIncludeDup(new Set());
      setAgain(false);
      const needs = r.products.filter((p) => p.status === "needs_barcode").map((p) => p.ref);
      setFixRefs(needs);
      setGenPick(new Set(needs));
      setGenDone(null);
      setRowError({});
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setError(UPLOAD_ERRORS.includes(code) ? t(`imp.upload.${code}`) : err instanceof ApiError && err.message ? err.message : t("imp.check_failed"));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  // the kinds of products, each in its own part of the result: the ones that
  // needed a barcode stay in their part once fixed (a card does not jump away)
  const fixSet = new Set(fixRefs);
  const needing = checked?.products.filter((p) => fixSet.has(p.ref)) ?? [];
  const ready = checked?.products.filter((p) => p.selectable && !p.duplicate_of && !fixSet.has(p.ref)) ?? [];
  const duplicates = checked?.products.filter((p) => p.selectable && p.duplicate_of && !fixSet.has(p.ref)) ?? [];
  const rejected = checked?.products.filter((p) => p.status === "rejected") ?? [];
  const stillNeeding = needing.filter((p) => p.status === "needs_barcode");
  const genTargets = stillNeeding.filter((p) => genPick.has(p.ref));
  const readyNow = checked?.products.filter((p) => p.status === "ready" && !p.duplicate_of).length ?? 0;
  const needsNow = stillNeeding.length;
  // only what is ticked and ready: a ready product chosen, a possible duplicate explicitly included
  const creatable = checked?.products.filter((p) => p.status === "ready") ?? [];
  const toCreate = [...creatable.filter((p) => !p.duplicate_of && chosen.has(p.ref)).map((p) => p.ref), ...creatable.filter((p) => p.duplicate_of && includeDup.has(p.ref)).map((p) => p.ref)];

  /** A fixed product: shown in its card, and chosen for its draft (a possible duplicate stays a decision). */
  function applyFixed(updated: CheckedProduct[]) {
    setChecked((c) => (c ? { ...c, products: c.products.map((p) => updated.find((u) => u.ref === p.ref) ?? p) } : c));
    setChosen((s) => {
      const n = new Set(s);
      for (const u of updated) if (u.status === "ready" && !u.duplicate_of) n.add(u.ref);
      return n;
    });
  }

  async function saveBarcode(ref: string, code: string) {
    if (!checked) return;
    setRowBusy(ref);
    setRowError((e) => ({ ...e, [ref]: "" }));
    try {
      const u = await apiFetch<CheckedProduct>(`/vendors/${vendorId}/product-import/${checked.batch_id}/products/${encodeURIComponent(ref)}/barcode`, { method: "PUT", body: { code } });
      applyFixed([u]);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setRowError((e) => ({ ...e, [ref]: code === "IMPORT_EXPIRED" ? t("imp.expired") : posErrorText(err, lang) }));
    } finally {
      setRowBusy(null);
    }
  }

  async function generate() {
    if (!checked || genTargets.length === 0) return;
    setGenBusy(true);
    setError(null);
    try {
      const r = await apiFetch<{ products: CheckedProduct[] }>(`/vendors/${vendorId}/product-import/${checked.batch_id}/barcodes/generate`, { method: "POST", body: { refs: genTargets.map((p) => p.ref) } });
      applyFixed(r.products);
      setGenDone(r.products.length);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setError(code === "IMPORT_EXPIRED" ? t("imp.expired") : posErrorText(err, lang));
    } finally {
      setGenBusy(false);
    }
  }
  const blockedBySameFile = Boolean(checked?.same_file) && !again;
  const allChosen = ready.length > 0 && ready.every((p) => chosen.has(p.ref));

  async function confirm() {
    if (!checked || toCreate.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch<ConfirmDto>(`/vendors/${vendorId}/product-import/${checked.batch_id}/confirm`, {
        method: "POST",
        body: {
          refs: toCreate,
          include_duplicates: creatable.filter((p) => p.duplicate_of && includeDup.has(p.ref)).map((p) => p.ref),
          reimport_same_file: again,
          expected_sha256: checked.file_sha256,
        },
      });
      setChecked(null);
      setFile(null);
      setZip(null);
      if (onBatchCreated) onBatchCreated(r.batch_id);
      else setDoneBatch(r.batch_id);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setError(code === "IMPORT_EXPIRED" ? t("imp.expired") : code === "IMPORT_STALE" ? t("imp.stale") : err instanceof ApiError && err.message ? err.message : t("imp.failed"));
    } finally {
      setBusy(false);
    }
  }

  const when = (iso: string) => new Date(iso).toLocaleString(lang === "en" ? "en-GB" : "ar", { dateStyle: "medium", timeStyle: "short" });
  const toggle = (set: Set<string>, ref: string) => {
    const n = new Set(set);
    if (n.has(ref)) n.delete(ref);
    else n.add(ref);
    return n;
  };

  // standalone page: the batch's screen in place of the import (in the window it is the next screen)
  if (doneBatch) {
    return (
      <ImportBatchView
        vendorId={vendorId}
        batchId={doneBatch}
        embedded={embedded}
        onReview={onOpenDraft}
        onImportAnother={() => setDoneBatch(null)}
      />
    );
  }

  const productHead = (p: CheckedProduct) => (
    <span className="imp-product-text">
      <strong dir="auto">{p.title}</strong>
      <span className="muted">{fill(t("imp.summary"), { colors: p.colors, versions: p.versions, branches: p.branches, images: p.images })}</span>
      <span className="imp-images" data-testid={`import-images-${p.ref}`}>
        {[...p.image_colors.map((c) => fill(t("imp.images.color"), { name: c.name, n: c.count })), ...(p.shared_images ? [fill(t("imp.images.shared"), { n: p.shared_images })] : [])].join(" · ")}
      </span>
    </span>
  );
  const notes = (p: CheckedProduct) =>
    p.warnings.length > 0 && (
      <ul className="imp-notes-list">
        {p.warnings.map((w, i) => (
          <li key={i}>{problemMessage(t, w)}</li>
        ))}
      </ul>
    );

  return (
    <div className={embedded ? "owner-catalog owner-import owner-embedded" : "page-shell wz-start owner-catalog owner-import"} data-testid="import-view">
      {!embedded && (
        <nav className="owner-details-back" aria-label={t("details.breadcrumb")}>
          <Link href={`/vendor/${vendorId}/offers`} className="owner-quiet-link">
            <IconBack /> {t("imp.back")}
          </Link>
        </nav>
      )}
      {!checked && (
        <header className="wz-start-head">
          <div className="wz-start-intro">
            <h1 className="page-title">{t("imp.title")}</h1>
            <p className="wz-lead">{t("imp.lead")}</p>
          </div>
        </header>
      )}
      {error && <ErrorBanner message={error} />}

      {/* the check's result: nothing created yet - a fixed head with the one action, then one part per kind */}
      {checked && (
        <div className="imp-result-parts" data-testid="import-check">
          {/* a compact fixed strip: what was checked, the counts and the ONE action - never a panel over the cards */}
          <section className="imp-check-head imp-check-sticky" aria-labelledby="imp-check-title">
            <p className="visually-hidden" role="status">{t("imp.result.title")}</p>
            <div className="imp-check-row imp-check-row1">
              <h1 id="imp-check-title" className="imp-check-title">{t("imp.result.title")}</h1>
              <p className="imp-files" dir="auto">
                <IconSheet size={16} /> <span>{checked.file_name}</span>
                {checked.zip && (
                  <>
                    <IconImage /> <span>{checked.zip.file_name}</span>
                  </>
                )}
              </p>
              <span className="imp-nothing-yet">{t("imp.result.nothing_yet")}</span>
            </div>
            <div className="imp-check-row imp-check-row2">
              <ul className="imp-counts" aria-label={t("imp.counts")}>
                <li className="imp-count imp-imported" data-testid="import-count-ready">{fill(t("imp.count.ready"), { n: readyNow })}</li>
                <li className={`imp-count imp-barcode${needsNow === 0 ? " is-zero" : ""}`} data-testid="import-count-barcode">{fill(t("imp.count.barcode"), { n: needsNow })}</li>
                <li className={`imp-count imp-invalid${rejected.length === 0 ? " is-zero" : ""}`} data-testid="import-count-rejected">{fill(t("imp.count.rejected"), { n: rejected.length })}</li>
                {duplicates.length > 0 && (
                  <li className="imp-count imp-skipped" data-testid="import-count-duplicates">{fill(t("imp.count.duplicate"), { n: duplicates.length })}</li>
                )}
              </ul>
              <div className="imp-head-actions">
                <button type="button" className="button owner-primary" onClick={() => void confirm()} disabled={busy || toCreate.length === 0 || blockedBySameFile} aria-busy={busy} aria-describedby={blockedBySameFile ? "imp-same-hint" : undefined} data-testid="import-create">
                  {busy ? t("imp.creating") : fill(t("imp.create"), { n: toCreate.length })}
                </button>
                <button type="button" className="button-link wz-ghost" onClick={() => setChecked(null)} disabled={busy}>{t("imp.cancel")}</button>
              </div>
            </div>
          </section>
          {blockedBySameFile && <p id="imp-same-hint" className="imp-hint imp-check-hint">{t("imp.same_file_hint")}</p>}
          {needsNow > 0 && <p className="imp-hint imp-check-hint" data-testid="import-barcode-hint">{fill(t("imp.barcode.hint"), { n: needsNow })}</p>}

          {needing.length > 0 && (
            <section className="imp-part imp-part-barcode" aria-labelledby="imp-bc-title" data-testid="import-section-barcode">
              <div className="imp-part-head">
                <h2 id="imp-bc-title">{t("imp.part.barcode")} <span className="wz-start-count">{needing.length}</span></h2>
              </div>
              <p className="muted imp-part-lead">{t("imp.part.barcode_lead")}</p>
              {stillNeeding.length > 0 ? (
                <div className="imp-bc-bulk">
                  <label className="imp-check-label">
                    <input
                      type="checkbox"
                      checked={stillNeeding.length > 0 && stillNeeding.every((p) => genPick.has(p.ref))}
                      disabled={stillNeeding.length === 0}
                      onChange={(e) => setGenPick(e.target.checked ? new Set(stillNeeding.map((p) => p.ref)) : new Set())}
                      data-testid="import-barcode-pick-all"
                    />
                    {t("imp.barcode.pick_all")}
                  </label>
                  <button type="button" className="button owner-secondary imp-bc-generate" disabled={genBusy || genTargets.length === 0} aria-busy={genBusy} onClick={() => void generate()} data-testid="import-barcode-generate">
                    {fill(t("imp.barcode.generate"), { n: genTargets.length })}
                  </button>
                </div>
              ) : null}
              {genDone !== null && <p className="pos-inline-notice" role="status" data-testid="import-barcode-generated">{fill(t("imp.barcode.generated"), { n: genDone })}</p>}
              <ul className="imp-products imp-bc-list">
                {needing.map((p) => {
                  const fixed = p.status === "ready";
                  const isDup = Boolean(p.duplicate_of);
                  return (
                    <li key={p.ref} className={`imp-product imp-bc-card${fixed ? " is-fixed" : ""}`} data-testid={`import-product-${p.ref}`} data-state={p.status}>
                      <div className="imp-product-card">
                        {fixed ? (
                          isDup ? (
                            <input type="checkbox" checked={includeDup.has(p.ref)} onChange={() => setIncludeDup((s) => toggle(s, p.ref))} aria-label={fill(t("imp.choose"), { title: p.title })} data-testid={`import-include-${p.ref}`} />
                          ) : (
                            <input type="checkbox" checked={chosen.has(p.ref)} onChange={() => setChosen((s) => toggle(s, p.ref))} aria-label={fill(t("imp.choose"), { title: p.title })} data-testid={`import-choose-${p.ref}`} />
                          )
                        ) : (
                          <input
                            type="checkbox"
                            checked={genPick.has(p.ref)}
                            onChange={() => setGenPick((s) => toggle(s, p.ref))}
                            aria-label={fill(t("imp.barcode.pick"), { title: p.title })}
                            data-testid={`import-barcode-pick-${p.ref}`}
                          />
                        )}
                        <StagedThumb vendorId={vendorId} batchId={checked.batch_id} product={p} />
                        {productHead(p)}
                        <span className={`imp-product-state ${fixed ? "imp-state-ready" : "imp-state-barcode"}`}>{fixed ? t("imp.status.ready_short") : t("imp.status.barcode")}</span>
                      </div>
                      {fixed && p.barcode ? (
                        <div className="imp-bc-done" data-testid={`import-barcode-ok-${p.ref}`}>
                          <BarcodeVisual code={p.barcode.display_code} format={p.barcode.format} height={34} className="pos-barcode-mini" />
                          <span className="pos-tag pos-tag-sand">{t(`bc.source.${p.barcode.source}`)}</span>
                        </div>
                      ) : (
                        <div className="imp-bc-fix">
                          <ul className="imp-reasons">
                            {(p.barcode_problems ?? []).map((e, i) => (
                              <li key={i}><span className="imp-reason" data-testid={`import-barcode-reason-${p.ref}`}>{problemMessage(t, e)}</span></li>
                            ))}
                          </ul>
                          <BarcodeScanner
                            id={`imp-bc-${p.ref}`}
                            label={t("imp.barcode.field")}
                            submitLabel={t("imp.barcode.save")}
                            busy={rowBusy === p.ref}
                            keepValue
                            testId={`import-barcode-input-${p.ref}`}
                            onSubmit={(code) => void saveBarcode(p.ref, code)}
                          />
                          {rowError[p.ref] && <p className="pos-inline-error" role="alert" data-testid={`import-barcode-error-${p.ref}`}>{rowError[p.ref]}</p>}
                        </div>
                      )}
                      {isDup && <p className="imp-duplicate">{fill(t("imp.duplicate"), { kind: t(`imp.duplicate.${p.duplicate_of!.kind}`), title: p.duplicate_of!.title })}</p>}
                      {notes(p)}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {ready.length > 0 && (
            <section className="imp-part" aria-labelledby="imp-ready-title" data-testid="import-section-ready">
              <div className="imp-part-head">
                <h2 id="imp-ready-title">{t("imp.part.ready")} <span className="wz-start-count">{ready.length}</span></h2>
                <label className="imp-check-label">
                  <input type="checkbox" checked={allChosen} onChange={() => setChosen(allChosen ? new Set() : new Set(ready.map((p) => p.ref)))} data-testid="import-select-all" />
                  {t("imp.select_all")}
                </label>
              </div>
              <ul className="imp-products">
                {ready.map((p) => (
                  <li key={p.ref} className={`imp-product imp-product-ready${chosen.has(p.ref) ? " is-chosen" : ""}`} data-testid={`import-product-${p.ref}`}>
                    <label className="imp-product-card">
                      <input type="checkbox" checked={chosen.has(p.ref)} onChange={() => setChosen((s) => toggle(s, p.ref))} aria-label={fill(t("imp.choose"), { title: p.title })} data-testid={`import-choose-${p.ref}`} />
                      <StagedThumb vendorId={vendorId} batchId={checked.batch_id} product={p} />
                      {productHead(p)}
                      {p.barcode && (
                        <span className="imp-bc-chip" data-testid={`import-barcode-chip-${p.ref}`}>
                          <span className="visually-hidden">{t("imp.barcode.chip")}</span>
                          <span dir="ltr" className="pos-code-number">{p.barcode.display_code}</span>
                        </span>
                      )}
                    </label>
                    {notes(p)}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {duplicates.length > 0 && (
            <section className="imp-part" aria-labelledby="imp-dup-title" data-testid="import-section-duplicates">
              <div className="imp-part-head">
                <h2 id="imp-dup-title">{t("imp.part.duplicates")} <span className="wz-start-count">{duplicates.length}</span></h2>
              </div>
              <p className="muted imp-part-lead">{t("imp.part.duplicates_lead")}</p>
              <ul className="imp-products">
                {duplicates.map((p) => (
                  <li key={p.ref} className={`imp-product imp-product-duplicate${includeDup.has(p.ref) ? " is-chosen" : ""}`} data-testid={`import-product-${p.ref}`}>
                    <div className="imp-product-card">
                      <StagedThumb vendorId={vendorId} batchId={checked.batch_id} product={p} />
                      {productHead(p)}
                    </div>
                    <div className="imp-duplicate">
                      <span>{fill(t("imp.duplicate"), { kind: t(`imp.duplicate.${p.duplicate_of!.kind}`), title: p.duplicate_of!.title })}</span>
                      <label className="imp-check-label">
                        <input type="checkbox" checked={includeDup.has(p.ref)} onChange={() => setIncludeDup((s) => toggle(s, p.ref))} data-testid={`import-include-${p.ref}`} /> {t("imp.include_duplicate")}
                      </label>
                    </div>
                    {notes(p)}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {rejected.length > 0 && (
            <section className="imp-part imp-part-rejected" aria-labelledby="imp-rej-title" data-testid="import-section-rejected">
              <div className="imp-part-head">
                <h2 id="imp-rej-title">{t("imp.part.rejected")} <span className="wz-start-count">{rejected.length}</span></h2>
              </div>
              <p className="muted imp-part-lead">{t("imp.part.rejected_lead")}</p>
              <ul className="imp-rejects">
                {rejected.map((p) => (
                  <li key={p.ref} className="imp-reject" data-testid={`import-product-${p.ref}`}>
                    <div className="imp-reject-head">
                      <span className="imp-reject-icon" aria-hidden="true"><IconAlert /></span>
                      <strong dir="auto">{p.title}</strong>
                      <span className="imp-product-state imp-state-rejected">{t("imp.status.rejected")}</span>
                    </div>
                    <ul className="imp-reasons">
                      {p.errors.map((e, i) => (
                        <li key={i}>
                          <span className="imp-reason">{problemMessage(t, e)}</span>
                          <span className="imp-reason-where">{problemWhere(t, e)}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="imp-part imp-part-notes" aria-labelledby="imp-notes-title" data-testid="import-notes">
            <h2 id="imp-notes-title">{t("imp.part.notes")}</h2>
            {checked.same_file && (
              <div className="imp-same-file" data-testid="import-same-file">
                <p><IconAlert /> <span>{fill(t("imp.same_file"), { when: when(checked.same_file.at) })}</span></p>
                <label className="imp-check-label">
                  <input type="checkbox" checked={again} onChange={(e) => setAgain(e.target.checked)} data-testid="import-again" /> {t("imp.same_file_again")}
                </label>
              </div>
            )}
            {checked.zip && (
              <p className="imp-note" data-testid="import-zip-summary">
                <IconImage /> <span>{fill(t("imp.zip.summary"), { n: checked.zip.staged, zip: checked.zip.file_name, size: mb(checked.zip.bytes) })}</span>
              </p>
            )}
            {checked.zip && checked.zip.unused_count > 0 && (
              <details className="imp-details imp-note" data-testid="import-unused">
                <summary>{fill(t("imp.zip.unused"), { n: checked.zip.unused_count })}</summary>
                <ul className="imp-file-list">
                  {checked.zip.unused.map((n) => (
                    <li key={n} dir="ltr">{n}</li>
                  ))}
                  {checked.zip.unused_count > checked.zip.unused.length && <li>{fill(t("imp.zip.more"), { n: checked.zip.unused_count - checked.zip.unused.length })}</li>}
                </ul>
              </details>
            )}
            {checked.zip && checked.zip.ignored_count > 0 && (
              <p className="imp-note muted" data-testid="import-ignored">{fill(t("imp.zip.ignored"), { n: checked.zip.ignored_count })}</p>
            )}
            {checked.file_problems.length > 0 && (
              <details className="imp-details imp-note" open={checked.products.length === 0 || checked.file_problems.some((p) => p.sheet === "zip")} data-testid="import-file-problems">
                <summary>{fill(t("imp.file_problems_n"), { n: checked.file_problems.length })}</summary>
                <ul className="imp-reasons">
                  {checked.file_problems.map((p, i) => (
                    <li key={i}>
                      <span className="imp-reason">{problemMessage(t, p)}</span>
                      <span className="imp-reason-where">{problemWhere(t, p)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {!checked.same_file && !checked.zip?.unused_count && !checked.zip?.ignored_count && checked.file_problems.length === 0 && <p className="muted">{t("imp.notes.none")}</p>}
          </section>
        </div>
      )}

      {!checked && (
        <ol className="imp-steps" aria-label={t("imp.steps")}>
          <li className="imp-step">
            <span className="imp-step-n" aria-hidden="true">1</span>
            <div className="imp-step-body">
              <h2>{t("imp.step1.title")}</h2>
              <p className="muted">{t("imp.step1.text")}</p>
              <button type="button" className="button-link owner-secondary" onClick={() => void downloadTemplate()} data-testid="import-template">
                <IconDownload /> {t("imp.template")}
              </button>
            </div>
          </li>
          <li className="imp-step">
            <span className="imp-step-n" aria-hidden="true">2</span>
            <div className="imp-step-body">
              <h2>{t("imp.step2.title")}</h2>
              <p className="muted">{t("imp.step2.text")}</p>
            </div>
          </li>
          <li className="imp-step">
            <span className="imp-step-n" aria-hidden="true">3</span>
            <div className="imp-step-body">
              <h2>{t("imp.step3.title")}</h2>
              <p className="muted">{t("imp.step3.text")}</p>
              <label
                className={`imp-drop${dragging ? " is-dragging" : ""}${file || zip ? " has-file" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e: DragEvent<HTMLElement>) => {
                  e.preventDefault();
                  setDragging(false);
                  pick(e.dataTransfer.files ?? null);
                }}
                data-testid="import-drop"
              >
                <input
                  type="file"
                  multiple
                  accept=".xlsx,.zip,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/zip"
                  className="imp-file-input"
                  onChange={(e) => {
                    pick(e.target.files);
                    e.target.value = "";
                  }}
                />
                <span className="imp-drop-icon" aria-hidden="true"><IconUpload /></span>
                <span className="imp-drop-text">
                  <strong>{t("imp.drop.title")}</strong>
                  <span className="imp-drop-choose">{t("imp.drop.choose")}</span>
                  <span className="muted">{t("imp.drop.formats")}</span>
                </span>
              </label>
              <ul className="imp-chosen" aria-label={t("imp.drop.chosen")}>
                <li className={file ? "is-set" : ""} data-testid="import-file-xlsx">
                  <IconSheet size={20} />
                  <span dir="auto">{file ? `${file.name} · ${mb(file.size)} MB` : t("imp.drop.need_xlsx")}</span>
                </li>
                <li className={zip ? "is-set" : ""} data-testid="import-file-zip">
                  <IconImage />
                  <span dir="auto">{zip ? `${zip.name} · ${mb(zip.size)} MB` : t("imp.drop.need_zip")}</span>
                </li>
              </ul>
              {progress !== null && (
                <div className="imp-progress" data-testid="import-progress">
                  <progress max={100} value={progress} aria-label={t("imp.uploading")} />
                  <span>{progress < 100 ? fill(t("imp.uploading_n"), { n: progress }) : t("imp.checking_images")}</span>
                </div>
              )}
              <div className="imp-actions">
                <button type="button" className="button owner-primary" onClick={() => void check()} disabled={busy || !file || !zip} aria-busy={busy} data-testid="import-check-button">
                  <IconUpload /> {busy ? t("imp.checking") : t("imp.check")}
                </button>
              </div>
            </div>
          </li>
        </ol>
      )}

      {!checked && (
        <details className="imp-limits" data-testid="import-limits">
          <summary>
            <IconAlert /> {t("imp.limits")}
          </summary>
          <p>{t("imp.limits.text")}</p>
          <p>{t("imp.limits.text2")}</p>
        </details>
      )}

      {!checked && (
        <section className="owner-card imp-history" aria-labelledby="imp-history">
          <h2 id="imp-history">{t("imp.history")}</h2>
          {history && history.length === 0 && <p className="muted">{t("imp.history.none")}</p>}
          {history && history.length > 0 && (
            <ul className="imp-history-list">
              {history.map((b) => (
                <li key={b.id}>
                  <span dir="auto">{fill(t("imp.history.row"), { file: b.file_name, n: b.products, created: b.drafts_created ?? 0 })}</span>
                  <span className={`imp-batch imp-batch-${b.status.toLowerCase()}`}>{t(`imp.hstatus.${b.status}`) !== `imp.hstatus.${b.status}` ? t(`imp.hstatus.${b.status}`) : b.status}</span>
                  <span className="muted">{when(b.created_at)}</span>
                  {b.status === "CONFIRMED" && (
                    <button type="button" className="owner-quiet-link" onClick={() => (onBatchCreated ? onBatchCreated(b.id) : setDoneBatch(b.id))} data-testid={`import-history-open-${b.id}`}>
                      {t("imp.history.open")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
