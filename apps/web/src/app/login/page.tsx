"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useState } from "react";
import { ErrorBanner } from "@/components/States";
import { ApiError, apiFetch } from "@/lib/api";
import { setSessionToken } from "@/lib/session";

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
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
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
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page-shell">
      <form className="card" onSubmit={onSubmit}>
        <div className="brand">تسجيل الدخول</div>
        {error && <ErrorBanner message={error} />}
        <div className="field">
          <label htmlFor="phone">رقم الهاتف</label>
          <input
            id="phone"
            type="tel"
            dir="ltr"
            autoComplete="username"
            placeholder="+970590000000"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">كلمة المرور</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <button className="button button-block" type="submit" disabled={loading}>
          {loading ? "جارٍ الدخول..." : "دخول"}
        </button>
        <p className="muted" style={{ textAlign: "center", marginBottom: 0 }}>
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
