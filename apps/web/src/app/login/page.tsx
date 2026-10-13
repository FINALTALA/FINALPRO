"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useState } from "react";
import AuthField from "@/components/AuthField";
import AuthLogo from "@/components/AuthLogo";
import { PhoneIcon } from "@/components/AuthIcons";
import PasswordInput from "@/components/PasswordInput";
import { ErrorBanner } from "@/components/States";
import { ApiError, apiFetch } from "@/lib/api";
import { setSessionToken } from "@/lib/session";
import styles from "../auth-pages.module.css";

// Only same-site relative paths are honoured for ?next= - never an
// absolute URL (no open redirect).
function safeNext(raw: string | null): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}

function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const next = safeNext(search.get("next"));
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [deactivated, setDeactivated] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDeactivated(false);
    setLoading(true);
    try {
      const res = await apiFetch<{ session_token: string }>("/auth/login", {
        method: "POST",
        auth: false,
        body: { phone, password },
      });
      setSessionToken(res.session_token);
      router.push(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر الاتصال بالخادم، حاولي مرة أخرى");
      // Sprint 22 (FR-AUTH-014): a deactivated account's own login
      // attempt must still lead somewhere - without this, the
      // reactivation flow (/reactivate) would be undiscoverable.
      if (err instanceof ApiError && err.code === "ACCOUNT_DEACTIVATED") {
        setDeactivated(true);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.page}>
      <form className={styles.card} onSubmit={onSubmit}>
        <AuthLogo />
        <div className={styles.header}>
          <h1>تسجيل الدخول</h1>
          <p>أهلاً بعودتك! سجّلي دخولك للمتابعة</p>
        </div>

        {error && <ErrorBanner message={error} />}
        {deactivated && (
          <div className={styles.linkRow}>
            <Link href="/reactivate">استرجاع الحساب المعطّل</Link>
          </div>
        )}

        <div className={styles.fields}>
          <AuthField
            id="phone"
            label="رقم الهاتف"
            icon={<PhoneIcon />}
            ltr
            type="tel"
            autoComplete="username"
            placeholder="+970 59 XXX XXXX"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            required
          />
          <PasswordInput
            id="password"
            label="كلمة المرور"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            placeholder="أدخل كلمة المرور"
            required
          />
        </div>

        <button className={styles.button} type="submit" disabled={loading}>
          <span className={styles.buttonArrow}>←</span>
          {loading ? "جارٍ الدخول..." : "تسجيل الدخول"}
        </button>

        <div className={styles.linkRow}>
          <Link href="/reset-password">نسيتِ كلمة المرور؟</Link>
        </div>

        <div className={styles.divider}>
          <span />
          <p>أو</p>
          <span />
        </div>

        <p className={styles.bottomLink}>
          ليس لديك حساب؟ <Link href="/register">إنشاء حساب</Link>
        </p>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
