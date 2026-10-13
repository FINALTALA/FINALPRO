"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { ErrorBanner, EmptyState } from "@/components/States";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { normalisePhone } from "@/lib/address";
import { registerTranslations } from "@/lib/i18n";
import { useT } from "@/lib/useLang";
import { setSessionToken } from "@/lib/session";
import { useHydrated, useSessionToken } from "@/lib/useSession";

registerTranslations({
  ar: {
    "phone.title": "تغيير رقم الهاتف",
    "phone.step_of": "الخطوة {n} من 2",
    "phone.new_number": "رقم الهاتف الجديد",
    "phone.send_code": "إرسال رمز التحقق",
    "phone.sending": "جارٍ الإرسال...",
    "phone.code_intro": "أدخلي الرمز المكوّن من 6 أرقام المرسل إلى {phone}.",
    "phone.code_label": "رمز التحقق",
    "phone.confirm": "تأكيد رقم الهاتف الجديد",
    "phone.confirming": "جارٍ التأكيد...",
    "phone.done_login_required": "تم تغيير رقم هاتفك. سجّلي الدخول من جديد برقمك الجديد.",
    "phone.login_action": "تسجيل الدخول",
    "phone.generic_error": "تعذّر الاتصال بالخادم، حاولي مرة أخرى",
    "phone.login_required": "سجّلي الدخول لتغيير رقم هاتفك",
  },
  en: {
    "phone.title": "Change phone number",
    "phone.step_of": "Step {n} of 2",
    "phone.new_number": "New phone number",
    "phone.send_code": "Send verification code",
    "phone.sending": "Sending...",
    "phone.code_intro": "Enter the 6-digit code sent to {phone}.",
    "phone.code_label": "Verification code",
    "phone.confirm": "Confirm new phone number",
    "phone.confirming": "Confirming...",
    "phone.done_login_required": "Your phone number was changed. Sign in again with your new number.",
    "phone.login_action": "Sign in",
    "phone.generic_error": "Couldn't reach the server, try again",
    "phone.login_required": "Sign in to change your phone number",
  },
});

type Step = "phone" | "code" | "done-login-required";

interface PatchMeResponse {
  session_token: string | null;
  session_status: "ISSUED" | "LOGIN_REQUIRED" | null;
}

// Sprint 22 (FR-AUTH-006): changes the sign-in phone number over the
// existing generic OTP endpoints (POST /auth/otp/request ->
// /auth/otp/verify, purpose=phone_change), then applies it via
// PATCH /customers/me. A new session is issued when possible; if not
// (a Redis hiccup right after the already-committed change), the
// customer simply logs in again with the new number - never an error
// about the change itself, which already succeeded.
export default function ChangePhonePage() {
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const t = useT();
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function run(action: () => Promise<void>) {
    setError(null);
    setLoading(true);
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("phone.generic_error"));
    } finally {
      setLoading(false);
    }
  }

  function requestCode(e: FormEvent) {
    e.preventDefault();
    const normalised = normalisePhone(phone);
    void run(async () => {
      await apiFetch("/auth/otp/request", {
        method: "POST",
        body: { phone: normalised, purpose: "phone_change" },
      });
      setPhone(normalised);
      setStep("code");
    });
  }

  function verifyAndApply(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      const verify = await apiFetch<{ session_token: string }>("/auth/otp/verify", {
        method: "POST",
        idempotencyKey: newIdempotencyKey("phone-change-verify"),
        body: { phone, otp_code: code, purpose: "phone_change" },
      });
      const patched = await apiFetch<PatchMeResponse>("/customers/me", {
        method: "PATCH",
        idempotencyKey: newIdempotencyKey("phone-change-apply"),
        body: { phone, verification_token: verify.session_token },
      });
      if (patched.session_token) {
        setSessionToken(patched.session_token);
        router.push("/account");
      } else {
        setStep("done-login-required");
      }
    });
  }

  if (!hydrated) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 96, width: "100%", maxWidth: 480 }} />
      </div>
    );
  }

  if (!token) {
    return (
      <div className="page-shell">
        <EmptyState title={t("phone.login_required")} actionHref="/login?next=/account/phone" actionLabel={t("phone.login_action")} />
      </div>
    );
  }

  const stepNumber = step === "phone" ? 1 : 2;

  return (
    <div className="page-shell">
      <div className="card">
        <div className="brand">{t("phone.title")}</div>
        {step !== "done-login-required" && (
          <p className="muted" style={{ textAlign: "center", marginTop: -10 }}>
            {t("phone.step_of").replace("{n}", String(stepNumber))}
          </p>
        )}
        {error && <ErrorBanner message={error} />}

        {step === "phone" && (
          <form onSubmit={requestCode}>
            <div className="field">
              <label htmlFor="new-phone">{t("phone.new_number")}</label>
              <input
                id="new-phone"
                type="tel"
                dir="ltr"
                placeholder="+970590000000"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
              />
            </div>
            <button className="button button-block" type="submit" disabled={loading}>
              {loading ? t("phone.sending") : t("phone.send_code")}
            </button>
          </form>
        )}

        {step === "code" && (
          <form onSubmit={verifyAndApply}>
            <p className="muted">{t("phone.code_intro").replace("{phone}", phone)}</p>
            <div className="field">
              <label htmlFor="phone-code">{t("phone.code_label")}</label>
              <input
                id="phone-code"
                inputMode="numeric"
                dir="ltr"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
              />
            </div>
            <button className="button button-block" type="submit" disabled={loading}>
              {loading ? t("phone.confirming") : t("phone.confirm")}
            </button>
          </form>
        )}

        {step === "done-login-required" && (
          <div className="notice-banner" role="status">
            {t("phone.done_login_required")} <Link href="/login">{t("phone.login_action")}</Link>
          </div>
        )}

        <p className="muted" style={{ textAlign: "center", marginBottom: 0 }}>
          <Link href="/account">{t("common.back")}</Link>
        </p>
      </div>
    </div>
  );
}
