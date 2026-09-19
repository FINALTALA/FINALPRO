"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getSessionToken } from "@/lib/session";

export default function Home() {
  const [hasSession, setHasSession] = useState<boolean | null>(null);

  useEffect(() => {
    // Deliberately deferred to an effect, not a lazy useState
    // initializer: this must render the same (null/loading) output on
    // the server and on the client's first hydration pass - reading
    // localStorage during render would mismatch between the two.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHasSession(Boolean(getSessionToken()));
  }, []);

  return (
    <div className="page-shell">
      <div className="card">
        <div className="brand">FINALPRO</div>
        <p className="muted" style={{ textAlign: "center", marginBottom: 20 }}>
          منصّة مقارنة أسعار متعددة المتاجر
        </p>
        {hasSession === null ? null : hasSession ? (
          <Link href="/workspaces" className="button" style={{ display: "block", textAlign: "center" }}>
            الذهاب إلى مساحات العمل
          </Link>
        ) : (
          <Link href="/login" className="button" style={{ display: "block", textAlign: "center" }}>
            تسجيل الدخول
          </Link>
        )}
      </div>
    </div>
  );
}
