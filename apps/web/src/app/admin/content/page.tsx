"use client";

import "@/lib/contentStudioText";
import Link from "next/link";
import { useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch } from "@/lib/api";
import { fill } from "@/lib/approvalCenterText";
import { contentError, type ContentPage } from "@/lib/contentStudioText";
import { useAdminGate } from "@/lib/useAdminGate";
import { useLang, useT } from "@/lib/useLang";
import styles from "../approvals/approvals.module.css";

// VIA phase 6 - Content Studio: the three managed pages, their live state,
// pending schedule and open issues. PLATFORM_ADMIN only.

interface PageRow {
  page: ContentPage;
  exists: boolean;
  published: boolean;
  published_revision: number | null;
  draft_version: number | null;
  schedule: { status: "PENDING" | "FAILED"; run_at: string; local_time: string } | null;
  open_issues: number;
}

export default function AdminContentPage() {
  const gate = useAdminGate("ADMIN");
  const t = useT();
  const lang = useLang();
  const [rows, setRows] = useState<PageRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (gate.status !== "ok") return;
    let cancelled = false;
    apiFetch<PageRow[]>("/admin/content")
      .then((r) => !cancelled && setRows(r))
      .catch((e) => !cancelled && setError(e));
    return () => {
      cancelled = true;
    };
  }, [gate.status]);

  if (gate.status === "loading") {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 1100 }} />
      </div>
    );
  }
  if (gate.status === "forbidden") {
    return (
      <div className="page-shell">
        <EmptyState title={t("cs.forbidden")} actionHref="/account" actionLabel={t("cs.account")} />
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 1100, display: "grid", gap: 16 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>{t("cs.title")}</h1>
        </div>
        <p className={styles.lead} style={{ margin: 0 }}>{t("cs.lead")}</p>
        {error !== null && <ErrorBanner message={contentError(error, lang, t)} />}
        {!rows && error === null && <div className="skeleton" style={{ height: 120 }} />}
        {rows?.map((r) => (
          <section key={r.page} className={styles.panel} data-testid={`cs-page-${r.page}`}>
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>{t(`cs.page.${r.page}`)}</h2>
              <Link className="button" href={`/admin/content/${r.page}`}>{t("cs.open")}</Link>
            </div>
            <p className={styles.rowSecondary} style={{ margin: 0 }}>
              {!r.exists
                ? t("cs.notImported")
                : [
                    r.published ? fill(t("cs.published"), { n: r.published_revision ?? "" }) : t("cs.unpublished"),
                    fill(t("cs.draftVersion"), { n: r.draft_version ?? "" }),
                    r.schedule &&
                      fill(t(r.schedule.status === "FAILED" ? "cs.scheduleFailed" : "cs.scheduled"), { at: r.schedule.local_time }),
                    r.open_issues > 0 && fill(t("cs.issues"), { n: r.open_issues }),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
            </p>
          </section>
        ))}
      </div>
    </div>
  );
}
