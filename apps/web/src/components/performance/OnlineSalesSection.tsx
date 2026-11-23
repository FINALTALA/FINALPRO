"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch, ApiError } from "@/lib/api";
import { isUnauthorized } from "@/lib/apiErrors";
import { fillPf } from "@/lib/performanceText";
import { useTaxonomy } from "@/lib/taxonomy";
import { useLang, useT } from "@/lib/useLang";
import { useSessionExpiredRedirect } from "@/lib/useSessionExpiredRedirect";

interface OwnerSalesDto {
  computed_at: string | null;
  window_start: string | null;
  entries: {
    offer_id: string;
    title: string | null;
    category_code: string;
    audience: string;
    units: number;
    customers: number;
    bestseller: boolean;
  }[];
}

/**
 * «المبيعات الأونلاين (آخر 30 يوماً)» (PD-5.3, moved from its own page into
 * «أداء المتجر»): the owner's own sales in the ranking window - their own
 * offers only, a row per product and department/category, exactly as the API
 * returns them (GET /vendors/:id/sales-rank, OWNER only). No total is added
 * up here: a product listed in two categories is two rows, so a sum would
 * count it twice.
 */
export default function OnlineSalesSection({ vendorId }: { vendorId: string }) {
  const t = useT();
  const lang = useLang();
  const onExpired = useSessionExpiredRedirect();
  const taxonomy = useTaxonomy();
  const [data, setData] = useState<OwnerSalesDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    apiFetch<OwnerSalesDto>(`/vendors/${vendorId}/sales-rank`).then(
      (res) => alive && setData(res),
      (err: unknown) => {
        if (!alive) return;
        if (isUnauthorized(err)) return onExpired();
        setError(err instanceof ApiError && err.message && lang === "ar" ? err.message : t("pf.online.failed"));
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorId, onExpired]);

  const categoryName = (code: string) => {
    const c = taxonomy.data?.categories.find((x) => x.code === code);
    return (lang === "en" ? c?.name_en : c?.name_ar) ?? code;
  };
  const audience = (a: string) => {
    const key = `pf.aud.${a}`;
    const label = t(key);
    return label === key ? a : label;
  };
  const when = (iso: string) =>
    new Date(iso).toLocaleString(lang === "en" ? "en-GB" : "ar", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Hebron" });

  return (
    <section className="pf-part" id="online" aria-labelledby="pf-online-title" tabIndex={-1} data-testid="pf-online">
      <h3 className="pf-part-title" id="pf-online-title">{t("pf.online.title")}</h3>
      <p className="muted pf-lead">{t("pf.online.lead")}</p>
      {error && <ErrorBanner message={error} />}
      {!data && !error && <div className="skeleton" style={{ height: 160, width: "100%" }} />}
      {data &&
        (data.entries.length === 0 ? (
          <EmptyState title={t("pf.online.empty")} />
        ) : (
          <div className="pf-table-wrap">
            <table className="data-table pf-table">
              <caption className="visually-hidden">{t("pf.online.caption")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("pf.online.product")}</th>
                  <th scope="col">{t("pf.online.category")}</th>
                  <th scope="col">{t("pf.online.units")}</th>
                  <th scope="col">{t("pf.online.customers")}</th>
                  <th scope="col">{t("pf.online.badge")}</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((e) => (
                  <tr key={`${e.offer_id}|${e.category_code}|${e.audience}`}>
                    <td data-label={t("pf.online.product")}>
                      <Link href={`/vendor/${vendorId}/offers/${e.offer_id}`} dir="auto">{e.title ?? "—"}</Link>
                    </td>
                    <td data-label={t("pf.online.category")}>
                      {categoryName(e.category_code)} - {audience(e.audience)}
                    </td>
                    <td data-label={t("pf.online.units")}>{e.units}</td>
                    <td data-label={t("pf.online.customers")}>{e.customers}</td>
                    <td data-label={t("pf.online.badge")}>
                      {e.bestseller ? <span className="badge badge-active">{t("pf.online.qualified")}</span> : <span className="muted">{t("pf.online.not_qualified")}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      {data?.computed_at && <p className="muted pf-meta">{fillPf(t("pf.online.updated"), { date: when(data.computed_at) })}</p>}
    </section>
  );
}
