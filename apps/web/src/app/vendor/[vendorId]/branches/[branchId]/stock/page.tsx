"use client";

import JsBarcode from "jsbarcode";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { useHydrated, useSessionToken, useWorkspaces } from "@/lib/useSession";

interface StockRowDto {
  id: string | null;
  vendor_id: string;
  branch_id: string;
  offer_variant_id: string;
  offer_title_ar: string;
  offer_title_en: string;
  seller_sku: string;
  colour: string | null;
  size: string | null;
  store_inventory_barcode: string;
  quantity: number;
  reserved_quantity: number;
  available_quantity: number;
  safety_stock_threshold: number;
  last_physical_count_at: string | null;
  is_low_stock: boolean;
  is_stale: boolean;
}

interface StockPageDto {
  items: StockRowDto[];
  next_cursor: string | null;
}

const MOVEMENT_REASONS = [
  { value: "SALE", label: "بيع" },
  { value: "DAMAGE", label: "تلف" },
  { value: "LOSS", label: "فقدان" },
  { value: "COUNT_CORRECTION", label: "تصحيح جرد" },
] as const;

interface MovementDraft {
  reason: string;
  delta: string;
  note: string;
}

function variantLabel(row: StockRowDto): string {
  const sub = [row.colour, row.size].filter(Boolean).join(" / ");
  return sub ? `${row.offer_title_ar} — ${sub}` : row.offer_title_ar;
}

function formatCountedAt(iso: string | null): string {
  if (!iso) return "لم يُجرَ جرد فعلي من قبل";
  return new Date(iso).toLocaleString("ar");
}

// Sprint 18a: the owner/employee-facing branch stock page - lists via
// the paginated, display-ready GET .../stock/page (never the old bare
// GET .../stock, which stays untouched for whatever already depends on
// its shape), and wires up every S18a action: a movement (including
// SALE), a dedicated physical-count confirmation, an owner-only safety-
// stock threshold, and a barcode lookup. Code128 label rendering/
// printing uses a single shared hidden canvas, drawn on demand per
// "طباعة الملصق" click rather than one canvas per row.
export default function BranchStockPage() {
  const params = useParams<{ vendorId: string; branchId: string }>();
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const workspaces = useWorkspaces(token);
  const membership = workspaces?.find(
    (w) => w.type === "vendor" && w.vendor_id === params.vendorId,
  );
  const isMember = membership?.type === "vendor";
  const isOwner = membership?.type === "vendor" && membership.role === "OWNER";
  const branchMismatch =
    membership?.type === "vendor" &&
    membership.role === "BRANCH_EMPLOYEE" &&
    membership.branch_id !== params.branchId;

  const [items, setItems] = useState<StockRowDto[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [movementDrafts, setMovementDrafts] = useState<Record<string, MovementDraft>>({});
  const [thresholdDrafts, setThresholdDrafts] = useState<Record<string, string>>({});
  const [countNoteDrafts, setCountNoteDrafts] = useState<Record<string, string>>({});

  const [barcodeQuery, setBarcodeQuery] = useState("");
  const [lookupResult, setLookupResult] = useState<StockRowDto | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);

  const printCanvasRef = useRef<HTMLCanvasElement>(null);

  function load(cursor?: string, append = false) {
    const qs = cursor ? `?limit=20&cursor=${encodeURIComponent(cursor)}` : "?limit=20";
    apiFetch<StockPageDto>(
      `/vendors/${params.vendorId}/branches/${params.branchId}/stock/page${qs}`,
    )
      .then((page) => {
        setError(null);
        setItems((prev) => (append && prev ? [...prev, ...page.items] : page.items));
        setNextCursor(page.next_cursor);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) {
          setForbidden(true);
          return;
        }
        setError(err instanceof ApiError ? err.message : "تعذّر تحميل المخزون");
      })
      .finally(() => setLoadingMore(false));
  }

  function reload() {
    setItems(null);
    setNextCursor(null);
    load();
  }

  useEffect(() => {
    if (!hydrated) return;
    if (!token) {
      router.replace(
        `/login?next=/vendor/${params.vendorId}/branches/${params.branchId}/stock`,
      );
      return;
    }
    if (!isMember || branchMismatch) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, token, isMember, branchMismatch, params.vendorId, params.branchId]);

  function draftFor(row: StockRowDto): MovementDraft {
    return movementDrafts[row.offer_variant_id] ?? { reason: "SALE", delta: "", note: "" };
  }

  function patchDraft(variantId: string, patch: Partial<MovementDraft>) {
    setMovementDrafts((prev) => ({
      ...prev,
      [variantId]: { ...(prev[variantId] ?? { reason: "SALE", delta: "", note: "" }), ...patch },
    }));
  }

  async function submitMovement(row: StockRowDto) {
    const draft = draftFor(row);
    const delta = Number(draft.delta);
    if (!draft.note.trim()) {
      setError("سبب الحركة مطلوب");
      return;
    }
    if (!Number.isInteger(delta) || delta === 0) {
      setError("الكمية يجب أن تكون عدداً صحيحاً غير صفري");
      return;
    }
    setBusyId(row.offer_variant_id);
    setError(null);
    try {
      await apiFetch(
        `/vendors/${params.vendorId}/branches/${params.branchId}/stock/${row.offer_variant_id}/movements`,
        {
          method: "POST",
          body: { reason: draft.reason, quantity_delta: delta, reason_note: draft.note.trim() },
          idempotencyKey: newIdempotencyKey(`stock-movement-${row.offer_variant_id}`),
        },
      );
      patchDraft(row.offer_variant_id, { delta: "", note: "" });
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر تنفيذ الحركة");
    } finally {
      setBusyId(null);
    }
  }

  async function submitConfirmCount(row: StockRowDto) {
    const note = countNoteDrafts[row.offer_variant_id] ?? "";
    setBusyId(row.offer_variant_id);
    setError(null);
    try {
      await apiFetch(
        `/vendors/${params.vendorId}/branches/${params.branchId}/stock/${row.offer_variant_id}/confirm-count`,
        {
          method: "POST",
          body: note.trim() ? { note: note.trim() } : {},
          idempotencyKey: newIdempotencyKey(`confirm-count-${row.offer_variant_id}`),
        },
      );
      setCountNoteDrafts((prev) => ({ ...prev, [row.offer_variant_id]: "" }));
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر تأكيد الجرد");
    } finally {
      setBusyId(null);
    }
  }

  async function submitThreshold(row: StockRowDto) {
    const raw = thresholdDrafts[row.offer_variant_id] ?? String(row.safety_stock_threshold);
    const threshold = Number(raw);
    if (!Number.isInteger(threshold) || threshold < 0) {
      setError("حد الأمان يجب أن يكون عدداً صحيحاً غير سالب");
      return;
    }
    setBusyId(row.offer_variant_id);
    setError(null);
    try {
      await apiFetch(
        `/vendors/${params.vendorId}/branches/${params.branchId}/stock/${row.offer_variant_id}/safety-stock`,
        {
          method: "PUT",
          body: { threshold },
          idempotencyKey: newIdempotencyKey(`safety-stock-${row.offer_variant_id}`),
        },
      );
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر حفظ حد الأمان");
    } finally {
      setBusyId(null);
    }
  }

  async function runLookup() {
    if (!barcodeQuery.trim()) return;
    setLookupBusy(true);
    setLookupError(null);
    setLookupResult(null);
    try {
      const row = await apiFetch<StockRowDto>(
        `/vendors/${params.vendorId}/branches/${params.branchId}/stock/lookup?barcode=${encodeURIComponent(barcodeQuery.trim())}`,
      );
      setLookupResult(row);
    } catch (err) {
      setLookupError(err instanceof ApiError ? err.message : "لم يُعثر على هذا الباركود في هذا الفرع");
    } finally {
      setLookupBusy(false);
    }
  }

  function printLabel(row: StockRowDto) {
    const canvas = printCanvasRef.current;
    if (!canvas) return;
    JsBarcode(canvas, row.store_inventory_barcode, {
      format: "CODE128",
      displayValue: true,
      width: 2,
      height: 60,
      fontSize: 14,
    });
    const dataUrl = canvas.toDataURL("image/png");
    const win = window.open("", "_blank", "width=420,height=320");
    if (!win) return;
    // Review-round fix (XSS): the HTML written here is a fixed skeleton
    // with no interpolated value at all - an offer title or
    // colour/size is untrusted vendor-entered text, and the earlier
    // version embedded it directly into an HTML string passed to
    // document.write(), letting literal markup/script in a title
    // execute in the popup. The label is set via .textContent (always
    // rendered as plain text, never parsed as markup) and the barcode
    // image via .src, both after the static document has loaded -
    // never by building HTML out of either value.
    win.document.write(
      `<!doctype html><html><head><meta charset="utf-8"><title>ملصق</title></head>` +
        `<body style="margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">` +
        `<img id="barcode-label-image" style="max-width:100%;" />` +
        `<div id="barcode-label-text" style="margin-top:8px;"></div>` +
        `</body></html>`,
    );
    win.document.close();
    const img = win.document.getElementById("barcode-label-image") as HTMLImageElement | null;
    const labelEl = win.document.getElementById("barcode-label-text");
    if (labelEl) {
      labelEl.textContent = variantLabel(row);
    }
    if (img) {
      img.onload = () => win.print();
      img.src = dataUrl;
    }
  }

  function renderRow(row: StockRowDto, draft: MovementDraft) {
    return (
      <div key={row.offer_variant_id} className="card" style={{ padding: 16 }}>
        <div className="top-bar" style={{ marginBottom: 8 }}>
          <div>
            <strong>{row.offer_title_ar}</strong>
            <span className="muted" style={{ marginInlineStart: 8 }}>
              {[row.colour, row.size].filter(Boolean).join(" / ") || row.seller_sku}
            </span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {row.is_low_stock && <span className="badge">مخزون منخفض</span>}
            {row.is_stale && <span className="badge">جرد قديم</span>}
          </div>
        </div>
        <p className="muted" style={{ margin: "4px 0", fontFamily: "monospace" }}>
          باركود: {row.store_inventory_barcode}
        </p>
        <p style={{ margin: "4px 0" }}>
          الكمية: {row.quantity} — محجوز: {row.reserved_quantity} — متاح: {row.available_quantity}
        </p>
        <p className="muted" style={{ margin: "4px 0" }}>
          آخر جرد فعلي: {formatCountedAt(row.last_physical_count_at)}
        </p>

        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div className="field" style={{ margin: 0 }}>
            <label>سبب الحركة</label>
            <select
              value={draft.reason}
              onChange={(e) => patchDraft(row.offer_variant_id, { reason: e.target.value })}
            >
              {MOVEMENT_REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ margin: 0, maxWidth: 120 }}>
            <label>الكمية (± )</label>
            <input
              value={draft.delta}
              onChange={(e) => patchDraft(row.offer_variant_id, { delta: e.target.value })}
              placeholder="مثال: -1"
            />
          </div>
          <div className="field" style={{ margin: 0, flex: 1, minWidth: 160 }}>
            <label>ملاحظة (مطلوبة)</label>
            <input
              value={draft.note}
              onChange={(e) => patchDraft(row.offer_variant_id, { note: e.target.value })}
            />
          </div>
          <button
            className="button"
            disabled={busyId === row.offer_variant_id}
            onClick={() => submitMovement(row)}
          >
            تسجيل الحركة
          </button>
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div className="field" style={{ margin: 0, flex: 1, minWidth: 160 }}>
            <label>ملاحظة تأكيد الجرد (اختياري)</label>
            <input
              value={countNoteDrafts[row.offer_variant_id] ?? ""}
              onChange={(e) =>
                setCountNoteDrafts((prev) => ({ ...prev, [row.offer_variant_id]: e.target.value }))
              }
            />
          </div>
          <button
            className="button-link"
            disabled={busyId === row.offer_variant_id}
            onClick={() => submitConfirmCount(row)}
          >
            تأكيد الجرد الفعلي
          </button>
          <button className="button-link" onClick={() => printLabel(row)}>
            طباعة ملصق الباركود
          </button>
        </div>

        {isOwner && (
          <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "flex-end" }}>
            <div className="field" style={{ margin: 0, maxWidth: 120 }}>
              <label>حد الأمان (0 = معطّل)</label>
              <input
                value={thresholdDrafts[row.offer_variant_id] ?? String(row.safety_stock_threshold)}
                onChange={(e) =>
                  setThresholdDrafts((prev) => ({ ...prev, [row.offer_variant_id]: e.target.value }))
                }
              />
            </div>
            <button
              className="button-link"
              disabled={busyId === row.offer_variant_id}
              onClick={() => submitThreshold(row)}
            >
              حفظ حد الأمان
            </button>
          </div>
        )}
      </div>
    );
  }

  if (!hydrated || !token || workspaces === null) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 1000 }} />
      </div>
    );
  }
  if (!isMember || branchMismatch || forbidden) {
    return (
      <div className="page-shell">
        <EmptyState title="لا صلاحية للوصول إلى مخزون هذا الفرع" actionHref="/account" actionLabel="حسابي" />
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 1000 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>مخزون الفرع</h1>
          <Link href={`/vendor/${params.vendorId}/branches/${params.branchId}/orders`} className="button-link">
            طلبات الفرع
          </Link>
        </div>
        {error && <ErrorBanner message={error} />}

        <div className="card" style={{ marginBottom: 16 }}>
          <div className="field" style={{ margin: 0 }}>
            <label>البحث بالباركود (مسح أو كتابة)</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={barcodeQuery}
                onChange={(e) => setBarcodeQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") runLookup();
                }}
              />
              <button className="button" disabled={lookupBusy} onClick={runLookup}>
                بحث
              </button>
            </div>
          </div>
          {lookupError && <ErrorBanner message={lookupError} />}
          {lookupResult && (
            <div style={{ marginTop: 12 }}>{renderRow(lookupResult, draftFor(lookupResult))}</div>
          )}
        </div>

        {!items && !error && (
          <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 1000 }} />
        )}
        {items && items.length === 0 && (
          <EmptyState
            title="لا توجد متغيّرات عروض لهذا المتجر بعد"
            message="تظهر هنا كل متغيّرات عروض متجركِ - بما فيها متغيّر لم تُسجَّل له أي كمية في هذا الفرع بعد، بكمية صفر."
          />
        )}
        {items && items.length > 0 && (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {items.map((row) => renderRow(row, draftFor(row)))}
            </div>
            {nextCursor && (
              <div style={{ marginTop: 16 }}>
                <button
                  className="button-link"
                  disabled={loadingMore}
                  onClick={() => {
                    setLoadingMore(true);
                    load(nextCursor, true);
                  }}
                >
                  {loadingMore ? "جارٍ التحميل..." : "تحميل المزيد"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
      <canvas ref={printCanvasRef} style={{ display: "none" }} />
    </div>
  );
}
