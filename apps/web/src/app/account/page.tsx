"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type MouseEvent, useEffect, useSyncExternalStore } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { BagIcon, StoreManageIcon, UserIcon } from "@/components/Icons";
import { workspaceEntry } from "@/lib/nav";
import { signOutToLogin } from "@/lib/auth";
import { clearSession } from "@/lib/session";
import { WORKSPACE_EVENT, hasWorkspace, workspaceEntryHref, workspaceSnapshot } from "@/lib/workspaceSession";
import { enterWorkspaceNow } from "@/lib/workspaceActions";
import { useFetch } from "@/lib/useFetch";
import { useHydrated, useSessionToken, useWorkspaces } from "@/lib/useSession";
import { loginRedirectHref, useLoginRedirectHref, useLoginWhenSessionLost } from "@/lib/loginRedirect";
import { SETTINGS_HREF } from "@/lib/accountSettingsText";

interface MeDto {
  id: string;
  phone: string;
  display_name: string | null;
}

function anyWorkspaceEntered(snapshot: string): boolean {
  try {
    const s = JSON.parse(snapshot) as { v?: string[]; p?: boolean };
    return Boolean(s.p) || (s.v?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

function subscribeWorkspaces(onChange: () => void): () => void {
  window.addEventListener(WORKSPACE_EVENT, onChange);
  return () => window.removeEventListener(WORKSPACE_EVENT, onChange);
}

// Whether this page is open inside the account overlay's iframe
// (/account?embed=account). Only the click handlers below need it, so it
// is read from the URL at click time - never during render, which keeps
// this page statically prerenderable without a Suspense boundary.
const inAccountOverlay = () =>
  new URLSearchParams(window.location.search).get("embed") === "account";

// Sprint 13: "حسابي" - the workspace chooser (also the mobile bottom-nav
// destination): shopping, the owner's store, the employee's branch, the
// platform. 2026-11-24: it is the chooser only - an account with nothing
// but shopping never sees it (it goes straight to its personal page), the
// shopping card opens that same personal page, and the account's own
// settings (addresses, back-in-stock alerts, phone, sign-out, closing the
// account) live in the personal page's «إعدادات المستخدم». The chooser only
// chooses where to go; every store/branch route is still authorized by the
// backend.
export default function AccountPage() {
  const loginLink = useLoginRedirectHref();
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  // TB-34: a session lost to a 401 goes to sign-in (with `next` = this page) rather than showing the sign-in button.
  useLoginWhenSessionLost(hydrated, token);
  const me = useFetch<MeDto>(token ? "/customers/me" : null, true);
  const workspaces = useWorkspaces(token);
  const wsSnapshot = useSyncExternalStore(subscribeWorkspaces, workspaceSnapshot, () => "");
  const shoppingOnly = workspaces !== null && workspaces.every((w) => w.type === "customer");

  function leaveAccountPanel(path: string) {
    // A workspace is a destination, not a nested account detail. When this
    // hub is rendered in the account overlay, navigate the parent window so
    // the selected workspace resumes as a normal full page.
    if (inAccountOverlay() && window.parent !== window) {
      window.parent.location.assign(path);
      return;
    }
    router.push(path);
  }

  function closeOnAccountBackground(event: MouseEvent<HTMLDivElement>) {
    if (!inAccountOverlay() || window.parent === window) return;
    const target = event.target as HTMLElement;
    // Cards and every useful control keep their natural click behavior.
    // Only the deliberately empty account backdrop dismisses the overlay.
    if (target.closest("button, a, input, select, textarea, label, .hub-tile, .workspace-icon-action, .card")) {
      return;
    }
    window.parent.postMessage({ type: "close-account-overlay" }, window.location.origin);
  }

  // TB-26: choosing a workspace card here IS the explicit step - it enters
  // the workspace at once (the API issues the token after its own checks)
  // and opens its home. If entering fails, the entry page shows why.
  // Shopping is the personal page (2026-11-24).
  async function openWorkspace(w: NonNullable<typeof workspaces>[number]) {
    const entry = workspaceEntry(w);
    if (entry.disabled) return;
    if (w.type === "customer") {
      leaveAccountPanel(entry.href);
      return;
    }
    const ref = w.type === "platform" ? ({ type: "platform" } as const) : ({ type: "vendor", vendor_id: w.vendor_id } as const);
    try {
      await enterWorkspaceNow(ref);
      leaveAccountPanel(entry.href);
    } catch {
      leaveAccountPanel(workspaceEntryHref(ref, entry.href));
    }
  }

  useEffect(() => {
    if (me.status === 401) {
      clearSession();
      router.replace(loginRedirectHref());
    }
  }, [me.status, router]);

  // shopping only: no chooser - the personal page itself
  useEffect(() => {
    if (!shoppingOnly) return;
    if (inAccountOverlay() && window.parent !== window) window.parent.location.assign("/profile");
    else router.replace("/profile");
  }, [shoppingOnly, router]);

  if (!hydrated || shoppingOnly) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 96, width: "100%", maxWidth: 720 }} />
      </div>
    );
  }

  if (!token) {
    return (
      <div className="page-shell">
        <EmptyState
          title="سجّلي الدخول للوصول إلى حسابك"
          actionHref={loginLink}
          actionLabel="تسجيل الدخول"
        >
          <p style={{ marginTop: 14 }}>
            ليس لديك حساب؟ <Link href="/register">إنشاء حساب</Link>
          </p>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="page-shell" onMouseDown={closeOnAccountBackground}>
      <button
        className="button button-secondary account-signout"
        onClick={() => void signOutToLogin()}
        data-testid="account-signout"
      >
        تسجيل الخروج
      </button>
      <div className="wide-shell" style={{ maxWidth: 720 }}>
        <h1 className="page-title">حسابي</h1>
        {me.error && me.status !== 401 && <ErrorBanner message={me.error} />}
        {me.data && (
          <p className="page-subtitle">
            {me.data.display_name ? `${me.data.display_name} - ` : ""}
            <span dir="ltr">{me.data.phone}</span>
          </p>
        )}

        {workspaces === null && <p className="muted">جارٍ التحميل...</p>}
        <div className="workspace-list workspace-icon-list" style={{ maxWidth: "none" }}>
          {workspaces?.map((w) => {
            const entry = workspaceEntry(w);
            // TB-26: shopping is always this page's context; a workspace is
            // marked when this tab has entered it.
            const isActive =
              w.type === "customer"
                ? !anyWorkspaceEntered(wsSnapshot)
                : hydrated && wsSnapshot !== "" &&
                  hasWorkspace(w.type === "platform" ? { type: "platform" } : { type: "vendor", vendor_id: w.vendor_id });
            const icon = entry.kind === "customer"
              ? <BagIcon />
              : entry.kind === "owner"
                ? <StoreManageIcon />
                : <UserIcon />;
            return (
              <button
                key={entry.id}
                type="button"
                className={`workspace-icon-action${isActive ? " active" : ""}`}
                disabled={entry.disabled}
                onClick={() => openWorkspace(w)}
                data-testid={`account-workspace-${entry.kind}`}
              >
                <span className="workspace-icon-graphic">{icon}</span>
                <span className="workspace-icon-label">{entry.label}</span>
                <span className="workspace-icon-subtitle">{entry.disabled ? "الحساب معلّق" : entry.subtitle}</span>
                {isActive && !entry.disabled && <span className="workspace-icon-active">نشطة الآن</span>}
              </button>
            );
          })}
        </div>

        {/* The account's own settings are one place for every context: the
            personal page's «إعدادات المستخدم» (not store settings). */}
        <p className="account-settings-link">
          <a
            href={SETTINGS_HREF}
            className="button-link"
            onClick={(event) => {
              event.preventDefault();
              leaveAccountPanel(SETTINGS_HREF);
            }}
            data-testid="account-settings-link"
          >
            إعدادات الحساب: العناوين، التنبيهات، رقم الهاتف وإغلاق الحساب
          </a>
        </p>
      </div>
    </div>
  );
}
