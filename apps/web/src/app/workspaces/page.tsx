"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/api";
import {
  ActiveWorkspaceRef,
  clearSession,
  getActiveWorkspace,
  getSessionToken,
  setActiveWorkspace,
} from "@/lib/session";

type Workspace =
  | { type: "customer" }
  | {
      type: "vendor";
      vendor_id: string;
      vendor_legal_name: string;
      role: "OWNER" | "BRANCH_EMPLOYEE";
      branch_id: string | null;
      branch_name: string | null;
    };

function workspaceKey(w: Workspace): string {
  return w.type === "customer" ? "customer" : `vendor:${w.vendor_id}`;
}

function sameWorkspace(w: Workspace, active: ActiveWorkspaceRef | null): boolean {
  if (!active) return false;
  if (w.type === "customer") return active.type === "customer";
  return active.type === "vendor" && active.vendor_id === w.vendor_id;
}

function roleLabelAr(role: "OWNER" | "BRANCH_EMPLOYEE"): string {
  return role === "OWNER" ? "مالك المتجر" : "موظف فرع";
}

// Sprint 4 (RB-ROLE-005): the workspace/role switcher's foundation UI -
// "simple" deliberately: it lists every workspace GET /me/workspaces
// returns and lets the viewer mark one as active (a per-browser
// convenience stored via localStorage, see lib/session.ts), nothing
// more. It enforces nothing on its own - PDR-009's real access rules
// live entirely in VendorMembershipGuard on the backend; a later
// sprint's per-workspace screens (branch orders/stock, store
// configuration, ...) are what actually reads this active-workspace
// choice to decide what to render, and still re-checks every action
// against the backend regardless of what this page shows.
export default function WorkspacesPage() {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [active, setActive] = useState<ActiveWorkspaceRef | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getSessionToken()) {
      router.replace("/login");
      return;
    }
    // Same localStorage-after-hydration reasoning as page.tsx's effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActive(getActiveWorkspace());
    apiFetch<{ workspaces: Workspace[] }>("/me/workspaces")
      .then((res) => setWorkspaces(res.workspaces))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          router.replace("/login");
          return;
        }
        setError(
          err instanceof ApiError ? err.message : "تعذّر تحميل مساحات العمل",
        );
      });
  }, [router]);

  function activate(w: Workspace) {
    const ref: ActiveWorkspaceRef =
      w.type === "customer"
        ? { type: "customer" }
        : { type: "vendor", vendor_id: w.vendor_id, branch_id: w.branch_id };
    setActiveWorkspace(ref);
    setActive(ref);
  }

  function logout() {
    clearSession();
    router.replace("/login");
  }

  return (
    <div className="page-shell">
      <div className="top-bar">
        <div className="brand" style={{ margin: 0 }}>
          مساحات العمل
        </div>
        <button className="button-link" onClick={logout}>
          تسجيل الخروج
        </button>
      </div>

      {error && <div className="error-banner" style={{ maxWidth: 560, width: "100%" }}>{error}</div>}

      {workspaces === null && !error && <p className="muted">جارٍ التحميل...</p>}

      {workspaces && (
        <div className="workspace-list">
          {workspaces.map((w) => {
            const isActive = sameWorkspace(w, active);
            return (
              <div
                key={workspaceKey(w)}
                className={`workspace-card${isActive ? " active" : ""}`}
              >
                <div>
                  <div className="workspace-title">
                    {w.type === "customer" ? "زبون" : w.vendor_legal_name}
                  </div>
                  <div className="workspace-subtitle">
                    {w.type === "customer"
                      ? "تصفّح ومقارنة وشراء"
                      : `${roleLabelAr(w.role)}${
                          w.branch_name ? ` — ${w.branch_name}` : ""
                        }`}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className={`badge${isActive ? " badge-active" : ""}`}>
                    {isActive ? "نشطة الآن" : "غير نشطة"}
                  </span>
                  {!isActive && (
                    <button className="button-link" onClick={() => activate(w)}>
                      التبديل إليها
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
