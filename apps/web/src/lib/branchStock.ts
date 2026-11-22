import { ApiError, apiFetch, newIdempotencyKey } from "./api";
import "./branchStockText";

/**
 * «إدارة مخزون الفرع v1» (2026-11-22): the branch's stock board, one line
 * (colour x size) and its stock log - and the existing stock writes:
 * movements (RECEIVE, a count by the counted quantity, DAMAGE / LOSS,
 * INTERNAL_USE), confirm-count, and the owner's safety threshold. The
 * screen never sends a typed difference for a count, never a SALE.
 */

export const BOARD_FILTERS = ["all", "low", "out", "stale"] as const;
export type BoardFilter = (typeof BOARD_FILTERS)[number];

export interface StockLine {
  offer_variant_id: string;
  offer_id: string;
  title_ar: string;
  title_en: string;
  color_name_ar: string | null;
  color_name_en: string | null;
  color_hex: string | null;
  size_label: string | null;
  sku: string;
  store_barcode: string;
  image_url: string | null;
  quantity: number;
  reserved_quantity: number;
  available_quantity: number;
  safety_stock_threshold: number;
  last_physical_count_at: string | null;
  is_out: boolean;
  is_low: boolean;
  is_stale: boolean;
}
export interface StockLineDetail extends StockLine {
  in_open_orders: number;
}
export interface BoardSummary {
  total_pieces: number;
  lines: number;
  low: number;
  out: number;
  stale: number;
}
export interface BoardPage {
  summary: BoardSummary;
  items: StockLine[];
  next_cursor: string | null;
  filter: BoardFilter;
  pinned: StockLine | null;
}
export type LedgerActor =
  | { kind: "system" }
  | { kind: "customer" }
  | { kind: "person"; name: string | null; role: string | null };
export type LedgerReference =
  | { kind: "order"; id: string; number: string }
  | { kind: "store_sale"; number: string }
  | { kind: "return"; id: string; number: string }
  | null;
export interface LedgerEntry {
  id: string;
  at: string;
  delta: number;
  resulting_quantity: number;
  reason: string;
  note: string;
  actor: LedgerActor;
  reference: LedgerReference;
}

const base = (vendorId: string, branchId: string) => `/vendors/${vendorId}/branches/${branchId}/stock`;

export function fetchBoard(
  vendorId: string,
  branchId: string,
  f: { q: string; filter: BoardFilter; variant: string | null },
  cursor?: string | null,
) {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set("q", f.q.trim());
  if (f.filter !== "all") p.set("filter", f.filter);
  if (f.variant) p.set("variant", f.variant);
  if (cursor) p.set("cursor", cursor);
  const qs = p.toString();
  return apiFetch<BoardPage>(`${base(vendorId, branchId)}/board${qs ? `?${qs}` : ""}`);
}
export const fetchLine = (vendorId: string, branchId: string, variantId: string) =>
  apiFetch<StockLineDetail>(`${base(vendorId, branchId)}/${encodeURIComponent(variantId)}/detail`);
export const fetchLedger = (vendorId: string, branchId: string, variantId: string, cursor?: string | null) =>
  apiFetch<{ items: LedgerEntry[]; next_cursor: string | null }>(
    `${base(vendorId, branchId)}/${encodeURIComponent(variantId)}/ledger${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
  );

export type MovementBody =
  | { reason: "RECEIVE" | "DAMAGE" | "LOSS" | "INTERNAL_USE"; quantity_delta: number; reason_note: string }
  | { reason: "COUNT_CORRECTION"; counted_quantity: number; expected_quantity: number; reason_note: string };

export function postMovement(vendorId: string, branchId: string, variantId: string, body: MovementBody) {
  return apiFetch(`${base(vendorId, branchId)}/${encodeURIComponent(variantId)}/movements`, {
    method: "POST",
    body,
    idempotencyKey: newIdempotencyKey(`stock-${body.reason.toLowerCase()}`),
  });
}
export function confirmCount(vendorId: string, branchId: string, variantId: string, note: string) {
  return apiFetch(`${base(vendorId, branchId)}/${encodeURIComponent(variantId)}/confirm-count`, {
    method: "POST",
    body: note.trim() ? { note: note.trim() } : {},
    idempotencyKey: newIdempotencyKey("stock-confirm-count"),
  });
}
export function saveThreshold(vendorId: string, branchId: string, variantId: string, threshold: number) {
  return apiFetch(`${base(vendorId, branchId)}/${encodeURIComponent(variantId)}/safety-stock`, {
    method: "PUT",
    body: { threshold },
    idempotencyKey: newIdempotencyKey("stock-safety"),
  });
}

/** An action's error, in the reader's words - never the server's own text. */
export function stockErrorKey(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "STOCK_CHANGED_RECOUNT":
        return "sk.err.recount";
      case "COUNT_BELOW_RESERVED":
        return "sk.err.below_reserved";
      case "INSUFFICIENT_STOCK":
        return "sk.err.insufficient";
      case "INVALID_MOVEMENT_DIRECTION":
      case "BAD_REQUEST":
        return "sk.err.invalid";
      case "VENDOR_SUSPENDED":
        return "sk.err.suspended";
      case "BRANCH_ARCHIVED":
        return "sk.err.archived";
      default:
        if (err.status === 403) return "sk.err.forbidden";
    }
  }
  return "sk.err.action";
}

/** A big quantity asks for a second, explicit confirmation (never an approval). */
export function needsSecondConfirm(change: number, currentQuantity: number): boolean {
  const n = Math.abs(change);
  return n > 50 || (currentQuantity > 0 && n > 2 * currentQuantity);
}
