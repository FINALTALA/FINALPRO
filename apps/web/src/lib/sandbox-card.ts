// Sprint 14: the sandbox card form. NO real payment exists (OPEN-001):
// only the documented sandbox test cards below are accepted, and the
// browser maps one to a sandbox TOKEN - the card number, expiry and CVC
// never leave the page, are never sent to the API and are never stored.

export type SandboxCardToken =
  | "tok_sandbox_visa"
  | "tok_sandbox_declined"
  | "tok_sandbox_insufficient_funds";

export const SANDBOX_TEST_CARDS: {
  number: string;
  token: SandboxCardToken;
  outcome: string;
}[] = [
  { number: "4242 4242 4242 4242", token: "tok_sandbox_visa", outcome: "نجاح الدفع" },
  { number: "4000 0000 0000 0002", token: "tok_sandbox_declined", outcome: "رفض البطاقة" },
  {
    number: "4000 0000 0000 9995",
    token: "tok_sandbox_insufficient_funds",
    outcome: "رصيد غير كافٍ",
  },
];

export interface CardInput {
  number: string;
  expiry: string; // MM/YY
  cvc: string;
}

export type CardResult =
  | { ok: true; token: SandboxCardToken }
  | { ok: false; error: string };

/** Formats digits as "1234 5678 9012 3456" while typing. */
export function formatCardNumber(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 16);
  return digits.replace(/(.{4})/g, "$1 ").trim();
}

/** Formats digits as "MM/YY" while typing. */
export function formatExpiry(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 4);
  return digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
}

export function cardTokenFor(input: CardInput, now: Date = new Date()): CardResult {
  const digits = input.number.replace(/\s/g, "");
  if (!/^\d{16}$/.test(digits)) {
    return { ok: false, error: "أدخلي رقم البطاقة التجريبية المكوّن من 16 رقماً" };
  }

  const match = /^(\d{2})\/(\d{2})$/.exec(input.expiry.trim());
  if (!match) return { ok: false, error: "أدخلي تاريخ الانتهاء بصيغة MM/YY" };
  const month = Number(match[1]);
  const year = 2000 + Number(match[2]);
  if (month < 1 || month > 12) {
    return { ok: false, error: "شهر الانتهاء غير صحيح" };
  }
  // A card is valid through the END of its expiry month.
  const endOfMonth = new Date(year, month, 1);
  if (endOfMonth.getTime() <= now.getTime()) {
    return { ok: false, error: "انتهت صلاحية البطاقة" };
  }

  if (!/^\d{3}$/.test(input.cvc.trim())) {
    return { ok: false, error: "رمز التحقق CVC يتكوّن من 3 أرقام" };
  }

  const card = SANDBOX_TEST_CARDS.find((c) => c.number.replace(/\s/g, "") === digits);
  if (!card) {
    // A real card number must never be accepted - not even to reject it
    // server-side - so it is refused right here and nothing is sent.
    return {
      ok: false,
      error: "هذا نموذج تجريبي: استخدمي إحدى البطاقات التجريبية المعروضة فقط. لا تُدخلي بطاقة حقيقية.",
    };
  }
  return { ok: true, token: card.token };
}

export function declineMessage(declineCode: string | undefined): string {
  if (declineCode === "insufficient_funds") {
    return "رُفضت العملية: الرصيد غير كافٍ. جرّبي بطاقة أخرى - الحجز ما زال قائماً.";
  }
  return "رُفضت البطاقة. جرّبي بطاقة أخرى - الحجز ما زال قائماً.";
}
