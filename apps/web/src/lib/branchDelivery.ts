import { apiFetch } from "./api";
import "./branchDeliveryText";

/**
 * «نوافذ التوصيل v1»: the branch's 7-day delivery board and the owner's
 * window actions. Every state is the SERVER's (one window-state rule shared
 * with the shopper's slot list) - this file only carries it.
 */

export type WindowStatus = "PAST" | "CLOSED" | "PAUSED" | "BOOKING_STOPPED" | "CUTOFF_PASSED" | "FULL" | "OPEN";
export type DayStatus = "OPEN" | "CLOSED" | "NOT_BOOKABLE" | "NO_WINDOWS" | "PAST";

export interface BoardWindow {
  window_id: string;
  start_time: string;
  end_time: string;
  status: WindowStatus;
  reason: string | null;
  closed_source: "DATE" | "BRANCH_CLOSURE" | null;
  capacity: number;
  booked: number;
  active_holds: number;
  remaining: number;
  booking_deadline: string;
  paused: boolean;
  orders_by_status: Record<string, number>;
}
export interface BoardDay {
  date: string;
  day_of_week: number;
  status: DayStatus;
  closed_reason: string | null;
  closed_source: "DATE" | "BRANCH_CLOSURE" | null;
  active_orders: number;
  windows: BoardWindow[];
}
export interface TemplateWindow {
  id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  capacity: number;
  paused: boolean;
  paused_at: string | null;
  paused_reason: string | null;
  has_order_history: boolean;
}
export interface DeliveryBoard {
  branch_id: string;
  today: string;
  horizon_days: number;
  lead_minutes: number;
  days: BoardDay[];
  template: TemplateWindow[];
}
/** 409 details of "there are active orders" (close a day / a date). */
export interface ActiveOrdersDetails {
  active_orders: number;
  dates: string[];
  windows: { date: string; delivery_window_id: string; active_orders: number }[];
}

const base = (vendorId: string, branchId: string) => `/vendors/${vendorId}/branches/${branchId}/delivery-windows`;
const post = (path: string, body: object) => apiFetch(path, { method: "POST", body });

export const fetchBoard = (v: string, b: string) => apiFetch<DeliveryBoard>(`${base(v, b)}/board`);
export const addWindow = (v: string, b: string, body: { day_of_week: number; start_time: string; end_time: string; capacity: number }) =>
  post(base(v, b), body);
export const updateWindow = (v: string, b: string, w: TemplateWindow, capacity: number, reason: string) =>
  apiFetch(`${base(v, b)}/${w.id}`, {
    method: "PUT",
    body: { day_of_week: w.day_of_week, start_time: w.start_time, end_time: w.end_time, capacity, reason },
  });
export const deleteWindow = (v: string, b: string, id: string) => apiFetch(`${base(v, b)}/${id}`, { method: "DELETE" });
export const pauseWindow = (v: string, b: string, id: string, reason: string) => post(`${base(v, b)}/${id}/pause`, { reason });
export const resumeWindow = (v: string, b: string, id: string, reason: string) => post(`${base(v, b)}/${id}/resume`, { reason });
export const stopWindowDate = (v: string, b: string, id: string, date: string, reason: string) =>
  post(`${base(v, b)}/${id}/stop-booking`, { date, reason });
export const reopenWindowDate = (v: string, b: string, id: string, date: string, reason: string) =>
  post(`${base(v, b)}/${id}/reopen`, { date, reason });
export const stopDay = (v: string, b: string, date: string, reason: string) => post(`${base(v, b)}/days/${date}/stop-booking`, { reason });
export const closeDay = (v: string, b: string, date: string, reason: string) => post(`${base(v, b)}/days/${date}/close`, { reason });
export const reopenDay = (v: string, b: string, date: string, reason: string) => post(`${base(v, b)}/days/${date}/reopen`, { reason });

/** The branch orders screen opened on one date (and window). */
export function ordersHref(vendorId: string, branchId: string, date: string, w?: { window_id: string; start_time: string; end_time: string }) {
  const p = new URLSearchParams({ date });
  if (w) {
    p.set("window", w.window_id);
    p.set("slot", `${w.start_time}-${w.end_time}`);
  }
  return `/vendor/${vendorId}/branches/${branchId}/orders?${p.toString()}`;
}
