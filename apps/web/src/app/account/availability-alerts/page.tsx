"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import SafeImage from "@/components/SafeImage";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch } from "@/lib/api";
import { clearSession } from "@/lib/session";
import { useFetch } from "@/lib/useFetch";
import { useHydrated, useSessionToken } from "@/lib/useSession";
import { loginRedirectHref } from "@/lib/loginRedirect";
import { registerTranslations, translate, withEnglishFallback } from "@/lib/i18n";
import { useLang } from "@/lib/useLang";

registerTranslations({
  ar: {
    "availability.back": "العودة إلى الإعدادات",
    "availability.title": "تنبيهات عودة التوفر",
    "availability.subtitle": "سنخبرك عندما يعود اللون والمقاس اللذان اخترتهما للمخزون.",
    "availability.load_error": "تعذّر تحميل التنبيهات.",
    "availability.empty": "لا توجد تنبيهات فعّالة",
    "availability.empty_hint": "اختاري لوناً ومقاساً نافدين من صفحة المنتج لطلب تنبيه.",
    "availability.discover": "اكتشفي المنتجات",
    "availability.color": "اللون",
    "availability.size": "المقاس",
    "availability.cancel": "إلغاء التنبيه",
    "availability.cancelling": "جارٍ الإلغاء…",
  },
  en: {
    "availability.back": "Back to settings",
    "availability.title": "Back-in-stock alerts",
    "availability.subtitle": "We'll let you know when your selected colour and size are back in stock.",
    "availability.load_error": "Couldn't load your alerts.",
    "availability.empty": "No active availability alerts",
    "availability.empty_hint": "Choose a sold-out colour and size on a product page to request an alert.",
    "availability.discover": "Discover products",
    "availability.color": "Colour",
    "availability.size": "Size",
    "availability.cancel": "Cancel alert",
    "availability.cancelling": "Cancelling…",
  },
});

interface AvailabilityAlert {
  offer_variant_id: string;
  offer_id: string;
  vendor_slug: string;
  title_ar: string;
  title_en: string;
  color_name_ar: string;
  color_name_en: string | null;
  color_id: string | null;
  color_hex: string | null;
  color_swatch_url: string | null;
  size_code: string | null;
  size_name_ar: string | null;
  image_url: string | null;
}

export default function AvailabilityAlertsPage() {
  const lang = useLang();
  const t = (key: string) => translate(lang, key);
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const alerts = useFetch<AvailabilityAlert[]>(token ? "/customers/me/availability-subscriptions" : null, true);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (alerts.status === 401) {
      clearSession();
      router.replace(loginRedirectHref());
    }
  }, [alerts.status, router]);

  useEffect(() => {
    if (hydrated && !token) router.replace(loginRedirectHref());
  }, [hydrated, token, router]);

  if (!hydrated || !token) return <div className="page-shell"><div className="skeleton" style={{ height: 150 }} /></div>;

  const items = (alerts.data ?? []).filter((item) => !removed.has(item.offer_variant_id));
  async function cancel(item: AvailabilityAlert) {
    setBusy(item.offer_variant_id);
    try {
      await apiFetch(`/customers/me/availability-subscriptions/${encodeURIComponent(item.offer_variant_id)}`, { method: "DELETE" });
      setRemoved((current) => new Set(current).add(item.offer_variant_id));
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="page-shell availability-alerts-page">
      <div className="wide-shell" style={{ maxWidth: 860 }}>
        <Link href="/profile?view=settings" className="button-link">← {t("availability.back")}</Link>
        <h1 className="page-title">{t("availability.title")}</h1>
        <p className="page-subtitle">{t("availability.subtitle")}</p>
        {alerts.error && alerts.status !== 401 && <ErrorBanner message={t("availability.load_error")} />}
        {alerts.loading && <div className="skeleton" style={{ height: 180 }} />}
        {!alerts.loading && items.length === 0 && <EmptyState title={t("availability.empty")} message={t("availability.empty_hint")} actionHref="/discovery" actionLabel={t("availability.discover")} />}
        <div className="availability-alert-list">
          {items.map((item) => {
            const href = `/store/${encodeURIComponent(item.vendor_slug)}/products/${encodeURIComponent(item.offer_id)}?${item.color_id ? `color=${encodeURIComponent(item.color_id)}&` : ""}size=${encodeURIComponent(item.size_code ?? "")}`;
            return <article className="availability-alert-card" key={item.offer_variant_id}>
              {item.image_url ? <SafeImage src={item.image_url} alt="" /> : <div className="availability-alert-image" />}
              <div className="availability-alert-main">
                <Link href={href}><strong dir={lang === "en" && item.title_en?.trim() ? "ltr" : "rtl"}>{withEnglishFallback(lang, item.title_en, item.title_ar)}</strong></Link>
                <span><i className="availability-alert-swatch" style={{ background: item.color_swatch_url ? `url(${item.color_swatch_url}) center / cover` : (item.color_hex ?? "#d6c5b3") }} />{t("availability.color")}: {withEnglishFallback(lang, item.color_name_en, item.color_name_ar)}</span>
                <span>{t("availability.size")}: {item.size_name_ar ?? item.size_code ?? "—"}</span>
              </div>
              <button type="button" className="button button-secondary" disabled={busy === item.offer_variant_id} onClick={() => cancel(item)}>{busy === item.offer_variant_id ? t("availability.cancelling") : t("availability.cancel")}</button>
            </article>;
          })}
        </div>
      </div>
    </main>
  );
}
