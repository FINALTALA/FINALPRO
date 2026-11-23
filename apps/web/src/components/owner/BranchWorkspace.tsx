"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ApiError, apiFetch } from "@/lib/api";
import "@/lib/branchesText";
import { fillBr } from "@/lib/branchesText";
import { useHydrated, useSessionToken, useWorkspaces } from "@/lib/useSession";
import { useT } from "@/lib/useLang";

export interface BranchDto {
  id: string;
  name: string;
  is_physical: boolean;
  verification_status: string;
  archived_at: string | null;
}

/** The branch's daily tools (one bar). Its settings are an action in the header, not a tab. */
export type BranchTab = "orders" | "stock" | "delivery-windows" | "hours" | "returns";
export type BranchView = "overview" | BranchTab | "settings";
/** The owner manages everything of a branch; an employee keeps the tools she already had (the API decides anyway). */
const OWNER_TABS: BranchTab[] = ["orders", "stock", "delivery-windows", "hours", "returns"];
// «نوافذ التوصيل v1» + «ساعات العمل والإغلاقات v1»: the branch employee reads
// their branch's delivery board and opening hours (no actions).
const EMPLOYEE_TABS: BranchTab[] = ["orders", "stock", "delivery-windows", "hours", "returns"];
export const BRANCH_TABS: BranchTab[] = OWNER_TABS;

/** Fired after a branch changed (archived): every view of the branches loads them again. */
export const BRANCHES_CHANGED = "finalpro:branches-changed";

const currentKey = (vendorId: string) => `fp.branch.current.${vendorId}`;
export function readCurrentBranch(vendorId: string): string | null {
  try {
    return window.localStorage.getItem(currentKey(vendorId));
  } catch {
    return null;
  }
}
export function writeCurrentBranch(vendorId: string, branchId: string | null) {
  try {
    if (branchId) window.localStorage.setItem(currentKey(vendorId), branchId);
    else window.localStorage.removeItem(currentKey(vendorId));
  } catch {
    // storage blocked: the first branch is shown next time
  }
}

/**
 * Who is managing (owner: every branch; employee: her own one only) and the
 * store's branches - the same GET the old list used (the server already
 * returns only the employee's own branch to an employee).
 */
export function useBranchWorkspace(vendorId: string) {
  const hydrated = useHydrated();
  const token = useSessionToken();
  const workspaces = useWorkspaces(token);
  const membership = workspaces?.find((w) => w.type === "vendor" && w.vendor_id === vendorId) ?? null;
  const isOwner = membership?.type === "vendor" && membership.role === "OWNER";
  const ownBranchId = membership?.type === "vendor" && membership.role === "BRANCH_EMPLOYEE" ? membership.branch_id : null;
  const [branches, setBranches] = useState<BranchDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  // a change made on one screen (archiving) refreshes the dashboard around it too
  useEffect(() => {
    const again = () => setVersion((v) => v + 1);
    window.addEventListener(BRANCHES_CHANGED, again);
    return () => window.removeEventListener(BRANCHES_CHANGED, again);
  }, []);
  useEffect(() => {
    if (!hydrated || !token) return;
    let cancelled = false;
    apiFetch<BranchDto[]>(`/vendors/${vendorId}/branches`)
      .then((data) => {
        if (cancelled) return;
        setError(null);
        setBranches(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError && err.message ? err.message : "");
      });
    return () => {
      cancelled = true;
    };
  }, [hydrated, token, vendorId, version]);
  return {
    hydrated,
    token,
    ready: hydrated && Boolean(token) && workspaces !== null,
    isOwner,
    ownBranchId,
    branches,
    active: (branches ?? []).filter((b) => !b.archived_at),
    error,
    reload: () => setVersion((v) => v + 1),
    tabs: isOwner ? OWNER_TABS : EMPLOYEE_TABS,
  };
}
export type BranchWs = ReturnType<typeof useBranchWorkspace>;

export const branchViewHref = (vendorId: string, branchId: string, view: BranchView) =>
  view === "overview" ? `/vendor/${vendorId}/branches/${branchId}` : `/vendor/${vendorId}/branches/${branchId}/${view}`;

/* simple line icons (currentColor) - one per tool */
const PATHS: Record<BranchView | "pin" | "plus" | "chevron", ReactNode> = {
  overview: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>,
  orders: <><path d="M8 4h8l1 2h2v14H5V6h2z" /><path d="M9 11h6M9 15h4" /></>,
  stock: <><path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z" /><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9" /></>,
  "delivery-windows": <><path d="M3 6h11v10H3zM14 9h4l3 3v4h-7" /><circle cx="7" cy="17.5" r="1.8" /><circle cx="17" cy="17.5" r="1.8" /></>,
  hours: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  returns: <><path d="M9 7 5 11l4 4" /><path d="M5 11h9a5 5 0 0 1 0 10h-2" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2.8v2.4M12 18.8v2.4M4.2 7.5l2.1 1.2M17.7 15.3l2.1 1.2M4.2 16.5l2.1-1.2M17.7 8.7l2.1-1.2" /></>,
  pin: <><path d="M12 21s-6.5-6.2-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 14.8 12 21 12 21z" /><circle cx="12" cy="9.8" r="2.3" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  chevron: <path d="m6 9 6 6 6-6" />,
};
export function BranchIcon({ name, size = 18 }: { name: keyof typeof PATHS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="br-icon">
      {PATHS[name]}
    </svg>
  );
}

/**
 * «إدارة الفروع» as ONE branch dashboard: a context header (the current
 * branch's name and status dot, its type / verification / status as one
 * quiet line, the branch picker with its pin and «إضافة فرع» beside it),
 * then the branch's tools as one bar (the open one in wine), then the work
 * area - the only part that changes. Moving between the branch's tools is
 * not a step: the frame's «رجوع» appears only for a screen opened from here
 * («إضافة فرع», «إعدادات الفرع», «إعدادات المتجر»), and returns to the same
 * branch and tool. The owner's «إعدادات المتجر» sits by the «إدارة الفروع»
 * title (it applies to every branch); «إعدادات الفرع» beside the picker.
 */
export function BranchShell({
  vendorId,
  ws,
  current,
  view,
  children,
}: {
  vendorId: string;
  ws: BranchWs;
  current: BranchDto | null;
  view: BranchView;
  children: ReactNode;
}) {
  const t = useT();
  const router = useRouter();
  const options = !current || ws.active.some((b) => b.id === current.id) ? ws.active : [current, ...ws.active];
  const views: BranchView[] = ["overview", ...ws.tabs];
  const settingsHref = current ? branchViewHref(vendorId, current.id, "settings") : null;
  const switchTo = (id: string) => {
    writeCurrentBranch(vendorId, id);
    router.replace(branchViewHref(vendorId, id, view));
  };
  const v = current ? `br.v.${current.verification_status}` : "";
  return (
    <div className="br-ws br-dash" data-testid="branch-workspace">
      <header className="br-head" data-testid="br-bar">
        <div className="br-head-main">
          <div className="br-eyebrow-row">
            <p className="br-eyebrow">{t("br.title")}</p>
            {ws.isOwner && (
              <Link href={`/vendor/${vendorId}/settings`} className="br-store-settings" title={t("br.store_settings.hint")} data-testid="br-store-settings">
                <BranchIcon name="settings" size={16} />
                <span>{t("br.store_settings")}</span>
                <span className="br-store-settings-scope">{t("br.store_settings.scope")}</span>
              </Link>
            )}
          </div>
          {current && (
            <>
              <h1 className="br-name" dir="auto">
                <span className={`br-dot${current.archived_at ? " is-archived" : ""}`} aria-hidden="true" />
                <span data-testid="br-current-name">{current.name}</span>
              </h1>
              <p className="br-meta" data-testid="br-meta">
                <span>{current.is_physical ? t("br.kind.physical") : t("br.kind.fulfilment")}</span>
                <span>{t("br.verification")}: {t(v) !== v ? t(v) : current.verification_status}</span>
                <span className={current.archived_at ? "br-meta-archived" : "br-meta-active"} data-testid="br-state">
                  {current.archived_at ? t("br.state.archived") : t("br.state.active")}
                </span>
              </p>
            </>
          )}
        </div>
        <div className="br-head-actions">
          {ws.isOwner && options.length > 0 ? (
            <label className="br-picker">
              <BranchIcon name="pin" />
              <span className="visually-hidden">{t("br.switch")}</span>
              <select value={current?.id ?? ""} onChange={(e) => switchTo(e.target.value)} aria-label={t("br.switch")} data-testid="br-switch">
                {options.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                    {b.archived_at ? ` ${t("br.archived_tag")}` : ""}
                  </option>
                ))}
              </select>
              <span className="br-picker-chevron"><BranchIcon name="chevron" size={16} /></span>
            </label>
          ) : current ? (
            <p className="br-picker is-fixed">
              <BranchIcon name="pin" />
              <span>{t("br.my_branch")}:</span> <strong data-testid="br-fixed">{current.name}</strong>
            </p>
          ) : null}
          {ws.isOwner && settingsHref && (
            <Link
              href={settingsHref}
              className={`br-branch-settings${view === "settings" ? " is-active" : ""}`}
              aria-current={view === "settings" ? "page" : undefined}
              aria-label={fillBr(t("br.branch_settings.for"), { name: current?.name ?? "" })}
              title={fillBr(t("br.branch_settings.for"), { name: current?.name ?? "" })}
              data-testid="br-branch-settings"
            >
              <BranchIcon name="settings" size={17} />
              <span className="br-branch-settings-text">{t("br.branch_settings")}</span>
            </Link>
          )}
          {ws.isOwner && (
            <Link href={`/vendor/${vendorId}/branches/new`} className="br-add" data-testid="br-add">
              <BranchIcon name="plus" size={16} /> {t("br.add")}
            </Link>
          )}
        </div>
      </header>
      {current && (
        <nav className="br-tools" aria-label={t("br.tools")} data-testid="br-tabs">
          {views.map((k) => (
            <Link
              key={k}
              href={branchViewHref(vendorId, current.id, k)}
              // one screen: moving between tools is replaced, not a step back
              replace
              className={`br-tool${view === k ? " is-active" : ""}`}
              aria-current={view === k ? "page" : undefined}
              data-testid={`br-tab-${k}`}
            >
              <BranchIcon name={k} />
              <span>{t(`br.nav.${k}`)}</span>
            </Link>
          ))}
        </nav>
      )}
      <div className="br-work">{children}</div>
    </div>
  );
}

/** «نظرة عامة»: one wide card of what is known of the branch (no new numbers), then where to start. */
export function BranchOverview({ vendorId, ws, branch }: { vendorId: string; ws: BranchWs; branch: BranchDto }) {
  const t = useT();
  const v = `br.v.${branch.verification_status}`;
  const start: BranchTab[] = ws.isOwner ? ["orders", "stock", "hours"] : ["orders", "stock", "returns"];
  return (
    <div className="br-overview" data-testid="br-summary">
      <section className="br-card" aria-labelledby="br-card-title">
        <h2 id="br-card-title" dir="auto">{branch.name}</h2>
        <dl className="br-facts">
          <div>
            <dt>{t("br.kind")}</dt>
            <dd>{branch.is_physical ? t("br.kind.physical") : t("br.kind.fulfilment")}</dd>
          </div>
          <div>
            <dt>{t("br.state")}</dt>
            <dd>
              <span className={`br-dot${branch.archived_at ? " is-archived" : ""}`} aria-hidden="true" />
              {branch.archived_at ? t("br.state.archived") : t("br.state.active")}
            </dd>
          </div>
          <div>
            <dt>{t("br.verification")}</dt>
            <dd>{t(v) !== v ? t(v) : branch.verification_status}</dd>
          </div>
          {ws.isOwner && (
            <div>
              <dt>{t("br.active_n")}</dt>
              <dd data-testid="br-active-count">{ws.active.length}</dd>
            </div>
          )}
        </dl>
      </section>
      <section className="br-start" aria-labelledby="br-start-title">
        <h3 id="br-start-title">{t("br.start")}</h3>
        <ul>
          {start.map((k) => (
            <li key={k}>
              <Link href={branchViewHref(vendorId, branch.id, k)} replace className="br-start-link" data-testid={`br-link-${k}`}>
                <span className="br-start-icon"><BranchIcon name={k} size={20} /></span>
                <span className="br-start-text">
                  <strong>{t(`br.nav.${k}`)}</strong>
                  <span>{t(`br.start.${k}`)}</span>
                </span>
                <span className="br-start-go" aria-hidden="true">‹</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export { fillBr };
