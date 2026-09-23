"use client";

import { useState } from "react";
import {
  CardResult,
  SANDBOX_TEST_CARDS,
  cardTokenFor,
  formatCardNumber,
  formatExpiry,
} from "@/lib/sandbox-card";

// Sprint 14: the sandbox card form. Card details stay in this component:
// only a sandbox TOKEN (or a validation error) ever leaves it.
export default function SandboxCardForm({
  busy,
  onPay,
}: {
  busy: boolean;
  onPay: (result: CardResult) => void;
}) {
  const [name, setName] = useState("");
  const [number, setNumber] = useState("");
  const [expiry, setExpiry] = useState("");
  const [cvc, setCvc] = useState("");

  return (
    <form
      className="card-form"
      aria-label="بيانات البطاقة (تجريبية)"
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        onPay(cardTokenFor({ number, expiry, cvc }));
      }}
    >
      <div className="warning-banner" role="note">
        دفع تجريبي (Sandbox): لا يتم خصم أي مبلغ حقيقي، ولا تُحفظ بيانات البطاقة ولا تُرسل إلى الخادم.
      </div>

      <div className="field">
        <label htmlFor="card-name">الاسم على البطاقة</label>
        <input id="card-name" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="card-number">رقم البطاقة</label>
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
          <label htmlFor="card-expiry">الانتهاء (MM/YY)</label>
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
        <summary>بطاقات تجريبية</summary>
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
                <span dir="ltr">{c.number}</span> - {c.outcome}
              </button>
            </li>
          ))}
        </ul>
      </details>

      <button className="button button-block" type="submit" disabled={busy}>
        {busy ? "جارٍ الدفع..." : "ادفعي الآن (تجريبي)"}
      </button>
    </form>
  );
}
