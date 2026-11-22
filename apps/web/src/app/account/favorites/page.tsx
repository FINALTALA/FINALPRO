"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { EmptyState, ErrorBanner, SkeletonGrid } from "@/components/States";
import { BellIcon } from "@/components/Icons";
import ProductCard from "@/components/ProductCard";
import { apiFetch, ApiError } from "@/lib/api";
import { clearSession } from "@/lib/session";
import { useFetch } from "@/lib/useFetch";
import { useHydrated, useSessionToken } from "@/lib/useSession";
import type { ComparisonCardDto } from "@/lib/types";
import { registerTranslations, translate } from "@/lib/i18n";
import { useLang } from "@/lib/useLang";
import { apiErrorMessage } from "@/lib/apiErrors";
import { pickText } from "@/lib/localized";
import { loginRedirectHref } from "@/lib/loginRedirect";

// TB-25: the favourites page's own words (Arabic unchanged).
registerTranslations({
  ar: {
    "favp.alert.PRICE_DROP": "انخفاض السعر",
    "favp.alert.BACK_IN_STOCK": "عودة المخزون",
    "favp.alert.NEW_OFFER": "عرض جديد لمنتج مفضّل",
    "favp.product": "منتج",
    "favp.offer": "عرض محدد من متجر",
    "favp.remove": "إزالة من المفضلة",
    "favp.title": "المفضلة",
    "favp.subtitle": "المنتجات والعروض التي حفظتِها.",
    "favp.alerts": "تنبيهات المفضلة",
    "favp.empty": "لا توجد عناصر في مفضلتك بعد",
    "favp.empty_hint": "أضيفي منتجاً أو عرضاً من صفحته الخاصة.",
    "favp.discover": "اكتشفي المنتجات",
    "favp.products": "المنتجات المفضّلة",
    "favp.offers": "العروض المفضّلة",
    "favp.sets": "مجموعات المقارنة المحفوظة",
    "favp.alerts_hint": "اختاري التنبيهات التي ترغبين باستلامها.",
    "favp.close": "إغلاق",
  },
  en: {
    "favp.alert.PRICE_DROP": "Price drop",
    "favp.alert.BACK_IN_STOCK": "Back in stock",
    "favp.alert.NEW_OFFER": "New offer for a favourite product",
    "favp.product": "Product",
    "favp.offer": "A specific store offer",
    "favp.remove": "Remove from favourites",
    "favp.title": "Favourites",
    "favp.subtitle": "The products and offers you've saved.",
    "favp.alerts": "Favourite alerts",
    "favp.empty": "Nothing in your favourites yet",
    "favp.empty_hint": "Add a product or an offer from its own page.",
    "favp.discover": "Discover products",
    "favp.products": "Favourite products",
    "favp.offers": "Favourite offers",
    "favp.sets": "Saved comparison sets",
    "favp.alerts_hint": "Choose the alerts you'd like to receive.",
    "favp.close": "Close",
  },
});


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

// TB-25: alert names are favp.alert.<type>.
const ALERT_TYPES: AlertType[] = ["PRICE_DROP", "BACK_IN_STOCK", "NEW_OFFER"];

// Sprint 24 (FR-FAV-001/005): favorited products/offers plus the
// per-alert-type notification toggles. STORE favoriting stays exactly
// "أتابعه" (/following) - never duplicated here. Lives under
// /account/favorites (not a top-level /favorites) by explicit product-
// owner request, matching this page's own reachability from the
// /account hub-grid.
export default function FavoritesPage({ embedded = false }: { embedded?: boolean }) {
  const lang = useLang();
  const t = (key: string) => translate(lang, key);
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
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  // TB-4: the real product cards, remembered with the set of products they
  // were fetched for - a different set simply isn't shown until its own
  // fetch lands, so nothing is reset inside the effect.
  const [loadedCards, setLoadedCards] = useState<{ key: string; cards: Record<string, ComparisonCardDto> }>({ key: "", cards: {} });

  useEffect(() => {
    if (favorites.status === 401 || preferences.status === 401) {
      clearSession();
      router.replace(loginRedirectHref());
    }
  }, [favorites.status, preferences.status, router]);

  useEffect(() => {
    if (hydrated && !token) {
      router.replace(loginRedirectHref());
    }
  }, [hydrated, token, router]);

  useEffect(() => {
    if (!preferencesOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreferencesOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [preferencesOpen]);

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

  const items = (favorites.data ?? []).filter((f) => !removedIds.has(f.id));
  const products = items.filter((f) => f.target_type === "PRODUCT");
  const offers = items.filter((f) => f.target_type === "OFFER");

  // Every favourite's product (a removed one is already filtered out of
  // `items`, so removing doesn't refetch the rest).
  const cardKey = [...new Set((favorites.data ?? []).flatMap((favorite) => favorite.canonical_product_id ? [favorite.canonical_product_id] : []))].join(",");
  useEffect(() => {
    if (!cardKey) return;
    let cancelled = false;
    Promise.all(cardKey.split(",").map(async (id) => {
      try {
        return [id, await apiFetch<ComparisonCardDto>(`/canonical-products/${id}/comparison-card`)] as const;
      } catch {
        return null;
      }
    })).then((rows) => {
      if (cancelled) return;
      setLoadedCards({ key: cardKey, cards: Object.fromEntries(rows.filter((row): row is readonly [string, ComparisonCardDto] => row !== null)) });
    });
    return () => { cancelled = true; };
  }, [cardKey]);
  const favoriteCards = loadedCards.key === cardKey ? loadedCards.cards : {};

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

  function hrefFor(f: FavoriteDto): string {
    if (f.target_type === "PRODUCT" && f.canonical_product_id) {
      return `/compare/${f.canonical_product_id}`;
    }
    return "/discovery";
  }

  function card(f: FavoriteDto) {
    const productCard = f.canonical_product_id ? favoriteCards[f.canonical_product_id] : null;
    if (productCard) {
      return (
        <ProductCard
          key={f.id}
          card={productCard}
          presentation="women"
          favorited
          onToggleFavorite={() => removeFavorite(f.id)}
        />
      );
    }
    return (
      <div key={f.id} className="card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <Link href={hrefFor(f)} style={{ textDecoration: "none", color: "inherit" }}>
          <strong>{pickText(lang, f.name_en, f.name_ar) || t("favp.product")}</strong>
        </Link>
        <span className="muted" style={{ fontSize: 13 }}>
          {f.target_type === "PRODUCT" ? t("favp.product") : t("favp.offer")}
        </span>
        <button className="button-link" onClick={() => removeFavorite(f.id)}>
          {t("favp.remove")}
        </button>
      </div>
    );
  }

  const loading = favorites.loading;
  const noFavorites = !loading && items.length === 0;

  return (
    <div className={`favorites-page page-shell${embedded ? " favorites-page-embedded" : ""}`}>
      <div className="wide-shell">
        <div className={`favorites-page-heading${embedded ? " favorites-page-embedded-heading" : ""}`}>
          {!embedded && <div>
            <h1 className="page-title">{t("favp.title")}</h1>
            <p className="page-subtitle">{t("favp.subtitle")}</p>
          </div>}
          <button
            type="button"
            className="favorites-alerts-button"
            onClick={() => setPreferencesOpen(true)}
            aria-haspopup="dialog"
            aria-label={t("favp.alerts")}
            title={t("favp.alerts")}
          >
            {embedded ? <BellIcon /> : t("favp.alerts")}
          </button>
        </div>

        {favorites.error && favorites.status !== 401 && (
          <ErrorBanner message={apiErrorMessage(favorites.apiError, lang)} />
        )}

        {loading && <SkeletonGrid count={4} />}

        {noFavorites && (
          <EmptyState
            title={t("favp.empty")}
            message={t("favp.empty_hint")}
            actionHref="/discovery"
            actionLabel={t("favp.discover")}
          />
        )}

        {products.length > 0 && (
          <>
            <div className="section-heading">
              <h2>{t("favp.products")}</h2>
            </div>
            <div className="product-grid">{products.map(card)}</div>
          </>
        )}

        {offers.length > 0 && (
          <>
            <div className="section-heading">
              <h2>{t("favp.offers")}</h2>
            </div>
            <div className="product-grid">{offers.map(card)}</div>
          </>
        )}

        <div style={{ marginTop: 20 }}>
          <Link href="/compare/sets" className="button-link">
            {t("favp.sets")}
          </Link>
        </div>
      </div>

      {preferencesOpen && (
        <div
          className="favorites-alerts-overlay"
          role="presentation"
          onMouseDown={() => setPreferencesOpen(false)}
        >
          <section
            className="favorites-alerts-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="favorites-alerts-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="favorites-alerts-dialog-heading">
              <div>
                <h2 id="favorites-alerts-title">{t("favp.alerts")}</h2>
                <p>{t("favp.alerts_hint")}</p>
              </div>
              <button type="button" onClick={() => setPreferencesOpen(false)} aria-label={t("favp.close")}>×</button>
            </div>
            {localPrefs ? (
              <div className="favorites-alert-options">
                {ALERT_TYPES.map((alertType) => (
                  <label key={alertType}>
                    <input
                      type="checkbox"
                      checked={localPrefs[alertType]}
                      disabled={savingAlert === alertType}
                      onChange={() => toggleAlert(alertType)}
                    />
                    <span>{t(`favp.alert.${alertType}`)}</span>
                  </label>
                ))}
              </div>
            ) : <div className="skeleton" style={{ height: 106 }} />}
          </section>
        </div>
      )}
    </div>
  );
}
