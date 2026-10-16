"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { EmptyState, ErrorBanner, SkeletonGrid } from "@/components/States";
import { apiFetch, ApiError } from "@/lib/api";
import { clearSession } from "@/lib/session";
import { useFetch } from "@/lib/useFetch";
import { useHydrated, useSessionToken } from "@/lib/useSession";

const LOGIN_REDIRECT = "/login?next=/account/favorites";

interface FavoriteDto {
  id: string;
  target_type: "PRODUCT" | "OFFER";
  canonical_product_id: string | null;
  offer_variant_id: string | null;
  name_ar: string | null;
  name_en: string | null;
  vendor_id: string | null;
  created_at: string;
}

type AlertType = "PRICE_DROP" | "BACK_IN_STOCK" | "NEW_OFFER";

interface PreferenceDto {
  alert_type: AlertType;
  enabled: boolean;
}

const ALERT_LABEL: Record<AlertType, string> = {
  PRICE_DROP: "انخفاض السعر",
  BACK_IN_STOCK: "عودة المخزون",
  NEW_OFFER: "عرض جديد لمنتج مفضّل",
};

// Sprint 24 (FR-FAV-001/005): favorited products/offers plus the
// per-alert-type notification toggles. STORE favoriting stays exactly
// "أتابعه" (/following) - never duplicated here. Lives under
// /account/favorites (not a top-level /favorites) by explicit product-
// owner request, matching this page's own reachability from the
// /account hub-grid.
export default function FavoritesPage() {
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const favorites = useFetch<FavoriteDto[]>(token ? "/favorites" : null, true);
  const preferences = useFetch<PreferenceDto[]>(
    token ? "/customers/me/notification-preferences" : null,
    true,
  );
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  // Sprint 24 review fix: never mirror fetched data into local state
  // via an effect (react-hooks/set-state-in-effect) - `overrides` holds
  // ONLY the alert types the customer has toggled THIS session; the
  // rendered value for any other type is simply the server's own
  // answer, computed inline below (same "fetched data + a small
  // optimistic delta, no sync effect" shape account/page.tsx's own
  // address list already uses).
  const [overrides, setOverrides] = useState<Partial<Record<AlertType, boolean>>>({});
  const [savingAlert, setSavingAlert] = useState<AlertType | null>(null);

  useEffect(() => {
    if (favorites.status === 401 || preferences.status === 401) {
      clearSession();
      router.replace(LOGIN_REDIRECT);
    }
  }, [favorites.status, preferences.status, router]);

  useEffect(() => {
    if (hydrated && !token) {
      router.replace(LOGIN_REDIRECT);
    }
  }, [hydrated, token, router]);

  const localPrefs: Record<AlertType, boolean> | null = preferences.data
    ? (() => {
        const next: Record<AlertType, boolean> = {
          PRICE_DROP: true,
          BACK_IN_STOCK: true,
          NEW_OFFER: true,
        };
        for (const p of preferences.data!) next[p.alert_type] = p.enabled;
        return { ...next, ...overrides };
      })()
    : null;

  if (!hydrated || !token) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 96, width: "100%", maxWidth: 1240 }} />
      </div>
    );
  }

  async function removeFavorite(id: string) {
    setRemovedIds((prev) => new Set(prev).add(id));
    try {
      await apiFetch(`/favorites/${id}`, { method: "DELETE" });
    } catch {
      // Non-critical - worst case the item reappears on next load.
    }
  }

  async function toggleAlert(alertType: AlertType) {
    if (!localPrefs) return;
    const next = !localPrefs[alertType];
    setOverrides((prev) => ({ ...prev, [alertType]: next }));
    setSavingAlert(alertType);
    try {
      await apiFetch("/customers/me/notification-preferences", {
        method: "PATCH",
        body: { alert_type: alertType, enabled: next },
      });
    } catch (err) {
      // Revert on failure.
      setOverrides((prev) => ({ ...prev, [alertType]: !next }));
      if (!(err instanceof ApiError)) throw err;
    } finally {
      setSavingAlert(null);
    }
  }

  const items = (favorites.data ?? []).filter((f) => !removedIds.has(f.id));
  const products = items.filter((f) => f.target_type === "PRODUCT");
  const offers = items.filter((f) => f.target_type === "OFFER");

  function hrefFor(f: FavoriteDto): string {
    if (f.target_type === "PRODUCT" && f.canonical_product_id) {
      return `/compare/${f.canonical_product_id}`;
    }
    return "/discovery";
  }

  function card(f: FavoriteDto) {
    return (
      <div key={f.id} className="card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <Link href={hrefFor(f)} style={{ textDecoration: "none", color: "inherit" }}>
          <strong>{f.name_ar ?? f.name_en ?? "منتج"}</strong>
        </Link>
        <span className="muted" style={{ fontSize: 13 }}>
          {f.target_type === "PRODUCT" ? "منتج" : "عرض محدد من متجر"}
        </span>
        <button className="button-link" onClick={() => removeFavorite(f.id)}>
          إزالة من المفضلة
        </button>
      </div>
    );
  }

  const loading = favorites.loading;
  const noFavorites = !loading && items.length === 0;

  return (
    <div className="page-shell">
      <div className="wide-shell">
        <h1 className="page-title">المفضلة</h1>
        <p className="page-subtitle">المنتجات والعروض التي حفظتِها.</p>

        {favorites.error && favorites.status !== 401 && (
          <ErrorBanner message={favorites.error} />
        )}

        {localPrefs && (
          <div className="card" style={{ marginBottom: 20 }}>
            <strong style={{ display: "block", marginBottom: 8 }}>تنبيهات المفضلة</strong>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
              {(Object.keys(ALERT_LABEL) as AlertType[]).map((alertType) => (
                <label
                  key={alertType}
                  style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
                >
                  <input
                    type="checkbox"
                    checked={localPrefs[alertType]}
                    disabled={savingAlert === alertType}
                    onChange={() => toggleAlert(alertType)}
                  />
                  {ALERT_LABEL[alertType]}
                </label>
              ))}
            </div>
          </div>
        )}

        {loading && <SkeletonGrid count={4} />}

        {noFavorites && (
          <EmptyState
            title="لا توجد عناصر في مفضلتك بعد"
            message="أضيفي منتجاً أو عرضاً من صفحته الخاصة."
            actionHref="/discovery"
            actionLabel="اكتشفي المنتجات"
          />
        )}

        {products.length > 0 && (
          <>
            <div className="section-heading">
              <h2>المنتجات المفضّلة</h2>
            </div>
            <div className="product-grid">{products.map(card)}</div>
          </>
        )}

        {offers.length > 0 && (
          <>
            <div className="section-heading">
              <h2>العروض المفضّلة</h2>
            </div>
            <div className="product-grid">{offers.map(card)}</div>
          </>
        )}

        <div style={{ marginTop: 20 }}>
          <Link href="/compare/sets" className="button-link">
            مجموعات المقارنة المحفوظة
          </Link>
        </div>
      </div>
    </div>
  );
}
