"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type MouseEvent, useEffect, useState, useSyncExternalStore } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { BagIcon, StoreManageIcon, UserIcon } from "@/components/Icons";
import { workspaceEntry } from "@/lib/nav";
import AddressForm, { SavedAddress } from "@/components/AddressForm";
import { logout } from "@/lib/auth";
import { clearSession } from "@/lib/session";
import { WORKSPACE_EVENT, hasWorkspace, workspaceEntryHref, workspaceSnapshot } from "@/lib/workspaceSession";
import { enterWorkspaceNow } from "@/lib/workspaceActions";
import { useFetch } from "@/lib/useFetch";
import { useHydrated, useSessionToken, useWorkspaces } from "@/lib/useSession";
import { loginRedirectHref, useLoginRedirectHref, useLoginWhenSessionLost } from "@/lib/loginRedirect";

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

// Sprint 13: "حسابي" - the account page (also the mobile bottom-nav
// destination). Profile, quick links, and the workspace switcher:
// customer (shopping), owner (store dashboard) and employee (own branch
// only). The switcher only chooses where to go and remembers the
// choice; every store/branch route is still authorized by the backend.
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
  const addressList = useFetch<SavedAddress[]>(token ? "/customers/me/addresses" : null, true);
  const [added, setAdded] = useState<SavedAddress[]>([]);
  const [showAddressForm, setShowAddressForm] = useState(false);

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
    if (target.closest("button, a, input, select, textarea, label, .hub-tile, .workspace-icon-action, .address-list li, .card")) {
      return;
    }
    window.parent.postMessage({ type: "close-account-overlay" }, window.location.origin);
  }

  // TB-26: choosing a workspace card here IS the explicit step - it enters
  // the workspace at once (the API issues the token after its own checks)
  // and opens its home. If entering fails, the entry page shows why.
  // Shopping is simply the home page.
  async function openWorkspace(w: NonNullable<typeof workspaces>[number]) {
    const entry = workspaceEntry(w);
    if (entry.disabled) return;
    if (w.type === "customer") {
      leaveAccountPanel("/");
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

  if (!hydrated) {
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
        onClick={async () => {
          await logout();
          // An explicit sign-out: a plain sign-in page, no `next`.
          router.replace("/login");
        }}
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
              >
                <span className="workspace-icon-graphic">{icon}</span>
                <span className="workspace-icon-label">{entry.label}</span>
                <span className="workspace-icon-subtitle">{entry.disabled ? "الحساب معلّق" : entry.subtitle}</span>
                {isActive && !entry.disabled && <span className="workspace-icon-active">نشطة الآن</span>}
              </button>
            );
          })}
        </div>

        {/* Sprint 22: links into the new account/addresses/phone/deactivate
            screens - those pages are fully bilingual, this link text stays
            plain Arabic to match this (pre-S22, untouched) page's own style. */}
        <div className="hub-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 8 }}>
          <Link href="/account/addresses" className="hub-tile"><strong>عناويني</strong><span>إدارة العناوين، تعديلها وحذفها</span></Link>
          <Link href="/account/availability-alerts" className="hub-tile"><strong>تنبيهات عودة التوفر</strong><span>الألوان والمقاسات التي تنتظرينها</span></Link>
          <Link href="/account/phone" className="hub-tile"><strong>تغيير رقم الهاتف</strong><span>تحديث رقم الدخول إلى حسابك</span></Link>
          <Link href="/account/deactivate" className="hub-tile"><strong>إغلاق الحساب</strong><span>تعطيل حسابك مؤقتاً</span></Link>
        </div>

        <div className="section-heading">
          <h2>عناوين التوصيل</h2>
          {!showAddressForm && (
            <button className="button-link" onClick={() => setShowAddressForm(true)}>
              + عنوان جديد
            </button>
          )}
        </div>
        {addressList.error && addressList.status !== 401 && <ErrorBanner message={addressList.error} />}
        {showAddressForm && (
          <div className="card" style={{ maxWidth: "none", marginBottom: 12 }}>
            <AddressForm
              onCancel={() => setShowAddressForm(false)}
              onCreated={(a) => {
                setAdded((prev) => [a, ...prev]);
                setShowAddressForm(false);
              }}
            />
          </div>
        )}
        {(() => {
          const all = [...added, ...(addressList.data ?? []).filter((a) => !added.some((n) => n.id === a.id))];
          if (addressList.loading) return <div className="skeleton" style={{ height: 56 }} />;
          if (all.length === 0 && !showAddressForm) {
            return <p className="muted">لا توجد عناوين محفوظة بعد. أضيفي عنواناً لتتمكني من الطلب بالتوصيل.</p>;
          }
          return (
            <ul className="address-list">
              {all.map((a) => (
                <li key={a.id}>
                  <strong>{a.label ?? "عنوان"}</strong>
                  <span className="muted">
                    {a.landmark_note ?? ""} · <span dir="ltr">{a.phone_number_1}</span>
                  </span>
                </li>
              ))}
            </ul>
          );
        })()}

      </div>
    </div>
  );
}
