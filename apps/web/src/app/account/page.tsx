"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { workspaceEntry } from "@/lib/nav";
import AddressForm, { SavedAddress } from "@/components/AddressForm";
import { logout } from "@/lib/auth";
import { clearSession, setActiveWorkspace } from "@/lib/session";
import { useFetch } from "@/lib/useFetch";
import { useActiveWorkspace, useHydrated, useSessionToken, useWorkspaces } from "@/lib/useSession";

interface MeDto {
  id: string;
  phone: string;
  display_name: string | null;
}

// Sprint 13: "حسابي" - the account page (also the mobile bottom-nav
// destination). Profile, quick links, and the workspace switcher:
// customer (shopping), owner (store dashboard) and employee (own branch
// only). The switcher only chooses where to go and remembers the
// choice; every store/branch route is still authorized by the backend.
export default function AccountPage() {
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const me = useFetch<MeDto>(token ? "/customers/me" : null, true);
  const workspaces = useWorkspaces(token);
  const active = useActiveWorkspace();
  const addressList = useFetch<SavedAddress[]>(token ? "/customers/me/addresses" : null, true);
  const [added, setAdded] = useState<SavedAddress[]>([]);
  const [showAddressForm, setShowAddressForm] = useState(false);

  useEffect(() => {
    if (me.status === 401) {
      clearSession();
      router.replace("/login?next=/account");
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
          actionHref="/login?next=/account"
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
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 720 }}>
        <h1 className="page-title">حسابي</h1>
        {me.error && me.status !== 401 && <ErrorBanner message={me.error} />}
        {me.data && (
          <p className="page-subtitle">
            {me.data.display_name ? `${me.data.display_name} - ` : ""}
            <span dir="ltr">{me.data.phone}</span>
          </p>
        )}

        <div className="hub-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 8 }}>
          <Link href="/orders" className="hub-tile"><strong>طلباتي</strong><span>تتبّع طلباتك وأكّدي الاستلام</span></Link>
          <Link href="/following" className="hub-tile"><strong>أتابعه</strong><span>المتاجر التي تتابعينها</span></Link>
          <Link href="/cart" className="hub-tile"><strong>السلة</strong><span>عناصرك المحفوظة</span></Link>
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

        <div className="section-heading">
          <h2>مساحات العمل</h2>
        </div>
        {workspaces === null && <p className="muted">جارٍ التحميل...</p>}
        <div className="workspace-list" style={{ maxWidth: "none" }}>
          {workspaces?.map((w) => {
            const entry = workspaceEntry(w);
            const isActive =
              active === null
                ? w.type === "customer"
                : w.type === "customer"
                  ? active.type === "customer"
                  : active.type === "vendor" && active.vendor_id === w.vendor_id;
            return (
              <div key={entry.id} className={`workspace-card${isActive ? " active" : ""}`}>
                <div>
                  <div className="workspace-title">{entry.label}</div>
                  <div className="workspace-subtitle">{entry.subtitle}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {isActive && <span className="badge badge-active">نشطة الآن</span>}
                  <button
                    className="button"
                    onClick={() => {
                      setActiveWorkspace(
                        w.type === "customer"
                          ? { type: "customer" }
                          : { type: "vendor", vendor_id: w.vendor_id, branch_id: w.branch_id },
                      );
                      router.push(entry.href);
                    }}
                  >
                    {entry.kind === "customer" ? "التسوّق" : entry.kind === "owner" ? "لوحة المتجر" : "طلبات الفرع"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ marginTop: 24 }}>
          <button
            className="button button-secondary"
            onClick={async () => {
              await logout();
              router.replace("/login");
            }}
          >
            تسجيل الخروج
          </button>
        </div>
      </div>
    </div>
  );
}
