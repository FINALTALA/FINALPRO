"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import AuthField from "@/components/AuthField";
import AuthLogo from "@/components/AuthLogo";
import { MessageCodeIcon, PhoneIcon } from "@/components/AuthIcons";
import PasswordInput from "@/components/PasswordInput";
import { ErrorBanner } from "@/components/States";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { setSessionToken } from "@/lib/session";
import styles from "../auth-pages.module.css";

type Step = "phone" | "code" | "password";

// Sprint 13: the sign-up page over the existing OTP flow
// (POST /auth/otp/request -> /auth/otp/verify -> /auth/register). SMS
// delivery is still the documented logged fallback (OPEN-004), so in a
// local demo the code is read from the API server log.
export default function RegisterPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [verificationToken, setVerificationToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function run(action: () => Promise<void>) {
    setError(null);
    setLoading(true);
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر الاتصال بالخادم، حاولي مرة أخرى");
    } finally {
      setLoading(false);
    }
  }

  function requestCode(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      await apiFetch("/auth/otp/request", {
        method: "POST",
        auth: false,
        body: { phone, purpose: "signup" },
      });
      setStep("code");
    });
  }

  function verifyCode(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      const res = await apiFetch<{ session_token: string }>("/auth/otp/verify", {
        method: "POST",
        auth: false,
        idempotencyKey: newIdempotencyKey("verify"),
        body: { phone, otp_code: code, purpose: "signup" },
      });
      setVerificationToken(res.session_token);
      setStep("password");
    });
  }

  function register(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      const res = await apiFetch<{ session_token: string }>("/auth/register", {
        method: "POST",
        auth: false,
        body: { phone, password, verification_token: verificationToken },
      });
      setSessionToken(res.session_token);
      router.push("/");
    });
  }

  const stepNumber = step === "phone" ? 1 : step === "code" ? 2 : 3;

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <AuthLogo />
        <div className={styles.header}>
          <h1>إنشاء حساب</h1>
          <p>الخطوة {stepNumber} من 3</p>
        </div>

        {error && <ErrorBanner message={error} />}

        {step === "phone" && (
          <form onSubmit={requestCode}>
            <div className={styles.fields}>
              <AuthField
                id="phone"
                label="رقم الهاتف"
                icon={<PhoneIcon />}
                ltr
                type="tel"
                placeholder="+970 59 XXX XXXX"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
              />
            </div>
            <button className={styles.button} type="submit" disabled={loading}>
              <span className={styles.buttonArrow}>←</span>
              {loading ? "جارٍ الإرسال..." : "إرسال رمز التحقق"}
            </button>
          </form>
        )}

        {step === "code" && (
          <form onSubmit={verifyCode}>
            <p className={styles.helperText}>أدخلي الرمز المكوّن من 6 أرقام المرسل إلى {phone}.</p>
            <div className={styles.fields}>
              <AuthField
                id="code"
                label="رمز التحقق"
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
              {loading ? "جارٍ التحقق..." : "تحقّق"}
            </button>
          </form>
        )}

        {step === "password" && (
          <form onSubmit={register}>
            <div className={styles.fields}>
              <PasswordInput
                id="password"
                label="كلمة المرور (8 أحرف على الأقل)"
                value={password}
                onChange={setPassword}
                autoComplete="new-password"
                minLength={8}
                placeholder="أدخل كلمة المرور"
                required
              />
            </div>
            <button className={styles.button} type="submit" disabled={loading}>
              <span className={styles.buttonArrow}>←</span>
              {loading ? "جارٍ إنشاء الحساب..." : "إنشاء الحساب"}
            </button>
          </form>
        )}

        <div className={styles.divider}>
          <span />
          <p>أو</p>
          <span />
        </div>

        <p className={styles.bottomLink}>
          لديك حساب؟ <Link href="/login">تسجيل الدخول</Link>
        </p>
      </div>
    </div>
  );
}
