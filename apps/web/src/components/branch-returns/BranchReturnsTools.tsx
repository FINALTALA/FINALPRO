"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { registerTranslations } from "@/lib/i18n";
import { fmt, formatMoney } from "@/lib/returns";
import { useLang, useT } from "@/lib/useLang";
import type { ReturnPolicyDto } from "@/components/store-settings/ReturnPolicySection";

registerTranslations({
  ar: {
    "rt.policy": "سياسة المتجر",
    "rt.policy.window": "خلال {n} يوماً من الاستلام",
    "rt.policy.fee": "رسوم الإرجاع {amount}",
    "rt.policy.exchange_fee": "رسوم التبديل {amount}",
    "rt.policy.fee_free": "بلا رسوم إرجاع",
    "rt.policy.exchange_fee_free": "بلا رسوم تبديل",
    "rt.policy.owner_link": "تعديلها من «إعدادات المتجر»",
  },
  en: {
    "rt.policy": "Store policy",
    "rt.policy.window": "within {n} days of receipt",
    "rt.policy.fee": "return fee {amount}",
    "rt.policy.exchange_fee": "exchange fee {amount}",
    "rt.policy.fee_free": "no return fee",
    "rt.policy.exchange_fee_free": "no exchange fee",
    "rt.policy.owner_link": "edit it in «Store settings»",
  },
});

/**
 * «سياسة المتجر» in one quiet read-only line (owner and the branch's
 * employee) at the top of the returns board. IX-P2: «استلام إرجاع» moved
 * into the board itself (ReceiveReturnDialog - one entry with a preview).
 */
export function ReturnPolicySummary({ vendorId, isOwner }: { vendorId: string; isOwner: boolean }) {
  const lang = useLang();
  const t = useT();
  const [policy, setPolicy] = useState<ReturnPolicyDto | null>(null);
  useEffect(() => {
    let alive = true;
    apiFetch<ReturnPolicyDto>(`/vendors/${vendorId}/return-policy`).then(
      (p) => {
        if (alive) setPolicy(p);
      },
      () => undefined, // a summary only: the board below says what failed
    );
    return () => {
      alive = false;
    };
  }, [vendorId]);
  if (!policy) return null;
  const parts = [t(`ret.policy.mode.${policy.mode}`)];
  if (policy.mode !== "NO_RETURN" && policy.window_days) parts.push(fmt(t("rt.policy.window"), { n: policy.window_days }));
  if (policy.mode === "REFUND_ONLY" || policy.mode === "BOTH")
    parts.push(policy.fee_ils ? fmt(t("rt.policy.fee"), { amount: formatMoney(policy.fee_ils, lang) }) : t("rt.policy.fee_free"));
  if (policy.mode === "EXCHANGE_ONLY" || policy.mode === "BOTH")
    parts.push(policy.exchange_fee_ils ? fmt(t("rt.policy.exchange_fee"), { amount: formatMoney(policy.exchange_fee_ils, lang) }) : t("rt.policy.exchange_fee_free"));
  return (
    <p className="rt-policy" data-testid="rt-policy">
      <strong>{t("rt.policy")}:</strong> <span>{parts.join(" · ")}</span>
      {isOwner && (
        <>
          {" "}
          <a href={`/vendor/${vendorId}/settings#returns`} className="rt-policy-link" data-testid="rt-policy-link">{t("rt.policy.owner_link")}</a>
        </>
      )}
    </p>
  );
}
