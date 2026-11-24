"use client";

import Link from "next/link";
import { useState, type ReactNode, type RefObject } from "react";
import { signOutToLogin } from "@/lib/auth";
import "@/lib/accountSettingsText";
import { useT } from "@/lib/useLang";
import "./userSettings.css";

function Chevron() {
  // «‹» direction: points to the end side (mirrored in RTL by the CSS)
  return (
    <svg className="us-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function Row({ href, title, hint, value, testId, tone }: { href: string; title: string; hint?: string; value?: ReactNode; testId: string; tone?: "danger" }) {
  return (
    <li>
      <Link href={href} className={`us-row${tone === "danger" ? " is-danger" : ""}`} data-testid={testId}>
        <span className="us-row-text">
          <span className="us-row-title">{title}</span>
          {hint && <span className="us-row-hint">{hint}</span>}
        </span>
        {value && <span className="us-row-value">{value}</span>}
        <Chevron />
      </Link>
    </li>
  );
}

/**
 * «إعدادات المستخدم» (2026-11-24) inside the current personal page: grouped
 * rows, not cards. «التسوّق»: the existing addresses and back-in-stock alerts
 * screens (unchanged - only their «رجوع» now comes back here). «الحساب
 * والأمان»: the one account's phone, sign-out (every context, the full
 * sign-in page) and closing the account (the existing screens). The same
 * settings for a shopper, a store owner and a branch employee: this is the
 * person's account, not a store's.
 */
export default function UserSettings({
  phone,
  onBack,
  headingRef,
}: {
  phone: string | null;
  onBack: () => void;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const t = useT();
  const [leaving, setLeaving] = useState(false);
  return (
    <section className="us" aria-labelledby="us-title" data-testid="user-settings">
      <div className="us-head">
        <button type="button" className="us-back" onClick={onBack} data-testid="us-back">
          <span aria-hidden="true" className="us-back-arrow">‹</span> {t("us.back")}
        </button>
        <h2 id="us-title" ref={headingRef} tabIndex={-1}>{t("us.title")}</h2>
        <p className="us-lead">{t("us.lead")}</p>
      </div>

      <div className="us-group" role="group" aria-labelledby="us-g-shopping">
        <h3 id="us-g-shopping" className="us-group-title">{t("us.group.shopping")}</h3>
        <ul className="us-list">
          <Row href="/account/addresses" title={t("us.addresses")} hint={t("us.addresses_hint")} testId="us-addresses" />
          <Row href="/account/availability-alerts" title={t("us.alerts")} hint={t("us.alerts_hint")} testId="us-alerts" />
        </ul>
      </div>

      <div className="us-group" role="group" aria-labelledby="us-g-account">
        <h3 id="us-g-account" className="us-group-title">{t("us.group.account")}</h3>
        <ul className="us-list">
          <Row
            href="/account/phone"
            title={t("us.phone")}
            value={
              <>
                {phone && <span dir="ltr" className="us-phone">{phone}</span>}
                <span className="us-row-action">{t("us.phone_change")}</span>
              </>
            }
            testId="us-phone"
          />
          <li>
            <button
              type="button"
              className="us-row"
              disabled={leaving}
              aria-busy={leaving}
              onClick={() => {
                setLeaving(true);
                void signOutToLogin();
              }}
              data-testid="us-signout"
            >
              <span className="us-row-text">
                <span className="us-row-title">{leaving ? t("us.signing_out") : t("us.signout")}</span>
                <span className="us-row-hint">{t("us.signout_hint")}</span>
              </span>
            </button>
          </li>
          <Row href="/account/deactivate" title={t("us.close")} hint={t("us.close_hint")} testId="us-close" tone="danger" />
        </ul>
      </div>
    </section>
  );
}
