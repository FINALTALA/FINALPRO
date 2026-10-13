"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useState } from "react";
import { ErrorBanner } from "@/components/States";
import PasswordInput from "@/components/PasswordInput";
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
        <div className={styles.brand}>تسجيل الدخول</div>
        {error && <ErrorBanner message={error} />}
        {deactivated && (
          <p className={styles.linksRow} style={{ marginTop: -6 }}>
            <Link href="/reactivate">استرجاع الحساب المعطّل</Link>
          </p>
        )}
        <div className={styles.field}>
          <label className={styles.label} htmlFor="phone">
            رقم الهاتف
          </label>
          <div className={styles.inputWrap}>
            <input
              id="phone"
              className={`${styles.input} ${styles.inputLtr}`}
              type="tel"
              dir="ltr"
              autoComplete="username"
              placeholder="+970590000000"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
            />
          </div>
        </div>
        <PasswordInput
          id="password"
          label="كلمة المرور"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          required
        />
        <button className={styles.button} type="submit" disabled={loading}>
          {loading ? "جارٍ الدخول..." : "دخول"}
        </button>
        <p className={styles.linksRow}>
          <Link href="/reset-password">نسيتِ كلمة المرور؟</Link>
        </p>
        <p className={styles.linksRow}>
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
