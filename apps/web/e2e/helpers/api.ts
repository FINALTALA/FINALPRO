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

function lastOtpFor(phone: string, attempt = 0): string {
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
  while ((match = re.exec(log)) !== null) last = match;
  if (!last) {
    if (attempt >= 20) {
      throw new Error(`No OTP was ever logged for ${phone} in ${API_LOG_FILE}`);
    }
    throw new Error("retry");
  }
  return last[1];
}

async function waitForOtp(phone: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return lastOtpFor(phone, attempt);
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error(`No OTP was ever logged for ${phone} in ${API_LOG_FILE}`);
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
