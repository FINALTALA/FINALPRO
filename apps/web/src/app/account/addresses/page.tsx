"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ErrorBanner, EmptyState } from "@/components/States";
import AddressForm, { SavedAddress } from "@/components/AddressForm";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { clearSession } from "@/lib/session";
import { registerTranslations } from "@/lib/i18n";
import { useT } from "@/lib/useLang";
import { useFetch } from "@/lib/useFetch";
import { useHydrated, useSessionToken } from "@/lib/useSession";

registerTranslations({
  ar: {
    "addresses.title": "عناويني",
    "addresses.add": "+ عنوان جديد",
    "addresses.empty": "لا توجد عناوين محفوظة بعد.",
    "addresses.default_badge": "الافتراضي",
    "addresses.edit": "تعديل",
    "addresses.delete": "حذف",
    "addresses.delete_confirm": "حذف هذا العنوان؟ إن كان قد استُخدم في طلب سابق سيُؤرشَف بدلاً من حذفه نهائياً.",
    "addresses.delete_failed": "تعذّر حذف العنوان",
    "addresses.load_failed": "تعذّر تحميل العناوين",
    "addresses.login_required": "سجّلي الدخول لإدارة عناوينك",
    "addresses.login_action": "تسجيل الدخول",
  },
  en: {
    "addresses.title": "My addresses",
    "addresses.add": "+ New address",
    "addresses.empty": "No saved addresses yet.",
    "addresses.default_badge": "Default",
    "addresses.edit": "Edit",
    "addresses.delete": "Delete",
    "addresses.delete_confirm": "Delete this address? If it was used on a past order it will be archived instead of permanently deleted.",
    "addresses.delete_failed": "Couldn't delete the address",
    "addresses.load_failed": "Couldn't load addresses",
    "addresses.login_required": "Sign in to manage your addresses",
    "addresses.login_action": "Sign in",
  },
});

// Sprint 22 (FR-AUTH-008, PDR-029): the full addresses management
// screen - edit, delete (hard-delete or archive, decided server-side
// by whether the address was ever referenced by an order) and
// set-default, on top of the create flow the pre-S22 /account page
// already had inline. A brand-new route, not a retrofit of that page.
export default function AddressesPage() {
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const t = useT();
  const list = useFetch<SavedAddress[]>(token ? "/customers/me/addresses" : null, true);
  const [items, setItems] = useState<SavedAddress[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const addresses = items ?? list.data;

  function replaceOrAppend(a: SavedAddress) {
    setItems((prev) => {
      const base = prev ?? list.data ?? [];
      const exists = base.some((x) => x.id === a.id);
      // Editing/setting a default can change OTHER rows too (the
      // previous default loses is_default) - safest to just reload.
      if (exists) return base.map((x) => (x.id === a.id ? a : x));
      return [a, ...base];
    });
  }

  async function reload() {
    try {
      const fresh = await apiFetch<SavedAddress[]>("/customers/me/addresses");
      setItems(fresh);
    } catch {
      // Keep whatever is currently shown - a transient refresh failure
      // isn't worth surfacing over the action that already succeeded.
    }
  }

  async function deleteAddress(id: string) {
    if (typeof window !== "undefined" && !window.confirm(t("addresses.delete_confirm"))) return;
    setBusyId(id);
    setError(null);
    try {
      await apiFetch(`/customers/me/addresses/${id}`, {
        method: "DELETE",
        idempotencyKey: newIdempotencyKey("address-delete"),
      });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("addresses.delete_failed"));
    } finally {
      setBusyId(null);
    }
  }

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
        <EmptyState title={t("addresses.login_required")} actionHref="/login?next=/account/addresses" actionLabel={t("addresses.login_action")} />
      </div>
    );
  }

  if (list.status === 401) {
    clearSession();
    router.replace("/login?next=/account/addresses");
    return null;
  }

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 720 }}>
        <div className="section-heading">
          <h1 className="page-title" style={{ margin: 0 }}>{t("addresses.title")}</h1>
          {!showCreate && !editingId && (
            <button className="button-link" onClick={() => setShowCreate(true)}>
              {t("addresses.add")}
            </button>
          )}
        </div>

        {error && <ErrorBanner message={error} />}
        {list.error && list.status !== 401 && <ErrorBanner message={list.error} />}

        {showCreate && (
          <div className="card" style={{ maxWidth: "none", marginBottom: 12 }}>
            <AddressForm
              onCancel={() => setShowCreate(false)}
              onCreated={(a) => {
                replaceOrAppend(a);
                setShowCreate(false);
              }}
            />
          </div>
        )}

        {list.loading && !addresses && <div className="skeleton" style={{ height: 56 }} />}
        {addresses && addresses.length === 0 && !showCreate && (
          <p className="muted">{t("addresses.empty")}</p>
        )}

        <ul className="address-list" style={{ listStyle: "none", padding: 0 }}>
          {addresses?.map((a) =>
            editingId === a.id ? (
              <li key={a.id} className="card" style={{ maxWidth: "none", marginBottom: 12 }}>
                <AddressForm
                  address={a}
                  onCancel={() => setEditingId(null)}
                  onSaved={async () => {
                    setEditingId(null);
                    await reload();
                  }}
                />
              </li>
            ) : (
              <li key={a.id} className="card" style={{ maxWidth: "none", marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <strong>{a.label ?? t("address.field.label_placeholder")}</strong>
                  {a.is_default && <span className="badge badge-active">{t("addresses.default_badge")}</span>}
                </div>
                <div className="muted">
                  {a.landmark_note ?? ""} · <span dir="ltr">{a.phone_number_1}</span>
                </div>
                <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                  <button className="button-link" onClick={() => setEditingId(a.id)}>
                    {t("addresses.edit")}
                  </button>
                  <button
                    className="button-link"
                    disabled={busyId === a.id}
                    onClick={() => deleteAddress(a.id)}
                  >
                    {t("addresses.delete")}
                  </button>
                </div>
              </li>
            ),
          )}
        </ul>

        <p className="muted" style={{ marginTop: 16 }}>
          <Link href="/account">{t("common.back")}</Link>
        </p>
      </div>
    </div>
  );
}
