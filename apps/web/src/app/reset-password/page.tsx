"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { ErrorBanner } from "@/components/States";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { normalisePhone } from "@/lib/address";
import { setSessionToken } from "@/lib/session";

type Step = "phone" | "confirm" | "done";

interface ResetConfirmResponse {
  session_token: string | null;
  session_status: "ISSUED" | "LOGIN_REQUIRED";
  password_reset_completed: true;
}

// Sprint 14 (BL-AUTH-003): password reset over the existing OTP APIs.
// POST /auth/password/reset-request always answers the same way (it never
// reveals whether the phone is registered), so this page does too. A
// successful reset revokes every older session server-side; the response
// either signs this browser in or asks for a normal login.
export default function ResetPasswordPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // One key per confirm attempt: a double-click replays it; a corrected
  // code or password is a new attempt with a new key.
  const [confirmKey, setConfirmKey] = useState(() => newIdempotencyKey("reset-confirm"));

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
      await apiFetch("/auth/password/reset-request", {
        method: "POST",
        auth: false,
        body: { phone: normalisePhone(phone) },
      });
      setStep("confirm");
    });
  }

  function confirmReset(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      try {
        const res = await apiFetch<ResetConfirmResponse>("/auth/password/reset-confirm", {
          method: "POST",
          auth: false,
          idempotencyKey: confirmKey,
          body: { phone: normalisePhone(phone), otp_code: code, new_password: password },
        });
        if (res.session_token) {
          setSessionToken(res.session_token);
          router.push("/");
        } else {
          setStep("done");
        }
      } catch (err) {
        setConfirmKey(newIdempotencyKey("reset-confirm"));
        throw err;
      }
    });
  }

  return (
    <div className="page-shell">
      <div className="card">
        <div className="brand">استعادة كلمة المرور</div>
        {error && <ErrorBanner message={error} />}

        {step === "phone" && (
          <form onSubmit={requestCode}>
            <p className="muted">أدخلي رقم هاتفك وسنرسل رمز تحقق لتعيين كلمة مرور جديدة.</p>
            <div className="field">
              <label htmlFor="rp-phone">رقم الهاتف</label>
              <input
                id="rp-phone"
                type="tel"
                dir="ltr"
                autoComplete="username"
                placeholder="+970590000000"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
              />
            </div>
            <button className="button button-block" type="submit" disabled={loading}>
              {loading ? "جارٍ الإرسال..." : "إرسال رمز التحقق"}
            </button>
          </form>
        )}

        {step === "confirm" && (
          <form onSubmit={confirmReset}>
            <p className="muted">
              إن كان الرقم مسجّلاً فقد أُرسل إليه رمز من 6 أرقام. أدخلي الرمز وكلمة المرور الجديدة.
            </p>
            <div className="field">
              <label htmlFor="rp-code">رمز التحقق</label>
              <input
                id="rp-code"
                inputMode="numeric"
                dir="ltr"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="rp-password">كلمة المرور الجديدة (8 أحرف على الأقل)</label>
              <input
                id="rp-password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <button className="button button-block" type="submit" disabled={loading}>
              {loading ? "جارٍ الحفظ..." : "تعيين كلمة المرور"}
            </button>
          </form>
        )}

        {step === "done" && (
          <div className="notice-banner" role="status">
            تم تغيير كلمة المرور. <Link href="/login">سجّلي الدخول</Link> بكلمة المرور الجديدة.
          </div>
        )}

        <p className="muted" style={{ textAlign: "center", marginBottom: 0 }}>
          <Link href="/login">العودة لتسجيل الدخول</Link>
        </p>
      </div>
    </div>
  );
}
