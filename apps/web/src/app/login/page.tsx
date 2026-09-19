"use client";

import { useRouter } from "next/navigation";
import { useState, FormEvent } from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { setSessionToken } from "@/lib/session";

export default function LoginPage() {
  const router = useRouter();
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
      router.push("/workspaces");
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "تعذّر الاتصال بالخادم، حاول مرة أخرى",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page-shell">
      <form className="card" onSubmit={onSubmit}>
        <div className="brand">تسجيل الدخول</div>
        {error && <div className="error-banner">{error}</div>}
        <div className="field">
          <label htmlFor="phone">رقم الهاتف</label>
          <input
            id="phone"
            type="tel"
            dir="ltr"
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
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <button className="button" type="submit" disabled={loading}>
          {loading ? "جارٍ الدخول..." : "دخول"}
        </button>
      </form>
    </div>
  );
}
