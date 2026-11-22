"use client";

import { useState } from "react";
import {
  CardResult,
  SANDBOX_TEST_CARDS,
  cardOutcome,
  cardTokenFor,
  formatCardNumber,
  formatExpiry,
} from "@/lib/sandbox-card";
import { registerTranslations, translate } from "@/lib/i18n";
import { useLang } from "@/lib/useLang";

registerTranslations({
  ar: {
    "card.form": "بيانات البطاقة (تجريبية)",
    "card.note": "دفع تجريبي (Sandbox): لا يتم خصم أي مبلغ حقيقي، ولا تُحفظ بيانات البطاقة ولا تُرسل إلى الخادم.",
    "card.name": "الاسم على البطاقة",
    "card.number": "رقم البطاقة",
    "card.expiry": "الانتهاء (MM/YY)",
    "card.test_cards": "بطاقات تجريبية",
    "card.paying": "جارٍ الدفع...",
    "card.pay": "ادفعي الآن (تجريبي)",
  },
  en: {
    "card.form": "Card details (test)",
    "card.note": "Test payment (Sandbox): no real money is charged, and the card details are neither stored nor sent to the server.",
    "card.name": "Name on the card",
    "card.number": "Card number",
    "card.expiry": "Expiry (MM/YY)",
    "card.test_cards": "Test cards",
    "card.paying": "Paying...",
    "card.pay": "Pay now (test)",
  },
});

// Sprint 14: the sandbox card form. Card details stay in this component:
// only a sandbox TOKEN (or a validation error) ever leaves it.
export default function SandboxCardForm({
  busy,
  onPay,
}: {
  busy: boolean;
  onPay: (result: CardResult) => void;
}) {
  const lang = useLang();
  const t = (key: string) => translate(lang, key);
  const [name, setName] = useState("");
  const [number, setNumber] = useState("");
  const [expiry, setExpiry] = useState("");
  const [cvc, setCvc] = useState("");

  return (
    <form
      className="card-form"
      aria-label={t("card.form")}
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        onPay(cardTokenFor({ number, expiry, cvc }, new Date(), lang));
      }}
    >
      <div className="warning-banner" role="note">
        {t("card.note")}
      </div>

      <div className="field">
        <label htmlFor="card-name">{t("card.name")}</label>
        <input id="card-name" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="card-number">{t("card.number")}</label>
        <input
          id="card-number"
          dir="ltr"
          inputMode="numeric"
          autoComplete="off"
          placeholder="4242 4242 4242 4242"
          value={number}
          onChange={(e) => setNumber(formatCardNumber(e.target.value))}
        />
      </div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="card-expiry">{t("card.expiry")}</label>
          <input
            id="card-expiry"
            dir="ltr"
            inputMode="numeric"
            autoComplete="off"
            placeholder="12/30"
            value={expiry}
            onChange={(e) => setExpiry(formatExpiry(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="card-cvc">CVC</label>
          <input
            id="card-cvc"
            dir="ltr"
            inputMode="numeric"
            autoComplete="off"
            maxLength={3}
            placeholder="123"
            value={cvc}
            onChange={(e) => setCvc(e.target.value.replace(/\D/g, ""))}
          />
        </div>
      </div>

      <details className="test-cards">
        <summary>{t("card.test_cards")}</summary>
        <ul>
          {SANDBOX_TEST_CARDS.map((c) => (
            <li key={c.token}>
              <button
                type="button"
                className="button-link"
                onClick={() => {
                  setNumber(c.number);
                  if (!expiry) setExpiry("12/30");
                  if (!cvc) setCvc("123");
                }}
              >
                <span dir="ltr">{c.number}</span> - {cardOutcome(c, lang)}
              </button>
            </li>
          ))}
        </ul>
      </details>

      <button className="button button-block" type="submit" disabled={busy}>
        {busy ? t("card.paying") : t("card.pay")}
      </button>
    </form>
  );
}
