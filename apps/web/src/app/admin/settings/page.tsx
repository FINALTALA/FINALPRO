"use client";

import "@/lib/adminUsersText";
import "@/lib/alertRecipients";
import Link from "next/link";
import { useEffect, useState } from "react";
import { EmptyState } from "@/components/States";
import { apiFetch } from "@/lib/api";
import { fill } from "@/lib/adminUsersText";
import type { AlertRecipientsOverview } from "@/lib/alertRecipients";
import { useAdminGate } from "@/lib/useAdminGate";
import { useLang, useT } from "@/lib/useLang";
import styles from "../approvals/approvals.module.css";

// VIA phase 3 - Settings & Team: the platform team (read-only - no role
// management here) and the existing settings, each read from its own
// endpoint and managed on its own page: feature flags, platform alert
// recipients (ORDER_INTEGRITY / RETURN_ESCALATION, with their fallback),
// and the audit log with its export. Every section loads on its own, so
// one failure never hides the others.

interface Member {
  id: string;
  display_name: string | null;
  phone_masked: string | null;
  platform_role: "PLATFORM_ADMIN" | "VERIFICATION_REVIEWER";
  status: "ACTIVE" | "SUSPENDED" | "DEACTIVATED";
  store_memberships: number;
  created_at: string;
}
interface Flag {
  key: string;
  enabled: boolean;
  description: string;
}

type Section<T> =
  { state: "loading" } | { state: "error" } | { state: "ok"; data: T };

function useSection<T>(path: string, enabled: boolean): Section<T> {
  const [section, setSection] = useState<Section<T>>({ state: "loading" });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    apiFetch<T>(path)
      .then((data) => {
        if (!cancelled) setSection({ state: "ok", data });
      })
      .catch(() => {
        if (!cancelled) setSection({ state: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [path, enabled]);
  return section;
}

export default function AdminSettingsPage() {
  const gate = useAdminGate("ADMIN");
  const t = useT();
  const lang = useLang();
  const ok = gate.status === "ok";
  const team = useSection<{ members: Member[] }>("/admin/team", ok);
  const flags = useSection<Flag[]>("/admin/feature-flags", ok);
  const alerts = useSection<AlertRecipientsOverview>(
    "/admin/alert-recipients",
    ok,
  );

  if (gate.status === "loading") {
    return (
      <div className="page-shell">
        <div
          className="skeleton"
          style={{ height: 160, width: "100%", maxWidth: 1100 }}
        />
      </div>
    );
  }
  if (gate.status === "forbidden") {
    return (
      <div className="page-shell">
        <EmptyState
          title={t("au.forbidden")}
          actionHref="/account"
          actionLabel={t("au.account")}
        />
      </div>
    );
  }

  const date = (iso: string) =>
    new Date(iso).toLocaleDateString(lang === "ar" ? "ar" : "en-GB", {
      dateStyle: "medium",
    });
  const failed = <p className={styles.empty}>{t("st.section_failed")}</p>;
  const loading = (
    <div
      className="skeleton"
      aria-busy="true"
      style={{ height: 64, width: "100%" }}
    />
  );

  return (
    <div className="page-shell">
      <div
        className="wide-shell"
        style={{
          maxWidth: 1100,
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr)",
          gap: 16,
        }}
      >
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>
            {t("st.title")}
          </h1>
        </div>
        <p className={styles.lead} style={{ margin: 0 }}>
          {t("st.lead")}
        </p>

        <section className={styles.panel}>
          <h2 className={styles.panelTitle}>{t("st.team")}</h2>
          <p className={styles.lead} style={{ marginTop: 0 }}>
            {t("st.team_lead")}
          </p>
          {team.state === "loading" && loading}
          {team.state === "error" && failed}
          {team.state === "ok" &&
            (team.data.members.length === 0 ? (
              <p className={styles.empty}>{t("st.no_team")}</p>
            ) : (
              <ol className={styles.list} data-testid="st-team">
                {team.data.members.map((m) => (
                  <li
                    key={m.id}
                    className={styles.row}
                    style={{ gridTemplateColumns: "minmax(0,1fr) auto auto" }}
                    data-testid="st-member"
                  >
                    <div className={styles.rowMain}>
                      <strong className={styles.rowPrimary}>
                        <Link href={`/admin/users/${m.id}`}>
                          {m.display_name ?? t("au.no_name")}
                        </Link>
                      </strong>
                      <span className={styles.rowSecondary}>
                        <bdi dir="ltr">{m.phone_masked}</bdi> ·{" "}
                        {t(`st.role_help.${m.platform_role}`)} ·{" "}
                        {date(m.created_at)}
                        {m.store_memberships > 0 && (
                          <>
                            {" "}
                            ·{" "}
                            {fill(t("st.memberships"), {
                              n: m.store_memberships,
                            })}
                          </>
                        )}
                      </span>
                    </div>
                    <span
                      className={`badge${m.platform_role === "PLATFORM_ADMIN" ? " badge-active" : ""}`}
                      data-testid="st-member-role"
                    >
                      {t(`au.role.${m.platform_role}`)}
                    </span>
                    <span
                      className="badge"
                      style={
                        m.status === "ACTIVE"
                          ? undefined
                          : {
                              background: "var(--color-danger-bg)",
                              color: "var(--color-danger)",
                            }
                      }
                    >
                      {t(`au.status.${m.status}`)}
                    </span>
                  </li>
                ))}
              </ol>
            ))}
        </section>

        <div
          style={{
            display: "grid",
            gap: 16,
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(100%, 320px), 1fr))",
          }}
        >
          <section className={styles.panel} data-testid="st-flags">
            <h2 className={styles.panelTitle}>{t("st.flags")}</h2>
            {flags.state === "loading" && loading}
            {flags.state === "error" && failed}
            {flags.state === "ok" && (
              <>
                <p className={styles.lead} style={{ marginTop: 0 }}>
                  {fill(t("st.flags_summary"), {
                    on: flags.data.filter((f) => f.enabled).length,
                    total: flags.data.length,
                  })}
                </p>
                <ul style={{ margin: "0 0 12px", paddingInlineStart: 18 }}>
                  {flags.data.map((f) => (
                    <li key={f.key}>
                      <bdi dir="ltr">{f.key}</bdi> - {f.enabled ? "✓" : "✗"}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <Link
              href="/admin/feature-flags"
              className="button button-secondary"
            >
              {t("st.flags_manage")}
            </Link>
          </section>

          <section className={styles.panel} data-testid="st-alerts">
            <h2 className={styles.panelTitle}>{t("st.alerts")}</h2>
            {alerts.state === "loading" && loading}
            {alerts.state === "error" && failed}
            {alerts.state === "ok" && (
              <ul style={{ margin: "0 0 12px", paddingInlineStart: 18 }}>
                {alerts.data.categories.map((c) => (
                  <li key={c.category} data-testid="st-alert-category">
                    <strong>{t(`alerts.category.${c.category}`)}</strong>:{" "}
                    {fill(t(`st.delivery.${c.delivery}`), {
                      n: c.recipient_user_ids.length,
                    })}
                  </li>
                ))}
              </ul>
            )}
            <Link
              href="/admin/alert-recipients"
              className="button button-secondary"
            >
              {t("st.alerts_manage")}
            </Link>
          </section>

          <section className={styles.panel}>
            <h2 className={styles.panelTitle}>{t("st.audit")}</h2>
            <p className={styles.lead} style={{ marginTop: 0 }}>
              {t("st.audit_lead")}
            </p>
            <Link href="/admin/audit-logs" className="button button-secondary">
              {t("st.audit_open")}
            </Link>
          </section>
        </div>
      </div>
    </div>
  );
}
