"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch } from "@/lib/api";
import { isUnauthorized } from "@/lib/apiErrors";
import { withEnglishFallback } from "@/lib/i18n";
import { useLang, useT } from "@/lib/useLang";
import { useSessionExpiredRedirect } from "@/lib/useSessionExpiredRedirect";
import { useHydrated, useSessionToken } from "@/lib/useSession";
import {
  type UiError,
  formatDateTime,
  returnReasonLabel,
  returnStatusLabel,
  uiErrorText,
} from "@/lib/returns";
import SizeGuideSnapshotNote from "@/components/SizeGuideSnapshotNote";
import type { SizeGuideSnapshot } from "@/lib/sizeGuides";
import { loginHref, loginRedirectHref } from "@/lib/loginRedirect";

interface ReturnListRow {
  id: string;
  status: string;
  reason: string;
  code: string | null;
  branch_order_id: string;
  title_ar: string;
  title_en: string;
  created_at: string;
  desired_outcome: "RETURN" | "EXCHANGE";
  size_guide?: SizeGuideSnapshot | null;
}

// Sprint 21 (review-round point 1): the customer's own cross-order
// returns list - GET /customers/me/returns - so "this item already has
// a return, track it here" is discoverable without remembering a
// returnId, same reasoning as the /orders page's own grouping.
// This same list is mounted in the shopping-profile orders overlay. The
// embedded mode removes only its page chrome; return records and their
// detail links remain the real customer returns experience.
// TB-16.2: Arabic and English.
export default function ReturnsListPage({ embedded = false }: { embedded?: boolean }) {
  const router = useRouter();
  const lang = useLang();
  const t = useT();
  const onExpired = useSessionExpiredRedirect();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const [rows, setRows] = useState<ReturnListRow[] | null>(null);
  const [error, setError] = useState<UiError | null>(null);

  useEffect(() => {
    if (!hydrated) return;
    if (!token) {
      router.replace(embedded ? loginHref("/profile?tab=orders") : loginRedirectHref());
      return;
    }
    apiFetch<ReturnListRow[]>("/customers/me/returns")
      .then(setRows)
      .catch((err) => (isUnauthorized(err) ? onExpired() : setError({ api: err })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, token]);

  if (!hydrated || (!token && !error)) {
    return (
      <div className={embedded ? "shopping-profile-returns" : "page-shell"}>
        <div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 720 }} />
      </div>
    );
  }

  return (
    <div className={embedded ? "shopping-profile-returns" : "page-shell"}>
      {!embedded && (
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>{t("ret.my_returns")}</h1>
          <Link href="/orders" className="button-link">{t("ret.my_orders")}</Link>
        </div>
      )}

      {error && <ErrorBanner message={uiErrorText(error, lang)} />}

      {!rows && !error && (
        <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 720 }} />
      )}

      {rows && rows.length === 0 && (
        <EmptyState
          title={t("ret.list.empty_title")}
          message={t("ret.list.empty_message")}
          actionHref={embedded ? undefined : "/orders"}
          actionLabel={embedded ? undefined : t("ret.my_orders")}
        />
      )}

      {rows && rows.length > 0 && (
        <div style={{ maxWidth: 720, width: "100%", display: "flex", flexDirection: "column", gap: 10 }}>
          {rows.map((r) => (
            <Link key={r.id} href={`/returns/${r.id}`} className="card" style={{ display: "block" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div style={{ fontWeight: 600 }}>
                  {lang === "en" ? withEnglishFallback(lang, r.title_en, r.title_ar) : r.title_ar || r.title_en}
                  {r.desired_outcome === "EXCHANGE" && (
                    <span className="muted" style={{ marginInlineStart: 8 }}>{t("ret.exchange_tag")}</span>
                  )}
                </div>
                <span className="badge badge-active">{returnStatusLabel(r.status, lang)}</span>
              </div>
              <div className="muted">
                {returnReasonLabel(r.reason, lang)} · {formatDateTime(r.created_at, lang)}
                <SizeGuideSnapshotNote snapshot={r.size_guide} />
              </div>
              {r.code && (
                <div style={{ fontWeight: 600, marginTop: 4 }}>
                  {t(`ret.code.${r.desired_outcome}`)}: {r.code}
                </div>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
