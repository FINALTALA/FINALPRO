import { readFileSync } from "node:fs";

// Sprint 21 (review-round point 1): fixture setup for the Playwright
// suite - drives the REAL running API over HTTP, mirroring the exact
// request shapes already proven in
// apps/api/test/sprint21-returns.e2e-spec.ts, rather than reinventing
// them. The business rules themselves are already covered by that
// Jest e2e suite; these Playwright specs only have to prove the UI
// renders and acts on real server responses correctly.

const API_BASE = process.env.PW_API_BASE_URL ?? "http://localhost:3001/api/v1";
const API_LOG_FILE = process.env.PW_API_LOG_FILE ?? "/tmp/finalpro-playwright-api.log";

let counter = 0;
export function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

let phoneSeq = 0;
/** +97059XXXXXXX, same prefix convention as every other e2e suite in
 * this project (never 57/58 - not valid PS mobile numbers). Seeded
 * from Date.now() rather than a bare 1-based counter: this suite's
 * throwaway DB is NOT recreated between repeated `npx playwright test`
 * runs against the same live server during local iteration (unlike
 * the Jest e2e suite's always-fresh DB), so a bare counter collides
 * with the previous run's already-registered phones and silently
 * breaks every signup (register() returns no session_token for an
 * already-taken phone, and nothing here checked for that - a real bug
 * this exact collision caused once). */
export function uniquePhone(): string {
  phoneSeq += 1;
  const n = (Date.now() + phoneSeq) % 10_000_000;
  return `+97059${n.toString().padStart(7, "0")}`;
}

interface CallOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  token?: string;
  idempotencyKey?: string;
  body?: unknown;
}

interface CallResult<T> {
  status: number;
  body: T;
}

export async function call<T = unknown>(
  path: string,
  options: CallOptions = {},
): Promise<CallResult<T>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
  const res = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

// Sprint 22: the byte length of the log file right now - pass as
// `sinceOffset` to waitForOtp() whenever the SAME phone number is used
// for a second OTP later in the same test (e.g. phone-change then
// reactivation, both for the new number). Without it, waitForOtp()'s
// own "last match in the whole file" search can race: if it runs its
// first read before the NEW request's line is written but the OLD
// line for that same phone already exists, it happily returns the
// STALE code instead of waiting for the new one - a real bug this
// exact scenario hit (OTP_INVALID from reusing the phone-change code
// for the reactivation step).
export function otpLogOffset(): number {
  try {
    return readFileSync(API_LOG_FILE, "utf8").length;
  } catch {
    return 0;
  }
}

function lastOtpFor(phone: string, sinceOffset: number, attempt = 0): string {
  let log = "";
  try {
    log = readFileSync(API_LOG_FILE, "utf8");
  } catch {
    log = "";
  }
  const escaped = phone.replace(/[+]/g, "\\+");
  const re = new RegExp(`OTP for ${escaped}: (\\d+)`, "g");
  let match: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((match = re.exec(log)) !== null) {
    if (match.index >= sinceOffset) last = match;
  }
  if (!last) {
    if (attempt >= 20) {
      throw new Error(`No OTP was ever logged for ${phone} in ${API_LOG_FILE} (since offset ${sinceOffset})`);
    }
    throw new Error("retry");
  }
  return last[1];
}

export async function waitForOtp(phone: string, sinceOffset = 0): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return lastOtpFor(phone, sinceOffset, attempt);
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error(`No OTP was ever logged for ${phone} in ${API_LOG_FILE} (since offset ${sinceOffset})`);
}

export async function signup(phone: string, password: string): Promise<string> {
  await call("/auth/otp/request", { method: "POST", body: { phone, purpose: "signup" } });
  const code = await waitForOtp(phone);
  const verify = await call<{ session_token: string }>("/auth/otp/verify", {
    method: "POST",
    idempotencyKey: unique("verify"),
    body: { phone, otp_code: code, purpose: "signup" },
  });
  const register = await call<{ session_token: string }>("/auth/register", {
    method: "POST",
    body: { phone, password, verification_token: verify.body.session_token },
  });
  if (!register.body.session_token) {
    throw new Error(
      `signup(${phone}) did not get a session_token back (status ${register.status}): ${JSON.stringify(register.body)}`,
    );
  }
  return register.body.session_token;
}

export async function createVendorWithBranch(
  ownerToken: string,
  returnPolicy: Record<string, unknown> = {
    mode: "REFUND_ONLY",
    window_days: 14,
    fee_ils: 5,
  },
  branchName = "Branch A",
): Promise<{ vendorId: string; branchId: string }> {
  const res = await call<{ id: string; branches: { id: string }[] }>("/vendors", {
    method: "POST",
    token: ownerToken,
    idempotencyKey: unique("vendor-apply"),
    body: {
      legal_name: unique("Vendor"),
      store_type: "PHYSICAL",
      branches: [{ name: branchName, is_physical: true }],
      applicable_categories: ["WOMEN"],
      return_policy: returnPolicy,
    },
  });
  if (res.status !== 201 || !res.body.branches?.[0]) {
    throw new Error(
      `createVendorWithBranch failed (status ${res.status}): ${JSON.stringify(res.body)}`,
    );
  }
  return { vendorId: res.body.id, branchId: res.body.branches[0].id };
}

export async function addToCart(
  token: string,
  vendorId: string,
  offerVariantId: string,
  quantity: number,
): Promise<string> {
  const res = await call<{ id: string }>("/cart/items", {
    method: "POST",
    token,
    idempotencyKey: unique("cart-add"),
    body: { vendor_id: vendorId, offer_variant_id: offerVariantId, quantity },
  });
  return res.body.id;
}

/** Places a PICKUP BranchOrder, paid ONLINE, and drives it all the way
 * to PICKED_UP (return-eligible). Mirrors
 * sprint21-returns.e2e-spec.ts's own placeAndPickUpOrder(). */
export async function placeAndPickUpOrder(
  owner: string,
  customer: string,
  vendorId: string,
  branchId: string,
  variantId: string,
): Promise<{ branchOrderId: string }> {
  const cartItemId = await addToCart(customer, vendorId, variantId, 1);
  const reserved = await call<{ reservation_id: string }>("/checkout/reserve", {
    method: "POST",
    token: customer,
    idempotencyKey: unique("reserve"),
    body: {
      terms_accepted: true,
      terms_version: "2026-10-v1",
      groups: [
        {
          cart_item_ids: [cartItemId],
          branch_id: branchId,
          fulfilment_method: "PICKUP",
          payment_method: "ONLINE",
        },
      ],
    },
  });
  const confirmed = await call<{
    branch_orders: { id: string; pickup_code: string }[];
  }>("/checkout/confirm", {
    method: "POST",
    token: customer,
    idempotencyKey: unique("confirm"),
    body: { reservation_id: reserved.body.reservation_id },
  });
  const branchOrderId = confirmed.body.branch_orders[0].id;
  const pickupCode = confirmed.body.branch_orders[0].pickup_code;

  await call(
    `/vendors/${vendorId}/branches/${branchId}/orders/${branchOrderId}/start-preparation`,
    { method: "POST", token: owner, idempotencyKey: unique("staff") },
  );
  await call(
    `/vendors/${vendorId}/branches/${branchId}/orders/${branchOrderId}/pickup-handover`,
    {
      method: "POST",
      token: owner,
      idempotencyKey: unique("staff"),
      body: { pickup_code: pickupCode },
    },
  );
  return { branchOrderId };
}

export async function submitReturn(
  customer: string,
  branchOrderId: string,
  itemId: string,
  reason = "CHANGE_OF_MIND",
) {
  return call<{ id: string }>(
    `/customers/me/orders/${branchOrderId}/items/${itemId}/returns`,
    {
      method: "POST",
      token: customer,
      idempotencyKey: unique("return-submit"),
      body: { reason },
    },
  );
}

export async function decideReturn(
  owner: string,
  vendorId: string,
  branchId: string,
  returnId: string,
  body: Record<string, unknown>,
) {
  return call(`/vendors/${vendorId}/branches/${branchId}/returns/${returnId}/decision`, {
    method: "PATCH",
    token: owner,
    idempotencyKey: unique("decide"),
    body,
  });
}

export async function redeemReturn(
  owner: string,
  vendorId: string,
  code: string,
  receivingBranchId: string,
  itemCondition: "RESELLABLE" | "DAMAGED" = "RESELLABLE",
) {
  return call(`/vendors/${vendorId}/returns/redeem`, {
    method: "POST",
    token: owner,
    idempotencyKey: unique("redeem"),
    body: { code, receiving_branch_id: receivingBranchId, item_condition: itemCondition },
  });
}

// Sprint 22 (FR-AUTH-006/008/014, PDR-029): account/addresses UI
// fixtures. requestOtpAndRead()/requestReactivationAndRead() wrap the
// request+log-read pair every OTP-gated S22 flow needs, mirroring
// signup()'s own two calls above.
export async function requestOtpAndRead(phone: string, purpose: string): Promise<string> {
  await call("/auth/otp/request", { method: "POST", body: { phone, purpose } });
  return waitForOtp(phone);
}

export async function requestReactivationAndRead(phone: string): Promise<string> {
  await call("/auth/reactivate-request", { method: "POST", body: { phone } });
  return waitForOtp(phone);
}

export async function createAddress(
  token: string,
  overrides: Partial<{ zone: string; phone_number_1: string; label: string }> = {},
): Promise<{ id: string }> {
  const res = await call<{ id: string }>("/customers/me/addresses", {
    method: "POST",
    token,
    body: {
      label: overrides.label ?? "البيت",
      lat: 31.9,
      lng: 35.2,
      phone_number_1: overrides.phone_number_1 ?? "+970591234567",
      zone: overrides.zone ?? "WEST_BANK",
    },
  });
  if (res.status !== 201) {
    throw new Error(`createAddress failed (status ${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

export async function setDeliveryZoneFee(
  ownerToken: string,
  vendorId: string,
  region: string,
  fee: number,
): Promise<void> {
  const res = await call(`/vendors/${vendorId}/delivery-zones/${region}`, {
    method: "PUT",
    token: ownerToken,
    body: { enabled: true, fee },
  });
  if (res.status !== 200) {
    throw new Error(`setDeliveryZoneFee failed (status ${res.status}): ${JSON.stringify(res.body)}`);
  }
}

export async function createDeliveryWindow(
  ownerToken: string,
  vendorId: string,
  branchId: string,
  dayOfWeek: number,
  capacity = 5,
): Promise<string> {
  const res = await call<{ id: string }>(
    `/vendors/${vendorId}/branches/${branchId}/delivery-windows`,
    {
      method: "POST",
      token: ownerToken,
      body: { day_of_week: dayOfWeek, start_time: "09:00", end_time: "18:00", capacity },
    },
  );
  if (res.status !== 201) {
    throw new Error(`createDeliveryWindow failed (status ${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body.id;
}

// Checkout requires a slot date within the next 3 days
// (INVALID_SLOT_DATE) - mirroring sprint22-account.e2e-spec.ts's own
// nextDateForDayOfWeek()/dayOfWeekFor(), this picks a fixed, small
// daysAhead FIRST and derives the matching day_of_week from it, rather
// than picking a day_of_week and searching for its next occurrence
// (which can land up to 7 days out and violate that limit).
const DAYS_AHEAD = 1;

export function nextScheduledDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + DAYS_AHEAD);
  return d.toISOString().slice(0, 10);
}

export function scheduledDayOfWeek(): number {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + DAYS_AHEAD);
  return d.getUTCDay();
}

/** Places a DELIVERY BranchOrder (ONLINE) at the given address, left PLACED. */
export async function placeDeliveryOrder(
  ownerToken: string,
  customerToken: string,
  vendorId: string,
  branchId: string,
  variantId: string,
  addressId: string,
): Promise<{ branchOrderId: string }> {
  const windowId = await createDeliveryWindow(ownerToken, vendorId, branchId, scheduledDayOfWeek());
  const cartItemId = await addToCart(customerToken, vendorId, variantId, 1);
  const reserved = await call<{ reservation_id: string }>("/checkout/reserve", {
    method: "POST",
    token: customerToken,
    idempotencyKey: unique("reserve"),
    body: {
      terms_accepted: true,
      terms_version: "2026-10-v1",
      groups: [
        {
          cart_item_ids: [cartItemId],
          branch_id: branchId,
          fulfilment_method: "DELIVERY",
          payment_method: "ONLINE",
          address_id: addressId,
          delivery_window_id: windowId,
          scheduled_date: nextScheduledDate(),
        },
      ],
    },
  });
  if (reserved.status !== 201) {
    throw new Error(`placeDeliveryOrder: reserve failed (status ${reserved.status}): ${JSON.stringify(reserved.body)}`);
  }
  const confirmed = await call<{ branch_orders: { id: string }[] }>("/checkout/confirm", {
    method: "POST",
    token: customerToken,
    idempotencyKey: unique("confirm"),
    body: { reservation_id: reserved.body.reservation_id },
  });
  if (confirmed.status !== 201) {
    throw new Error(`placeDeliveryOrder: confirm failed (status ${confirmed.status}): ${JSON.stringify(confirmed.body)}`);
  }
  return { branchOrderId: confirmed.body.branch_orders[0].id };
}

// Sprint 21b (EPIC-RET): exchange - desired_outcome=EXCHANGE plus the
// replacement variant/branch, mirroring submitReturn() above.
export async function submitExchange(
  customer: string,
  branchOrderId: string,
  itemId: string,
  replacementOfferVariantId: string,
  replacementBranchId: string,
  reason = "CHANGE_OF_MIND",
) {
  return call<{ id: string }>(
    `/customers/me/orders/${branchOrderId}/items/${itemId}/returns`,
    {
      method: "POST",
      token: customer,
      idempotencyKey: unique("exchange-submit"),
      body: {
        reason,
        desired_outcome: "EXCHANGE",
        replacement_offer_variant_id: replacementOfferVariantId,
        replacement_branch_id: replacementBranchId,
      },
    },
  );
}
