"use client";

import "@/lib/approvalCenterText";
import Link from "next/link";
import { useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiErrors";
import { fill } from "@/lib/approvalCenterText";
import { useAdminGate } from "@/lib/useAdminGate";
import { useLang, useT } from "@/lib/useLang";
import styles from "../../approvals/approvals.module.css";

// VIA Control Center phase 2B: the decision screen for brand requests - a
// screen over the EXISTING endpoints only (GET /admin/brand-requests,
// POST /admin/brand-requests/:id/decision, both PLATFORM_ADMIN). The
// service keeps every rule: approving links an existing brand of the same
// name or creates it (or uses the brand chosen here), rejecting needs a
// reason, and a decided request cannot be decided again.

interface BrandRequest {
  id: string;
  name: string;
  status: string;
  offer: { id: string; title_ar: string } | null;
  vendor: { id: string; name: string };
  created_at: string;
}
interface Brand {
  id: string;
  name: string;
  is_no_brand?: boolean;
}

const LIST_CAP = 200;

export default function BrandRequestsPage() {
  const gate = useAdminGate("ADMIN");
  const t = useT();
  const lang = useLang();
  const [nonce, setNonce] = useState(0);
  const [items, setItems] = useState<BrandRequest[] | null>(null);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (gate.status !== "ok") return;
    let cancelled = false;
    Promise.all([
      apiFetch<{ items: BrandRequest[] }>("/admin/brand-requests?status=PENDING"),
      apiFetch<Brand[]>("/brands").catch(() => [] as Brand[]),
    ])
      .then(([requests, allBrands]) => {
        if (cancelled) return;
        setItems(requests.items);
        setBrands(allBrands.filter((b) => !b.is_no_brand));
        setLoadError(null);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [gate.status, nonce]);

  async function decide(r: BrandRequest, decision: "approve" | "reject") {
    setBusyId(r.id);
    setError(null);
    setNotice(null);
    try {
      const body =
        decision === "approve"
          ? { decision, ...(choice[r.id] ? { brand_id: choice[r.id] } : {}) }
          : { decision, reason: (reasons[r.id] ?? "").trim() };
      const done = await apiFetch<{ brand: { name: string } | null; offer_updated?: boolean }>(
        `/admin/brand-requests/${r.id}/decision`,
        { method: "POST", body },
      );
      setNotice(
        decision === "approve"
          ? fill(t(done.offer_updated ? "br.approved_offer" : "br.approved"), { name: done.brand?.name ?? r.name })
          : t("br.rejected"),
      );
      setNonce((n) => n + 1);
    } catch (err) {
      setError(apiErrorMessage(err, lang));
    } finally {
      setBusyId(null);
    }
  }

  const time = (iso: string) =>
    new Date(iso).toLocaleString(lang === "ar" ? "ar" : "en-GB", { dateStyle: "medium", timeStyle: "short" });

  if (gate.status === "loading") {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 1000 }} />
      </div>
    );
  }
  if (gate.status === "forbidden") {
    return (
      <div className="page-shell">
        <EmptyState title={t("br.forbidden")} actionHref="/admin" actionLabel={t("br.back")} />
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 1000 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>
            {t("br.title")}
          </h1>
          <Link href="/admin/approvals" className="button-link">
            {t("br.back")}
          </Link>
        </div>
        <p className={styles.lead}>{t("br.lead")}</p>

        {error && <ErrorBanner message={error} />}
        {notice && (
          <div className="notice-banner" role="status">
            {notice}
          </div>
        )}
        {loadError !== null && (
          <div className={styles.unavailable}>
            <span>
              {t("br.load_failed")} {apiErrorMessage(loadError, lang)}
            </span>
            <button type="button" className="button" onClick={() => setNonce((n) => n + 1)}>
              {t("ac.retry")}
            </button>
          </div>
        )}
        {items === null && loadError === null && <div className="skeleton" style={{ height: 120, width: "100%" }} />}
        {items !== null && items.length === 0 && <p className={styles.empty}>{t("br.empty")}</p>}
        {items !== null && items.length >= LIST_CAP && <p className={styles.lead}>{t("br.capped")}</p>}

        {items !== null && items.length > 0 && (
          <ol className={styles.list} data-testid="br-list">
            {items.map((r) => (
              <li key={r.id} className={`${styles.panel} ${styles.brandCard}`} data-testid="br-row" data-id={r.id}>
                <dl className={styles.brandFacts}>
                  <div>
                    <dt>{t("br.requested")}</dt>
                    <dd>
                      <strong>{r.name}</strong>
                    </dd>
                  </div>
                  <div>
                    <dt>{t("br.store")}</dt>
                    <dd>{r.vendor.name}</dd>
                  </div>
                  <div>
                    <dt>{t("br.product")}</dt>
                    <dd>{r.offer?.title_ar ?? "-"}</dd>
                  </div>
                  <div>
                    <dt>{t("br.submitted")}</dt>
                    <dd>{time(r.created_at)}</dd>
                  </div>
                </dl>
                <div className={styles.filters}>
                  <div className="field">
                    <label htmlFor={`br-brand-${r.id}`}>{t("br.link_existing")}</label>
                    <select
                      id={`br-brand-${r.id}`}
                      value={choice[r.id] ?? ""}
                      onChange={(e) => setChoice({ ...choice, [r.id]: e.target.value })}
                    >
                      <option value="">{t("br.as_requested")}</option>
                      {brands.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor={`br-reason-${r.id}`}>{t("br.reason")}</label>
                    <input
                      id={`br-reason-${r.id}`}
                      type="text"
                      value={reasons[r.id] ?? ""}
                      maxLength={500}
                      onChange={(e) => setReasons({ ...reasons, [r.id]: e.target.value })}
                    />
                  </div>
                </div>
                <div className={styles.brandActions}>
                  <button type="button" className="button" disabled={busyId === r.id} onClick={() => void decide(r, "approve")}>
                    {t("br.approve")}
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={busyId === r.id || (reasons[r.id] ?? "").trim().length < 3}
                    onClick={() => void decide(r, "reject")}
                  >
                    {t("br.reject")}
                  </button>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
