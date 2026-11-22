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

// TB-25: the same words in English (the Arabic is unchanged).
const CARD_TEXT = {
  ar: {
    number: "أدخلي رقم البطاقة التجريبية المكوّن من 16 رقماً",
    expiryFormat: "أدخلي تاريخ الانتهاء بصيغة MM/YY",
    month: "شهر الانتهاء غير صحيح",
    expired: "انتهت صلاحية البطاقة",
    cvc: "رمز التحقق CVC يتكوّن من 3 أرقام",
    notTest: "هذا نموذج تجريبي: استخدمي إحدى البطاقات التجريبية المعروضة فقط. لا تُدخلي بطاقة حقيقية.",
    insufficient: "رُفضت العملية: الرصيد غير كافٍ. جرّبي بطاقة أخرى - الحجز ما زال قائماً.",
    declined: "رُفضت البطاقة. جرّبي بطاقة أخرى - الحجز ما زال قائماً.",
  },
  en: {
    number: "Enter the 16-digit test card number",
    expiryFormat: "Enter the expiry date as MM/YY",
    month: "The expiry month isn't valid",
    expired: "The card has expired",
    cvc: "The CVC is 3 digits",
    notTest: "This is a test form: use one of the test cards shown only. Don't enter a real card.",
    insufficient: "Declined: insufficient funds. Try another card - your hold is still in place.",
    declined: "The card was declined. Try another card - your hold is still in place.",
  },
} as const;
const OUTCOME_EN: Record<SandboxCardToken, string> = {
  tok_sandbox_visa: "Payment succeeds",
  tok_sandbox_declined: "Card declined",
  tok_sandbox_insufficient_funds: "Insufficient funds",
};

/** A test card's outcome in the interface language. */
export function cardOutcome(card: { token: SandboxCardToken; outcome: string }, lang: "ar" | "en" = "ar"): string {
  return lang === "en" ? OUTCOME_EN[card.token] : card.outcome;
}

export function cardTokenFor(input: CardInput, now: Date = new Date(), lang: "ar" | "en" = "ar"): CardResult {
  const text = CARD_TEXT[lang];
  const digits = input.number.replace(/\s/g, "");
  if (!/^\d{16}$/.test(digits)) {
    return { ok: false, error: text.number };
  }

  const match = /^(\d{2})\/(\d{2})$/.exec(input.expiry.trim());
  if (!match) return { ok: false, error: text.expiryFormat };
  const month = Number(match[1]);
  const year = 2000 + Number(match[2]);
  if (month < 1 || month > 12) {
    return { ok: false, error: text.month };
  }
  // A card is valid through the END of its expiry month.
  const endOfMonth = new Date(year, month, 1);
  if (endOfMonth.getTime() <= now.getTime()) {
    return { ok: false, error: text.expired };
  }

  if (!/^\d{3}$/.test(input.cvc.trim())) {
    return { ok: false, error: text.cvc };
  }

  const card = SANDBOX_TEST_CARDS.find((c) => c.number.replace(/\s/g, "") === digits);
  if (!card) {
    // A real card number must never be accepted - not even to reject it
    // server-side - so it is refused right here and nothing is sent.
    return {
      ok: false,
      error: text.notTest,
    };
  }
  return { ok: true, token: card.token };
}

export function declineMessage(declineCode: string | undefined, lang: "ar" | "en" = "ar"): string {
  return declineCode === "insufficient_funds" ? CARD_TEXT[lang].insufficient : CARD_TEXT[lang].declined;
}
