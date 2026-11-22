"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { isForbidden } from "@/lib/admin";
import {
  ALERT_CATEGORIES,
  AlertCategory,
  AlertRecipientChange,
  AlertRecipientsOverview,
  alertRecipientsErrorKey,
  shortId,
} from "@/lib/alertRecipients";
import { useAdminGate } from "@/lib/useAdminGate";
import { useT } from "@/lib/useLang";

type Action = "add" | "remove";

// TB-12.3: who receives each category of platform alert - PLATFORM_ADMIN
// only. Shows the active administrators by short id and phone hint only
// (all the API ever returns), each category's chosen recipients, and
// honestly warns when a category has none and falls back to every
// active administrator. One change at a time: while a request is in
// flight every action is disabled, and a retry after an unconfirmed
// result reuses the same Idempotency-Key, so a double click or a retry
// never sends a second change (the API itself writes no second audit
// row for a repeat either). The API is the final authority on access.
export default function AdminAlertRecipientsPage() {
  const gate = useAdminGate("ADMIN");
  const t = useT();
  const [overview, setOverview] = useState<AlertRecipientsOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const inFlight = useRef(false);
  // An action whose result was never confirmed keeps its key, so trying
  // it again replays rather than repeats.
  const pendingKeys = useRef(new Map<string, string>());

  const load = useCallback(() => {
    return apiFetch<AlertRecipientsOverview>("/admin/alert-recipients")
      .then((data) => {
        setOverview(data);
        setLoadError(null);
      })
      .catch((err) => {
        if (isForbidden(err)) setForbidden(true);
        else setLoadError(alertRecipientsErrorKey(err));
      });
  }, []);

  useEffect(() => {
    if (gate.status !== "ok") return;
    void load();
  }, [gate.status, load]);

  async function change(action: Action, category: AlertCategory, userId: string) {
    if (inFlight.current) return;
    const id = `${action}:${category}:${userId}`;
    inFlight.current = true;
    setBusy(id);
    setActionError(null);
    setNotice(null);
    let key = pendingKeys.current.get(id);
    if (!key) {
      key = newIdempotencyKey(`alert-recipient-${action}`);
      pendingKeys.current.set(id, key);
    }
    try {
      const res = await apiFetch<AlertRecipientChange>(
        `/admin/alert-recipients/${category}/${userId}`,
        { method: action === "add" ? "PUT" : "DELETE", idempotencyKey: key },
      );
      pendingKeys.current.delete(id);
      setNotice(
        action === "add"
          ? t(res.changed ? "alerts.done.added" : "alerts.done.already_added")
          : t(res.changed ? "alerts.done.removed" : "alerts.done.already_removed"),
      );
      if (action === "add") setChoice((c) => ({ ...c, [category]: "" }));
      await load();
    } catch (err) {
      // A definite refusal is final; only an unconfirmed outcome (no
      // answer, or a server error) keeps the key for the retry.
      if (err instanceof ApiError && err.status < 500) pendingKeys.current.delete(id);
      if (isForbidden(err)) {
        setForbidden(true);
      } else {
        setActionError(alertRecipientsErrorKey(err));
        if (err instanceof ApiError && err.code === "ALERT_RECIPIENT_NOT_ELIGIBLE") await load();
      }
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  function remove(category: AlertCategory, userId: string, isLast: boolean) {
    if (isLast && !window.confirm(t("alerts.confirm_last_remove"))) return;
    void change("remove", category, userId);
  }

  if (gate.status === "loading") {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 900 }} />
      </div>
    );
  }
  if (gate.status === "forbidden" || forbidden) {
    return (
      <div className="page-shell">
        <EmptyState title={t("alerts.forbidden")} actionHref="/account" actionLabel={t("alerts.forbidden_action")} />
      </div>
    );
  }

  const admins = new Map((overview?.administrators ?? []).map((a) => [a.user_id, a]));
  const adminLabel = (userId: string) => {
    const a = admins.get(userId);
    return `${shortId(userId)} · ${a?.phone_hint ?? ""}`;
  };

  return (
    <div className="page-shell">
      <div className="wide-shell admin-alerts" style={{ maxWidth: 900 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>{t("alerts.title")}</h1>
          <Link href="/admin" className="button-link">{t("alerts.back")}</Link>
        </div>
        <p className="muted admin-alerts-intro">{t("alerts.intro")}</p>

        {actionError && <ErrorBanner message={t(actionError)} />}
        {notice && <p className="notice-banner" role="status">{notice}</p>}

        {!overview ? (
          loadError ? (
            <div>
              <ErrorBanner message={t(loadError)} />
              <button type="button" className="button button-secondary" onClick={() => {
                  setLoadError(null);
                  void load();
                }}>
                {t("alerts.retry")}
              </button>
            </div>
          ) : (
            <div aria-busy="true" aria-label={t("alerts.loading")}>
              <div className="skeleton" style={{ height: 160, width: "100%" }} />
            </div>
          )
        ) : (
          ALERT_CATEGORIES.map((category) => {
            const row = overview.categories.find((c) => c.category === category);
            const recipients = row?.recipient_user_ids ?? [];
            const fallback = row?.delivery !== "SUBSCRIBED";
            const candidates = overview.administrators.filter((a) => !recipients.includes(a.user_id));
            const selectId = `alert-add-${category}`;
            const selected = choice[category] ?? "";
            return (
              <section
                key={category}
                className="card admin-alert-category"
                aria-labelledby={`alert-title-${category}`}
                data-category={category}
              >
                <div className="admin-alert-head">
                  <h2 id={`alert-title-${category}`} className="admin-alert-title">
                    {t(`alerts.category.${category}`)}
                  </h2>
                  <span className={`badge${fallback ? " admin-alert-badge-fallback" : " badge-active"}`}>
                    {fallback
                      ? t("alerts.status.fallback")
                      : t("alerts.status.subscribed").replace("{n}", String(recipients.length))}
                  </span>
                </div>
                <p className="muted admin-alert-desc">{t(`alerts.category.${category}.desc`)}</p>

                {fallback && (
                  <div className="warning-banner" role="note">
                    {t("alerts.fallback_warning").replace("{n}", String(overview.administrators.length))}
                  </div>
                )}

                <h3 className="admin-alert-subtitle">{t("alerts.recipients_label")}</h3>
                {recipients.length === 0 ? (
                  <p className="muted">{t("alerts.no_recipients")}</p>
                ) : (
                  <ul className="admin-alert-list">
                    {recipients.map((userId) => {
                      const id = `remove:${category}:${userId}`;
                      const a = admins.get(userId);
                      return (
                        <li key={userId} className="admin-alert-row">
                          <span
                            className="admin-alert-admin"
                            dir="ltr"
                            aria-label={t("alerts.admin_label")
                              .replace("{id}", shortId(userId))
                              .replace("{phone}", a?.phone_hint.replace(/\D/g, "") ?? "")}
                          >
                            {adminLabel(userId)}
                          </span>
                          <button
                            type="button"
                            className="button button-secondary admin-alert-remove"
                            disabled={busy !== null}
                            onClick={() => remove(category, userId, recipients.length === 1)}
                          >
                            {busy === id ? t("alerts.removing") : t("alerts.remove")}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}

                {candidates.length === 0 ? (
                  <p className="muted">{t("alerts.all_subscribed")}</p>
                ) : (
                  <form
                    className="admin-alert-add"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (selected) void change("add", category, selected);
                    }}
                  >
                    <label htmlFor={selectId}>{t("alerts.add_label")}</label>
                    <div className="admin-alert-add-row">
                      <select
                        id={selectId}
                        dir="ltr"
                        value={selected}
                        disabled={busy !== null}
                        onChange={(e) => setChoice((c) => ({ ...c, [category]: e.target.value }))}
                      >
                        <option value="">{t("alerts.add_placeholder")}</option>
                        {candidates.map((a) => (
                          <option key={a.user_id} value={a.user_id}>
                            {adminLabel(a.user_id)}
                          </option>
                        ))}
                      </select>
                      <button type="submit" className="button" disabled={busy !== null || !selected}>
                        {busy === `add:${category}:${selected}` ? t("alerts.adding") : t("alerts.add")}
                      </button>
                    </div>
                  </form>
                )}
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}
