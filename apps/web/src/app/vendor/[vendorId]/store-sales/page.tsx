"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ErrorBanner } from "@/components/States";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { isUnauthorized } from "@/lib/apiErrors";
import { loginRedirectHref } from "@/lib/loginRedirect";
import { fillPos, formatIls, posErrorText } from "@/lib/storePosText";
import { useLang, useT } from "@/lib/useLang";
import { useHydrated, useSessionToken } from "@/lib/useSession";
import { useSessionExpiredRedirect } from "@/lib/useSessionExpiredRedirect";

interface StartDto {
  role: "OWNER" | "BRANCH_EMPLOYEE";
  branches: { id: string; name: string }[];
  can_void: boolean;
}
interface SaleLine {
  id: string;
  title_ar: string;
  title_en: string;
  color_name_ar: string | null;
  color_name_en: string | null;
  size_label: string | null;
  quantity: number;
  unit_price: string;
  line_total: string;
}
interface SaleDto {
  id: string;
  sale_label: string;
  status: "COMPLETED" | "VOIDED";
  payment_method: "CASH" | "CARD";
  total: string;
  units: number;
  branch: { id: string; name: string };
  sold_by: { id: string; name: string } | null;
  created_at: string;
  voided_by: { id: string; name: string } | null;
  void_reason: string | null;
  voidable: boolean;
  lines: SaleLine[];
}
interface ListDto {
  items: SaleDto[];
  next_cursor: string | null;
  summary: { sales_count: number; total: string; units: number; voided_count: number };
}

/** Today in Palestine, YYYY-MM-DD (the API counts days the same way). */
function today(): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hebron", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * «مبيعات المحل»: the in-store sales of a period (default: today) with the
 * totals of the completed ones - the owner sees every branch (and may filter
 * one), an employee only her own branch. The owner may void a WHOLE sale on
 * its own day, with a reason; every item goes back to the same colour, size
 * and branch. These sales never count in the public bestseller ranking.
 */
export default function StoreSalesPage() {
  const params = useParams<{ vendorId: string }>();
  const vendorId = params.vendorId;
  const router = useRouter();
  const t = useT();
  const lang = useLang();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const onExpired = useSessionExpiredRedirect();

  const [start, setStart] = useState<StartDto | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [branchId, setBranchId] = useState("");
  const [status, setStatus] = useState("");
  const [data, setData] = useState<ListDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<SaleDto | null>(null);
  const [reason, setReason] = useState("");
  const [voidBusy, setVoidBusy] = useState(false);
  const [voidError, setVoidError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!hydrated) return;
    if (!token) {
      router.replace(loginRedirectHref());
      return;
    }
    apiFetch<StartDto>(`/vendors/${vendorId}/cashier`)
      .then(setStart)
      .catch((err) => {
        if (isUnauthorized(err)) onExpired();
        else if (err instanceof ApiError && err.code === "FEATURE_DISABLED") setDisabled(true);
        else setError(posErrorText(err, lang));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, token, vendorId]);

  const query = useCallback(
    (cursor?: string) => {
      const qs = new URLSearchParams();
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      if (branchId) qs.set("branch_id", branchId);
      if (status) qs.set("status", status);
      if (cursor) qs.set("cursor", cursor);
      return `/vendors/${vendorId}/store-sales?${qs.toString()}`;
    },
    [vendorId, from, to, branchId, status],
  );

  const load = useCallback(() => {
    apiFetch<ListDto>(query())
      .then((d) => {
        setError(null);
        setData(d);
      })
      .catch((err) => (isUnauthorized(err) ? onExpired() : setError(posErrorText(err, lang))));
  }, [query, lang, onExpired]);

  useEffect(() => {
    if (!start) return;
    load();
  }, [start, load]);

  async function more() {
    if (!data?.next_cursor) return;
    setLoadingMore(true);
    try {
      const next = await apiFetch<ListDto>(query(data.next_cursor));
      setData({ ...next, items: [...data.items, ...next.items] });
    } catch (err) {
      setError(posErrorText(err, lang));
    } finally {
      setLoadingMore(false);
    }
  }

  async function confirmVoid() {
    if (!voiding) return;
    if (!reason.trim()) {
      setVoidError(t("pos.e.VOID_REASON_REQUIRED"));
      return;
    }
    setVoidBusy(true);
    setVoidError(null);
    try {
      const updated = await apiFetch<SaleDto>(`/vendors/${vendorId}/store-sales/${voiding.id}/void`, {
        method: "POST",
        body: { reason: reason.trim() },
        idempotencyKey: newIdempotencyKey(`store-sale-void-${voiding.id}`),
      });
      setNotice(fillPos(t("ss.voided"), { label: updated.sale_label }));
      setVoiding(null);
      setReason("");
      load();
    } catch (err) {
      setVoidError(posErrorText(err, lang));
    } finally {
      setVoidBusy(false);
    }
  }

  const name = (ar: string | null, en: string | null) => (lang === "en" ? en || ar : ar) ?? "";
  const when = (iso: string) =>
    new Date(iso).toLocaleString(lang === "en" ? "en-GB" : "ar", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Hebron" });

  if (disabled) {
    return (
      <div className="page-shell pos-page">
        <h1 className="page-title pos-own-title">{t("pos.sales.title")}</h1>
        <p className="muted">{t("pos.disabled")}</p>
      </div>
    );
  }

  return (
    <div className="page-shell pos-page" data-testid="store-sales-page">
      <div className="top-bar pos-own-title">
        <h1 className="page-title" style={{ margin: 0 }}>{t("pos.sales.title")}</h1>
      </div>
      <p>
        <Link href={`/vendor/${vendorId}/cashier`} className="button-link" data-testid="store-sales-open-cashier">{t("ss.open_cashier")}</Link>
      </p>
      {error && <ErrorBanner message={error} />}
      {notice && <p className="pos-inline-notice" role="status">{notice}</p>}

      <section className="card ss-filters" aria-label={t("ss.filters")}>
        <div className="field">
          <label htmlFor="ss-from">{t("ss.from")}</label>
          <input id="ss-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ss-to">{t("ss.to")}</label>
          <input id="ss-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </div>
        {start?.role === "OWNER" && start.branches.length > 1 && (
          <div className="field">
            <label htmlFor="ss-branch">{t("pos.branch")}</label>
            <select id="ss-branch" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">{t("ss.branch.all")}</option>
              {start.branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="ss-status">{t("ss.status.all")}</label>
          <select id="ss-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{t("ss.status.all")}</option>
            <option value="COMPLETED">{t("ss.status.COMPLETED")}</option>
            <option value="VOIDED">{t("ss.status.VOIDED")}</option>
          </select>
        </div>
      </section>

      {!data ? (
        !error && <div className="skeleton" style={{ height: 160 }} />
      ) : (
        <>
          <dl className="ss-summary" data-testid="store-sales-summary">
            <div><dt>{t("ss.summary.count")}</dt><dd>{data.summary.sales_count}</dd></div>
            <div><dt>{t("ss.summary.total")}</dt><dd>{formatIls(data.summary.total, lang)}</dd></div>
            <div><dt>{t("ss.summary.units")}</dt><dd>{data.summary.units}</dd></div>
            <div><dt>{t("ss.summary.voided")}</dt><dd>{data.summary.voided_count}</dd></div>
          </dl>
          {data.items.length === 0 ? (
            <p className="muted">{t("ss.empty")}</p>
          ) : (
            <ul className="ss-list">
              {data.items.map((s) => (
                <li key={s.id} className={`card ss-sale${s.status === "VOIDED" ? " is-voided" : ""}`} data-testid="store-sale">
                  <div className="ss-sale-head">
                    <div>
                      <strong dir="ltr">{s.sale_label}</strong>
                      <span className={`owner-status owner-status-${s.status === "VOIDED" ? "archived" : "active"}`}>{t(`ss.status.${s.status}`)}</span>
                      <div className="muted">
                        {when(s.created_at)} · {s.branch.name} · {t(`pos.pay.${s.payment_method}`)}
                        {s.sold_by && <> · {fillPos(t("ss.sold_by"), { name: s.sold_by.name })}</>}
                      </div>
                    </div>
                    <div className="ss-sale-total">
                      <strong>{formatIls(s.total, lang)}</strong>
                      <span className="muted">{fillPos(t("pos.units"), { n: s.units })}</span>
                    </div>
                  </div>
                  {s.status === "VOIDED" && s.void_reason && (
                    <p className="muted">{fillPos(t("ss.voided_by"), { name: s.voided_by?.name ?? "", reason: s.void_reason })}</p>
                  )}
                  <div className="ss-sale-actions">
                    <button
                      type="button"
                      className="button-link"
                      aria-expanded={open === s.id}
                      aria-controls={`ss-lines-${s.id}`}
                      onClick={() => setOpen(open === s.id ? null : s.id)}
                    >
                      {t("ss.lines")}
                    </button>
                    {start?.can_void && s.voidable && (
                      <button
                        type="button"
                        className="button-link pos-danger-link"
                        onClick={() => {
                          setVoiding(s);
                          setReason("");
                          setVoidError(null);
                        }}
                        data-testid="store-sale-void"
                      >
                        {t("ss.void")}
                      </button>
                    )}
                  </div>
                  {open === s.id && (
                    <ul id={`ss-lines-${s.id}`} className="ss-lines">
                      {s.lines.map((l) => (
                        <li key={l.id}>
                          <span>
                            {name(l.title_ar, l.title_en)} · {name(l.color_name_ar, l.color_name_en) || t("pos.color.none")} · {l.size_label ?? t("pos.size.none")}
                          </span>
                          <span>
                            {l.quantity} × {formatIls(l.unit_price, lang)} = {formatIls(l.line_total, lang)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
          {data.next_cursor && (
            <button type="button" className="button-link" onClick={more} disabled={loadingMore}>{t("ss.more")}</button>
          )}
        </>
      )}

      {voiding && (
        <div className="store-quick-edit-overlay" role="presentation" onClick={() => !voidBusy && setVoiding(null)}>
          <section
            className="store-quick-edit-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="ss-void-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="ss-void-title">{fillPos(t("ss.void.title"), { label: voiding.sale_label })}</h2>
            <p>{fillPos(t("ss.void.text"), { branch: voiding.branch.name })}</p>
            <label>
              {t("ss.void.reason")}
              <textarea value={reason} rows={3} maxLength={500} autoFocus onChange={(e) => setReason(e.target.value)} data-testid="store-sale-void-reason" />
            </label>
            {voidError && <p className="pos-inline-error" role="alert">{voidError}</p>}
            <div className="store-quick-edit-actions">
              <button type="button" onClick={() => setVoiding(null)} disabled={voidBusy}>{t("ss.void.back")}</button>
              <button type="button" onClick={confirmVoid} disabled={voidBusy} data-testid="store-sale-void-confirm">{t("ss.void.confirm")}</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
