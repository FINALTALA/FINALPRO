"use client";

import { exactTime, relativeTime, statusKey, type TimelineActor, type TimelineEvent } from "@/lib/branchOrders";
import { fillBo } from "@/lib/branchOrdersText";
import type { Lang } from "@/lib/i18n";

/** Who did it, in words - only what the server let this viewer see. */
export function actorLabel(a: TimelineActor, t: (k: string) => string): { who: string; extra: string | null } {
  switch (a.kind) {
    case "system":
    case "customer":
    case "platform":
    case "employee_other_branch":
      return { who: t(`bo.actor.${a.kind}`), extra: null };
    case "owner":
      return { who: a.name ? `${a.name} · ${t("bo.actor.owner")}` : t("bo.actor.owner"), extra: null };
    case "employee": {
      const who = a.name ? `${a.name} · ${t("bo.actor.employee")}` : t("bo.actor.employee");
      const parts: string[] = [];
      if (a.branch_name) parts.push(fillBo(t("bo.actor.branch"), { b: a.branch_name }));
      if (a.other_branch) parts.push(t("bo.actor.other_branch"));
      return { who, extra: parts.length ? parts.join(" · ") : null };
    }
    case "unrecorded":
    default:
      return {
        who: "name" in a && a.name ? `${a.name} · ${t("bo.actor.unrecorded")}` : t("bo.actor.unrecorded"),
        extra: null,
      };
  }
}

function Arrow() {
  return (
    <svg className="bo-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

/** The order's activity, newest first: who (role and branch AT THAT TIME), what, when. */
export default function OrderTimeline({
  events,
  truncated,
  lang,
  t,
}: {
  events: TimelineEvent[] | null;
  truncated: boolean;
  lang: Lang;
  t: (k: string) => string;
}) {
  if (!events) return <div className="skeleton" style={{ height: 80, width: "100%" }} />;
  if (events.length === 0) return <p className="bo-muted">{t("bo.tl.empty")}</p>;
  return (
    <>
      <ol className="bo-timeline" data-testid="bo-timeline">
        {events.map((e) => {
          const { who, extra } = actorLabel(e.actor, t);
          return (
            <li key={e.id} className="bo-tl-item" data-testid="bo-tl-item" data-kind={e.kind}>
              <span className="bo-tl-dot" aria-hidden="true" />
              <div className="bo-tl-body">
                <p className="bo-tl-what">
                  <strong>{t(`bo.tl.${e.kind}`)}</strong>
                  {e.kind === "status" && e.from_status && e.to_status && (
                    <span className="bo-tl-change">
                      <span className="visually-hidden">
                        {fillBo(t("bo.status_from_to"), { a: t(statusKey(e.from_status)), b: t(statusKey(e.to_status)) })}
                      </span>
                      <span className={`bo-chip is-${e.from_status.toLowerCase()}`} aria-hidden="true">{t(statusKey(e.from_status))}</span>
                      <Arrow />
                      <span className={`bo-chip is-${e.to_status.toLowerCase()}`} aria-hidden="true">{t(statusKey(e.to_status))}</span>
                    </span>
                  )}
                </p>
                <p className="bo-tl-who" data-testid="bo-tl-actor">
                  <span dir="auto">{who}</span>
                  {extra && <span className="bo-muted"> · {extra}</span>}
                </p>
                {e.reason && <p className="bo-tl-reason" dir="auto">{fillBo(t("bo.tl.reason"), { r: e.reason })}</p>}
                <p className="bo-tl-when">
                  <time dateTime={e.at} title={exactTime(e.at, lang)}>{relativeTime(e.at, lang)}</time>
                  <span className="bo-muted"> · {exactTime(e.at, lang)}</span>
                </p>
              </div>
            </li>
          );
        })}
      </ol>
      {truncated && <p className="bo-muted">{t("bo.tl.truncated")}</p>}
    </>
  );
}
