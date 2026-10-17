"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch, newIdempotencyKey } from "@/lib/api";
import { adminErrorMessage, isForbidden } from "@/lib/admin";
import { useAdminGate } from "@/lib/useAdminGate";

interface FeatureFlagRow {
  key: string;
  enabled: boolean;
  description: string;
}

// Sprint 25 (FR-ADMIN-004): PLATFORM_ADMIN-only toggle over the fixed,
// code-defined feature-flag registry. The list always shows every
// registry key (even one with no DB row yet, defaulted to false by
// the API itself) - this page never invents or deletes a key, only
// flips `enabled` on the ones the backend already knows about.
export default function AdminFeatureFlagsPage() {
  const gate = useAdminGate("ADMIN");
  const [flags, setFlags] = useState<FeatureFlagRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(() => {
    return apiFetch<FeatureFlagRow[]>("/admin/feature-flags")
      .then((data) => {
        setFlags(data);
        setError(null);
      })
      .catch((err) => {
        if (isForbidden(err)) setForbidden(true);
        setError(adminErrorMessage(err));
      });
  }, []);

  useEffect(() => {
    if (gate.status !== "ok") return;
    load();
  }, [gate.status, load]);

  async function toggle(flag: FeatureFlagRow) {
    setBusyKey(flag.key);
    setError(null);
    try {
      await apiFetch(`/admin/feature-flags/${flag.key}`, {
        method: "PUT",
        body: { enabled: !flag.enabled },
        idempotencyKey: newIdempotencyKey("feature-flag-toggle"),
      });
      await load();
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setBusyKey(null);
    }
  }

  if (gate.status === "loading") {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 800 }} />
      </div>
    );
  }
  if (gate.status === "forbidden" || forbidden) {
    return (
      <div className="page-shell">
        <EmptyState title="هذه الصفحة لمدير المنصة فقط" actionHref="/account" actionLabel="حسابي" />
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 800 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>أعلام الميزات</h1>
          <Link href="/admin" className="button-link">إدارة المنصة</Link>
        </div>

        {error && <ErrorBanner message={error} />}
        {!flags && !error && (
          <div aria-busy="true" aria-label="جارٍ التحميل">
            <div className="skeleton" style={{ height: 70, width: "100%" }} />
          </div>
        )}
        {flags && flags.length === 0 && (
          <EmptyState title="لا توجد أعلام ميزات معرَّفة حالياً" />
        )}
        {flags && flags.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {flags.map((flag) => (
              <div key={flag.key} className="card" style={{ maxWidth: "none" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                  <div>
                    <div style={{ fontWeight: 600, fontFamily: "monospace" }}>{flag.key}</div>
                    <div className="muted" style={{ marginTop: 4 }}>{flag.description}</div>
                  </div>
                  <span className={`badge${flag.enabled ? " badge-active" : ""}`}>
                    {flag.enabled ? "مفعّلة" : "معطَّلة"}
                  </span>
                </div>
                <div style={{ marginTop: 10 }}>
                  <button
                    className={flag.enabled ? "button button-secondary" : "button"}
                    disabled={busyKey === flag.key}
                    onClick={() => toggle(flag)}
                  >
                    {busyKey === flag.key
                      ? "جارٍ التنفيذ..."
                      : flag.enabled
                        ? "تعطيل"
                        : "تفعيل"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
