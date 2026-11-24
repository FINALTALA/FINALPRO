import { ApiError, apiFetch, newIdempotencyKey } from "./api";
import type { Lang } from "./i18n";
import "./branchOrdersText";

/**
 * «إدارة طلبات الفرع v1» (2026-11-22): the branch's order queue, one order
 * and its timeline (GET .../order-queue), and the EXISTING order actions
 * (POST/PATCH .../orders/:id/...) - the same requests, bodies and
 * Idempotency-Key the old page sent. Nothing here decides an order's next
 * state: the server returns which steps are allowed now, and checks again.
 */

// phase 2: «جاهز» = PREPARING with readyAt (a sub-state, its own bucket)
export const QUEUE_TABS = ["active", "new", "preparing", "ready", "with_courier", "awaiting_confirmation", "attention", "done"] as const;
export type QueueTab = (typeof QUEUE_TABS)[number];
export type QueueSort = "priority" | "newest";
export type Method = "PICKUP" | "DELIVERY";

export interface QueueRow {
  id: string;
  number: string;
  /** the order's branch (shown as a badge in the owner's «كل الفروع») */
  branch_id: string;
  branch_name: string;
  status: string;
  bucket: QueueTab;
  fulfilment_method: Method;
  payment_method: "COD" | "ONLINE";
  created_at: string;
  scheduled_date: string | null;
  window: { start_minute: number; end_minute: number } | null;
  due_at: string | null;
  is_late: boolean;
  customer_short: string | null;
  phone_last4: string;
  item_count: number;
  total?: number;
  amount_due: number | null;
  has_open_not_received_report: boolean;
  /** phase 2: «جاهز» (PREPARING with readyAt) */
  is_ready?: boolean;
}
export type QueueCounts = Record<QueueTab | "late", number>;
export interface QueuePage {
  items: QueueRow[];
  next_cursor: string | null;
  counts: QueueCounts;
  /** «كل الفروع» only: each branch's active (not done) orders */
  branch_counts?: { branch_id: string; active: number }[];
  scope?: "branch" | "all";
  tab: QueueTab;
  sort: QueueSort;
}

export type ActionKey =
  | "start_preparation"
  | "mark_sent"
  | "pickup_handover"
  | "mark_delivered"
  | "mark_delivery_failed"
  | "rerequest_confirmation"
  | "approve_refund"
  | "cancel"
  | "internal_note"
  | "mark_ready";
export interface QueueAction {
  key: ActionKey;
  primary?: boolean;
  /** mark_ready: the mandatory checklist items still missing (empty = it can be done) */
  missing?: string[];
  reason?: "optional" | "required";
  closes_order?: boolean;
}
export interface OrderItem {
  id: string;
  title_ar: string;
  title_en: string;
  color_name_ar: string | null;
  color_name_en: string | null;
  color_hex: string | null;
  size_label: string | null;
  quantity: number;
  cancelled: boolean;
  image_url: string | null;
  unit_price?: number;
  line_total?: number;
}
export interface OrderDetail {
  id: string;
  number: string;
  status: string;
  bucket: QueueTab;
  fulfilment_method: Method;
  payment_method: "COD" | "ONLINE";
  created_at: string;
  scheduled_date: string | null;
  window: { day_of_week: number; start_minute: number; end_minute: number } | null;
  due_at: string | null;
  is_late: boolean;
  customer: { name: string | null; phone: string };
  items: OrderItem[];
  item_count: number;
  payment: {
    method: "COD" | "ONLINE";
    subtotal?: number;
    delivery_fee?: number | null;
    total?: number;
    refunded?: number;
    amount_due: number | null;
    cod_collected_amount: number | null;
  };
  customer_note: string | null;
  internal_store_note: string | null;
  not_received: { open: boolean; reported_at?: string | null; reason?: string | null };
  cancellation_reason?: string | null;
  delivery_attempt_count: number;
  is_own_order: boolean;
  /** phase 2: preparation, the saved checklist, «جاهز» */
  preparation?: Preparation;
  actions: QueueAction[];
}
export type PrepItemKey = "ITEMS_VERIFIED" | "PACKED" | "INVOICE_ATTACHED";
export interface PrepPerson {
  name: string | null;
  role: "OWNER" | "BRANCH_EMPLOYEE" | string | null;
}
export interface Preparation {
  /** started from the release on: «جاهز» comes before sending / handing over */
  requires_ready: boolean;
  started_at: string | null;
  started_by: PrepPerson | null;
  is_ready: boolean;
  ready_at: string | null;
  ready_by: PrepPerson | null;
  checklist: { key: PrepItemKey; required: boolean; done: boolean; done_at: string | null; done_by: PrepPerson | null }[];
  missing: PrepItemKey[];
  can_edit: boolean;
  own_order_blocked: boolean;
}
export type TimelineActor =
  | { kind: "system" }
  | { kind: "customer" }
  | { kind: "owner"; name: string | null }
  | { kind: "employee"; name: string | null; branch_name?: string | null; other_branch?: boolean }
  | { kind: "employee_other_branch" }
  | { kind: "platform" }
  | { kind: "unrecorded"; name?: string | null };
export interface TimelineEvent {
  id: string;
  at: string;
  kind: string;
  from_status: string | null;
  to_status: string | null;
  actor: TimelineActor;
  reason?: string;
  /** phase 2: prep_check / prep_uncheck - which item */
  item?: string | null;
}

export interface QueueFilters {
  tab: QueueTab;
  method: Method | null;
  late: boolean;
  /** «إدارة طلبات الفرع v2» phase 1: cash on delivery only */
  cod: boolean;
  /** placed today (Palestine date, decided by the server) */
  today: boolean;
  /** an order number, the shopper's name or the phone's last 4 digits (never a pickup code) */
  q: string;
  sort: QueueSort | null;
  /** «نوافذ التوصيل v1»: one delivery date / window (from the 7-day board). */
  date: string | null;
  window: string | null;
  /** the owner's scope: this branch, or every branch of the store */
  scope: "branch" | "all";
  /** «كل الفروع»: narrowed to one branch */
  branch: string | null;
}

const base = (vendorId: string, branchId: string) => `/vendors/${vendorId}/branches/${branchId}`;

export function fetchQueue(vendorId: string, branchId: string, f: QueueFilters, cursor?: string | null) {
  const p = new URLSearchParams();
  if (f.tab !== "active") p.set("tab", f.tab);
  if (f.method) p.set("method", f.method);
  if (f.late) p.set("late", "true");
  if (f.cod) p.set("pay", "COD");
  if (f.today) p.set("created", "today");
  if (f.q.trim()) p.set("q", f.q.trim());
  if (f.sort) p.set("sort", f.sort);
  if (f.date) p.set("date", f.date);
  if (f.window) p.set("window", f.window);
  if (f.scope === "all" && f.branch) p.set("branch", f.branch);
  if (cursor) p.set("cursor", cursor);
  const qs = p.toString();
  // the owner's «كل الفروع»: the store-wide queue (owner only on the server too)
  const path = f.scope === "all" ? `/vendors/${vendorId}/order-queue` : `${base(vendorId, branchId)}/order-queue`;
  return apiFetch<QueuePage>(`${path}${qs ? `?${qs}` : ""}`);
}
export const fetchOrder = (vendorId: string, branchId: string, id: string) =>
  apiFetch<OrderDetail>(`${base(vendorId, branchId)}/order-queue/${encodeURIComponent(id)}`);
export const fetchTimeline = (vendorId: string, branchId: string, id: string) =>
  apiFetch<{ items: TimelineEvent[]; truncated: boolean }>(`${base(vendorId, branchId)}/order-queue/${encodeURIComponent(id)}/timeline`);

/** What the search box may hold: letters (any script), digits, spaces, # - ' . (the server checks the same). */
const SEARCH_DROP = new RegExp("[^#\\p{L}\\p{M}0-9\\s'.-]", "gu");
export const cleanSearch = (s: string) => s.replace(SEARCH_DROP, "").slice(0, 40);

/** «إدارة طلبات الفرع v2» phase 1: the internal prep sheet of one order - no
 * pickup code, no price, no shopper name / phone / address (the server sends none). */
export interface PrepSheet {
  id: string;
  number: string;
  branch_name: string;
  status: string;
  fulfilment_method: Method;
  created_at: string;
  scheduled_date: string | null;
  window: { start_minute: number; end_minute: number } | null;
  items: {
    id: string;
    title_ar: string;
    title_en: string;
    color_name_ar: string | null;
    color_name_en: string | null;
    size_label: string | null;
    quantity: number;
  }[];
  item_count: number;
  customer_note: string | null;
  internal_store_note: string | null;
}
export const fetchPrepSheet = (vendorId: string, branchId: string, id: string) =>
  apiFetch<PrepSheet>(`${base(vendorId, branchId)}/order-queue/${encodeURIComponent(id)}/prep-sheet`);
/** Only an order that is new or being prepared has a sheet (the server says 409 otherwise). */
export const hasPrepSheet = (status: string) => status === "PLACED" || status === "PREPARING";
export const prepSheetHref = (vendorId: string, branchId: string, id: string) =>
  `/print/prep-sheet/${encodeURIComponent(vendorId)}/${encodeURIComponent(branchId)}/${encodeURIComponent(id)}`;

/** The existing endpoint of each step (unchanged). */
const ACTION_PATH: Partial<Record<ActionKey, string>> = {
  start_preparation: "start-preparation",
  mark_sent: "mark-sent",
  pickup_handover: "pickup-handover",
  mark_delivered: "mark-delivered",
  mark_delivery_failed: "mark-delivery-failed",
  rerequest_confirmation: "rerequest-confirmation",
  approve_refund: "approve-refund",
  cancel: "cancel",
  mark_ready: "mark-ready",
};
export function runOrderAction(vendorId: string, branchId: string, id: string, action: ActionKey, body: Record<string, unknown> = {}) {
  const path = ACTION_PATH[action];
  if (!path) throw new Error(`unknown action ${action}`);
  return apiFetch(`${base(vendorId, branchId)}/orders/${encodeURIComponent(id)}/${path}`, {
    method: "POST",
    body,
    idempotencyKey: newIdempotencyKey(`staff-${path}`),
  });
}
/** phase 2: tick / un-tick one prep checklist item (the server keeps who and when). */
export function setPrepCheck(vendorId: string, branchId: string, id: string, item: PrepItemKey, done: boolean) {
  return apiFetch<{ id: string; item: PrepItemKey; done: boolean; missing: PrepItemKey[] }>(
    `${base(vendorId, branchId)}/orders/${encodeURIComponent(id)}/prep-checklist/${item}`,
    { method: "PATCH", body: { done } },
  );
}
export function saveInternalNote(vendorId: string, branchId: string, id: string, note: string) {
  return apiFetch(`${base(vendorId, branchId)}/orders/${encodeURIComponent(id)}/internal-note`, {
    method: "PATCH",
    body: { note },
    idempotencyKey: newIdempotencyKey("staff-internal-note"),
  });
}

/** An action's error, in the reader's words - never the server's own text, never the code typed. */
export function actionErrorKey(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "WRONG_PICKUP_CODE":
        return "bo.err.wrong_code";
      case "CANCELLATION_REASON_REQUIRED":
        return "bo.err.reason_required";
      case "SELF_DECISION_FORBIDDEN":
      case "OWN_ORDER_FORBIDDEN":
        return "bo.err.own_order";
      // phase 2
      case "ORDER_NOT_READY":
        return "bo.err.not_ready";
      case "PREP_CHECKLIST_INCOMPLETE":
        return "bo.err.checklist_incomplete";
      case "ORDER_ALREADY_READY":
      case "ORDER_NOT_PREPARING":
      case "INVALID_BRANCH_ORDER_TRANSITION":
      case "NO_PENDING_NOT_RECEIVED_REPORT":
      case "PICKUP_HANDOVER_NOT_APPLICABLE":
      case "DELIVERY_FAILURE_NOT_APPLICABLE":
      case "BRANCH_ORDER_NOT_FOUND":
        return "bo.err.changed";
      case "BAD_REQUEST":
        return "bo.err.invalid";
      default:
        if (err.status === 403) return "bo.err.forbidden";
        if (err.status === 409) return "bo.err.changed";
    }
  }
  return "bo.err.action";
}

// ---------------------------------------------------------------- formatting

const locale = (lang: Lang) => (lang === "en" ? "en-GB" : "ar");

export function money(n: number | null | undefined, lang: Lang): string {
  if (n === null || n === undefined) return "—";
  return `${new Intl.NumberFormat(locale(lang), { maximumFractionDigits: 2 }).format(n)} ₪`;
}
export function clock(minute: number, lang: Lang): string {
  const d = new Date(Date.UTC(2000, 0, 1, Math.floor(minute / 60), minute % 60));
  return new Intl.DateTimeFormat(locale(lang), { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }).format(d);
}
export function exactTime(iso: string, lang: Lang): string {
  return new Intl.DateTimeFormat(locale(lang), { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}
export function dayLabel(isoDate: string, lang: Lang): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Intl.DateTimeFormat(locale(lang), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}
/** «26/11» - the queue row's short date (the full one is its tooltip). */
export function shortDay(isoDate: string, lang: Lang): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Intl.DateTimeFormat(locale(lang), { day: "numeric", month: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}
/** «منذ 5 دقائق» / «in 2 hours». */
export function relativeTime(iso: string, lang: Lang, now = Date.now()): string {
  const diff = (new Date(iso).getTime() - now) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale(lang), { numeric: "auto" });
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86400), "day");
}
/** «متأخر 25 د» - minutes or hours since the slot started. */
export function lateBy(iso: string, lang: Lang, now = Date.now()): string {
  const mins = Math.max(1, Math.round((now - new Date(iso).getTime()) / 60000));
  const nf = new Intl.NumberFormat(locale(lang));
  if (mins < 60) return `${nf.format(mins)} ${lang === "en" ? "min" : "د"}`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${nf.format(h)} ${lang === "en" ? "h" : "س"}`;
  return `${nf.format(Math.round(h / 24))} ${lang === "en" ? "d" : "ي"}`;
}
export function windowLabel(date: string | null, w: { start_minute: number; end_minute: number } | null, lang: Lang): string | null {
  if (!date || !w) return null;
  return `${dayLabel(date, lang)} · ${clock(w.start_minute, lang)}–${clock(w.end_minute, lang)}`;
}

export function statusKey(status: string): string {
  return `bo.status.${status}`;
}
