"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ErrorBanner, EmptyState } from "@/components/States";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { clearSession } from "@/lib/session";
import { registerTranslations } from "@/lib/i18n";
import { useT } from "@/lib/useLang";
import { useHydrated, useSessionToken } from "@/lib/useSession";

registerTranslations({
  ar: {
    "deactivate.title": "إغلاق الحساب",
    "deactivate.warning_title": "تنبيه قبل المتابعة",
    "deactivate.warning_body":
      "سيُعطَّل حسابك فوراً وستُنهى كل جلسات الدخول الحالية. يمكنك استرجاعه خلال 30 يوماً من صفحة استرجاع الحساب برقم هاتفك - بعد ذلك لا يمكن استرجاعه. لا يمكن تعطيل الحساب إن كان لديك طلب نشط، أو إن كنت المالك الوحيد النشط لمتجر لم يُغلَق.",
    "deactivate.confirm_button": "تعطيل حسابي",
    "deactivate.confirming": "جارٍ التعطيل...",
    "deactivate.cancel": "تراجع",
    "deactivate.failed": "تعذّر تعطيل الحساب",
    "deactivate.login_required": "سجّلي الدخول لإغلاق حسابك",
    "deactivate.login_action": "تسجيل الدخول",
  },
  en: {
    "deactivate.title": "Deactivate account",
    "deactivate.warning_title": "Before you continue",
    "deactivate.warning_body":
      "Your account will be deactivated immediately and every current session signed out. You can recover it within 30 days from the account-recovery page using your phone number - after that it can't be recovered. Deactivation is blocked while you have an active order, or while you're the only active owner of a store that isn't closed.",
    "deactivate.confirm_button": "Deactivate my account",
    "deactivate.confirming": "Deactivating...",
    "deactivate.cancel": "Cancel",
    "deactivate.failed": "Couldn't deactivate the account",
    "deactivate.login_required": "Sign in to deactivate your account",
    "deactivate.login_action": "Sign in",
  },
});

// Sprint 22 (FR-AUTH-014, PDR-034): the customer's own explicit
// deactivation action - SRS's literal "account deletion" route
// (DELETE /customers/me) is actually this reversible deactivation, so
// the UI is honest about that rather than calling it a deletion.
export default function DeactivateAccountPage() {
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirmDeactivate() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/customers/me", {
        method: "DELETE",
        idempotencyKey: newIdempotencyKey("deactivate"),
      });
      clearSession();
      router.replace("/login");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("deactivate.failed"));
    } finally {
      setBusy(false);
    }
  }

  if (!hydrated) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 96, width: "100%", maxWidth: 480 }} />
      </div>
    );
  }

  if (!token) {
    return (
      <div className="page-shell">
        <EmptyState title={t("deactivate.login_required")} actionHref="/login?next=/account/deactivate" actionLabel={t("deactivate.login_action")} />
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="card">
        <div className="brand">{t("deactivate.title")}</div>
        {error && <ErrorBanner message={error} />}

        <div className="error-banner" role="alert" style={{ marginBottom: 14 }}>
          <strong>{t("deactivate.warning_title")}</strong>
          <p style={{ marginTop: 6 }}>{t("deactivate.warning_body")}</p>
        </div>

        <button className="button button-block" disabled={busy} onClick={() => void confirmDeactivate()}>
          {busy ? t("deactivate.confirming") : t("deactivate.confirm_button")}
        </button>

        <p className="muted" style={{ textAlign: "center", marginBottom: 0, marginTop: 14 }}>
          <Link href="/account">{t("deactivate.cancel")}</Link>
        </p>
      </div>
    </div>
  );
}
