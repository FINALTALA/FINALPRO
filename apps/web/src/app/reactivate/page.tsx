"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import AuthField from "@/components/AuthField";
import AuthLogo from "@/components/AuthLogo";
import { MessageCodeIcon, PhoneIcon } from "@/components/AuthIcons";
import { ErrorBanner } from "@/components/States";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { normalisePhone } from "@/lib/address";
import { registerTranslations } from "@/lib/i18n";
import { useT } from "@/lib/useLang";
import { setSessionToken } from "@/lib/session";
import styles from "../auth-pages.module.css";

registerTranslations({
  ar: {
    "reactivate.title": "استرجاع الحساب",
    "reactivate.intro": "أدخلي رقم هاتفك. إن كان حسابك معطّلاً وضمن 30 يوماً من تعطيله، سنرسل رمز تحقق لاسترجاعه.",
    "reactivate.phone_label": "رقم الهاتف",
    "reactivate.send_code": "إرسال رمز التحقق",
    "reactivate.sending": "جارٍ الإرسال...",
    "reactivate.code_intro": "إن كان الرقم مؤهلاً للاسترجاع فقد أُرسل إليه رمز من 6 أرقام. أدخلي الرمز لاسترجاع حسابك.",
    "reactivate.code_label": "رمز التحقق",
    "reactivate.confirm": "استرجاع الحساب",
    "reactivate.confirming": "جارٍ الاسترجاع...",
    "reactivate.done_login_required": "تم استرجاع حسابك. سجّلي الدخول من جديد.",
    "reactivate.login_action": "تسجيل الدخول",
    "reactivate.generic_error": "تعذّر الاتصال بالخادم، حاولي مرة أخرى",
    "reactivate.back_to_login": "العودة لتسجيل الدخول",
  },
  en: {
    "reactivate.title": "Recover your account",
    "reactivate.intro": "Enter your phone number. If your account is deactivated and within 30 days of deactivation, we'll send a verification code to recover it.",
    "reactivate.phone_label": "Phone number",
    "reactivate.send_code": "Send verification code",
    "reactivate.sending": "Sending...",
    "reactivate.code_intro": "If this number is eligible for recovery, a 6-digit code was sent to it. Enter the code to recover your account.",
    "reactivate.code_label": "Verification code",
    "reactivate.confirm": "Recover account",
    "reactivate.confirming": "Recovering...",
    "reactivate.done_login_required": "Your account was recovered. Sign in again.",
    "reactivate.login_action": "Sign in",
    "reactivate.generic_error": "Couldn't reach the server, try again",
    "reactivate.back_to_login": "Back to sign in",
  },
});

type Step = "phone" | "confirm" | "done";

interface ReactivateConfirmResponse {
  session_token: string | null;
  session_status: "ISSUED" | "LOGIN_REQUIRED";
  account_reactivated: true;
}

// Sprint 22 (FR-AUTH-014, PDR-034): a fully independent flow from
// password reset (reactivate-request/reactivate-confirm, never
// password/reset-request) - see auth.controller.ts's own comment for
// why confirmPasswordReset() could never verify an ACCOUNT_REACTIVATION
// OTP. Anti-enumeration: POST /auth/reactivate-request always answers
// the same way, so this page never reveals whether a phone exists, is
// deactivated, or is within the 30-day window.
export default function ReactivateAccountPage() {
  const router = useRouter();
  const t = useT();
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmKey, setConfirmKey] = useState(() => newIdempotencyKey("reactivate-confirm"));

  async function run(action: () => Promise<void>) {
    setError(null);
    setLoading(true);
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("reactivate.generic_error"));
    } finally {
      setLoading(false);
    }
  }

  function requestCode(e: FormEvent) {
    e.preventDefault();
    const normalised = normalisePhone(phone);
    void run(async () => {
      await apiFetch("/auth/reactivate-request", {
        method: "POST",
        auth: false,
        body: { phone: normalised },
      });
      setPhone(normalised);
      setStep("confirm");
    });
  }

  function confirmReactivate(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      try {
        const verify = await apiFetch<{ session_token: string }>("/auth/otp/verify", {
          method: "POST",
          auth: false,
          idempotencyKey: newIdempotencyKey("reactivate-verify"),
          body: { phone, otp_code: code, purpose: "account_reactivation" },
        });
        const res = await apiFetch<ReactivateConfirmResponse>("/auth/reactivate-confirm", {
          method: "POST",
          auth: false,
          idempotencyKey: confirmKey,
          body: { phone, verification_token: verify.session_token },
        });
        if (res.session_token) {
          setSessionToken(res.session_token);
          router.push("/");
        } else {
          setStep("done");
        }
      } catch (err) {
        setConfirmKey(newIdempotencyKey("reactivate-confirm"));
        throw err;
      }
    });
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <AuthLogo />
        <div className={styles.header}>
          <h1>{t("reactivate.title")}</h1>
          {step === "phone" && <p>{t("reactivate.intro")}</p>}
          {step === "confirm" && <p>{t("reactivate.code_intro")}</p>}
        </div>

        {error && <ErrorBanner message={error} />}

        {step === "phone" && (
          <form onSubmit={requestCode}>
            <div className={styles.fields}>
              <AuthField
                id="ra-phone"
                label={t("reactivate.phone_label")}
                icon={<PhoneIcon />}
                ltr
                type="tel"
                autoComplete="username"
                placeholder="+970 59 XXX XXXX"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
              />
            </div>
            <button className={styles.button} type="submit" disabled={loading}>
              <span className={styles.buttonArrow}>←</span>
              {loading ? t("reactivate.sending") : t("reactivate.send_code")}
            </button>
          </form>
        )}

        {step === "confirm" && (
          <form onSubmit={confirmReactivate}>
            <div className={styles.fields}>
              <AuthField
                id="ra-code"
                label={t("reactivate.code_label")}
                icon={<MessageCodeIcon />}
                ltr
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
              />
            </div>
            <button className={styles.button} type="submit" disabled={loading}>
              <span className={styles.buttonArrow}>←</span>
              {loading ? t("reactivate.confirming") : t("reactivate.confirm")}
            </button>
          </form>
        )}

        {step === "done" && (
          <div className="notice-banner" role="status">
            {t("reactivate.done_login_required")} <Link href="/login">{t("reactivate.login_action")}</Link>
          </div>
        )}

        <div className={styles.linkRow}>
          <Link href="/login">{t("reactivate.back_to_login")}</Link>
        </div>
      </div>
    </div>
  );
}
