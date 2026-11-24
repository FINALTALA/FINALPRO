import { apiFetch, newIdempotencyKey } from "./api";
import type { TimelineActor } from "./branchOrders";

// IX-P2 «لوحة إرجاعات الفرع» (2026-11-23): the returns board's data - the
// read API (GET …/return-queue, one return, its timeline), the code preview
// (POST …/returns/lookup: never consumes the code) and the existing actions
// (PATCH …/returns/:id/decision, POST …/returns/redeem), unchanged.
// No answer here ever carries the raw return code (IX-P1).

export const RETURN_TABS = ["pending_decision", "awaiting_dropoff", "completed", "closed", "platform"] as const;
export type ReturnTab = (typeof RETURN_TABS)[number];
export type ReturnOutcome = "RETURN" | "EXCHANGE";

export type ReturnMoney =
  | { kind: "refund"; final: boolean; amount: number; method: "COD_CASH" | "ONLINE_GATEWAY" }
  | { kind: "exchange"; final: boolean; amount: number; direction: "COLLECT_CASH" | "REFUND_CASH" | "NONE" }
  | null;

export interface ReturnItem {
  title_ar: string | null;
  title_en: string | null;
  color_name_ar: string | null;
  color_name_en: string | null;
  color_hex: string | null;
  size_label: string | null;
  quantity?: number;
  image_url: string | null;
}

export interface ReturnRow {
  id: string;
  number: string;
  order_id: string;
  order_number: string;
  branch_id: string;
  branch_name: string;
  status: string;
  bucket: ReturnTab;
  outcome: ReturnOutcome;
  reason: string;
  created_at: string;
  item: ReturnItem & { quantity: number };
  customer_short: string | null;
  money: ReturnMoney;
  deadline: { kind: "escalation" | "code_expiry" | "dispute"; at: string } | null;
}

export interface ReturnPage {
  items: ReturnRow[];
  next_cursor: string | null;
  counts: Record<ReturnTab, number>;
  branch_counts?: { branch_id: string; open: number }[];
  scope: "branch" | "all";
  tab: ReturnTab;
}

export interface ReturnDetail extends ReturnRow {
  reason_note: string | null;
  photo_urls: string[];
  size_guide: unknown;
  policy: { mode: string | null; window_days: number | null; fee_ils: number | null; exchange_fee_ils: number | null };
  payment_method: "COD" | "ONLINE";
  replacement: (ReturnItem & { branch_id: string | null; branch_name: string | null; unit_price: number | null }) | null;
  rejection_reason: string | null;
  rejected_at: string | null;
  dispute_deadline_at: string | null;
  escalated_at: string | null;
  code_expires_at: string | null;
  received: { at: string; branch_id: string | null; branch_name: string | null; condition: string | null } | null;
  is_own_return: boolean;
  can_decide: boolean;
  receive_at: { any_branch: true } | { any_branch: false; branch_id: string | null; branch_name: string | null } | null;
}

export interface ReturnEvent {
  id: string;
  at: string;
  kind: string;
  actor: TimelineActor;
  condition?: string | null;
  branch_name?: string | null;
  amount?: number | null;
  method?: string | null;
  direction?: string | null;
}

export interface ReturnPreview {
  return_id: string;
  number: string;
  order_number: string;
  outcome: ReturnOutcome;
  item: ReturnItem & { quantity: number };
  replacement: ReturnItem | null;
  money: ReturnMoney;
  code_expires_at: string;
  receiving_branch: { id: string; name: string };
  allowed_branch: { id: string | null; name: string | null } | null;
  can_receive_here: boolean;
  blocked_reason: "SELF_DECISION_FORBIDDEN" | "WRONG_BRANCH_FOR_EXCHANGE" | null;
}

export interface RedeemResult {
  id: string;
  status: string;
  receiving_branch_id: string;
  received_at: string;
  item_condition: "RESELLABLE" | "DAMAGED";
  desired_outcome: ReturnOutcome;
  settlement: { net_amount: number; direction: "COLLECT_CASH" | "REFUND_CASH" | "NONE" } | null;
  refund: { amount: number; method: "COD_CASH" | "ONLINE_GATEWAY" } | null;
}

export interface ReturnFilters {
  tab: ReturnTab;
  outcome: ReturnOutcome | null;
  from: string | null;
  to: string | null;
  q: string;
  scope: "branch" | "all";
  branch: string | null;
}

const base = (vendorId: string, branchId: string) => `/vendors/${vendorId}/branches/${branchId}`;
const isDate = (s: string | null) => s !== null && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isId = (s: string | null) => s !== null && /^[0-9a-f-]{36}$/i.test(s);

export function readReturnFilters(sp: URLSearchParams): ReturnFilters {
  const tab = sp.get("tab");
  const outcome = sp.get("type");
  return {
    tab: RETURN_TABS.includes(tab as ReturnTab) ? (tab as ReturnTab) : "pending_decision",
    outcome: outcome === "RETURN" || outcome === "EXCHANGE" ? outcome : null,
    from: isDate(sp.get("from")) ? sp.get("from") : null,
    to: isDate(sp.get("to")) ? sp.get("to") : null,
    q: sp.get("q") ?? "",
    scope: sp.get("scope") === "all" ? "all" : "branch",
    branch: isId(sp.get("branch")) ? sp.get("branch") : null,
  };
}

export function fetchReturnQueue(vendorId: string, branchId: string, f: ReturnFilters, cursor?: string | null) {
  const p = new URLSearchParams();
  if (f.tab !== "pending_decision") p.set("tab", f.tab);
  if (f.outcome) p.set("outcome", f.outcome);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.q.trim()) p.set("q", f.q.trim());
  if (f.scope === "all" && f.branch) p.set("branch", f.branch);
  if (cursor) p.set("cursor", cursor);
  const qs = p.toString();
  // the owner's «كل الفروع»: the store-wide board (owner only on the server too)
  const path = f.scope === "all" ? `/vendors/${vendorId}/return-queue` : `${base(vendorId, branchId)}/return-queue`;
  return apiFetch<ReturnPage>(`${path}${qs ? `?${qs}` : ""}`);
}
export const fetchReturn = (vendorId: string, branchId: string, id: string) =>
  apiFetch<ReturnDetail>(`${base(vendorId, branchId)}/return-queue/${encodeURIComponent(id)}`);
export const fetchReturnTimeline = (vendorId: string, branchId: string, id: string) =>
  apiFetch<{ items: ReturnEvent[]; truncated: boolean }>(`${base(vendorId, branchId)}/return-queue/${encodeURIComponent(id)}/timeline`);

/** The existing decision endpoint (approve / reject with a reason). */
export function decideReturn(vendorId: string, branchId: string, id: string, decision: "approve" | "reject", reason?: string) {
  return apiFetch(`${base(vendorId, branchId)}/returns/${encodeURIComponent(id)}/decision`, {
    method: "PATCH",
    body: decision === "approve" ? { decision } : { decision, rejection_reason: reason },
    idempotencyKey: newIdempotencyKey("return-decision"),
  });
}
/** What the code would receive here - never consumes it. */
export function lookupReturn(vendorId: string, code: string, receivingBranchId: string) {
  return apiFetch<ReturnPreview>(`/vendors/${vendorId}/returns/lookup`, {
    method: "POST",
    body: { code, receiving_branch_id: receivingBranchId },
  });
}
/** The existing redemption (one transaction: receipt + stock + refund / exchange). */
export function redeemReturn(vendorId: string, code: string, receivingBranchId: string, condition: "RESELLABLE" | "DAMAGED") {
  return apiFetch<RedeemResult>(`/vendors/${vendorId}/returns/redeem`, {
    method: "POST",
    body: { code, receiving_branch_id: receivingBranchId, item_condition: condition },
    idempotencyKey: newIdempotencyKey("return-redeem"),
  });
}

export const itemTitle = (i: ReturnItem, lang: "ar" | "en") => (lang === "en" ? i.title_en || i.title_ar : i.title_ar || i.title_en) ?? "—";
export const itemColor = (i: ReturnItem, lang: "ar" | "en") => (lang === "en" ? i.color_name_en || i.color_name_ar : i.color_name_ar || i.color_name_en);
