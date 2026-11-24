"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { apiFetch } from "@/lib/api";
import "@/lib/branchOverviewText";
import { fillBr } from "@/lib/branchesText";
import type { Lang } from "@/lib/i18n";
import { useLang, useT } from "@/lib/useLang";
import "./branchOverview.css";

/** What the overview reads - every part from an EXISTING branch read (no new endpoint). */
interface Opening {
  open_now: boolean | null;
  open_until: string | null;
  next_open_at: string | null;
}
interface Closure {
  starts_at: string;
  ends_at: string;
  reason: string | null;
}
interface BoardDay {
  date: string;
  windows: { start_time: string; end_time: string; status: string }[];
}
interface Facts {
  opening: Opening | null;
  closure: Closure | null;
  delivery: { kind: "open"; date: string; start: string; end: string; today: string } | { kind: "none" } | { kind: "no_windows" } | null;
  minimum: number | null;
  follow: { key: string; n: number; href: string }[];
  partial: boolean;
}

const ZONE = "Asia/Hebron";
const loc = (lang: Lang) => (lang === "en" ? "en-GB" : "ar");

function dayWord(date: string, today: string, lang: Lang, t: (k: string) => string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const diff = Math.round((d.getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86_400_000);
  if (diff === 0) return t("bov.today");
  if (diff === 1) return t("bov.tomorrow");
  return new Intl.DateTimeFormat(loc(lang), { weekday: "long", timeZone: "UTC" }).format(d);
}
/** An instant in Palestine time: «اليوم 21:00», «غداً 09:00», «الأحد 09:00». */
function when(iso: string, lang: Lang, t: (k: string) => string): string {
  const day = (x: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(x);
  const time = new Intl.DateTimeFormat(loc(lang), { timeZone: ZONE, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  return `${dayWord(day(new Date(iso)), day(new Date()), lang, t)} ${time}`;
}

async function allClosures(base: string): Promise<Closure[]> {
  const out: Closure[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 6; page++) {
    const res: { items: Closure[]; next_cursor: string | null } = await apiFetch(`${base}/closures?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    out.push(...res.items);
    cursor = res.next_cursor;
    if (!cursor) break;
  }
  return out;
}

/**
 * «نظرة عامة» (2026-11-24): the current branch as an operating screen - what
 * is true now («وضع الفرع الآن»), what needs doing («يحتاج متابعة», only
 * real items, each opening its tab), and «إجراءات سريعة». Every number is
 * read from the existing branch endpoints the tabs themselves use (the
 * opening state, closures, minimum order, the 7-day delivery board, the
 * order queue's counts, the stock board's summary, the branch's returns and
 * - owner only - the staff invites), with the same permissions: an employee
 * reads only her own branch and never the invites. Nothing estimated; a part
 * that could not be read is left out and said so - never shown as zero.
 */
export default function BranchOverviewNow({ vendorId, branchId, isOwner }: { vendorId: string; branchId: string; isOwner: boolean }) {
  const t = useT();
  const lang = useLang();
  const [facts, setFacts] = useState<Facts | null>(null);
  const base = `/vendors/${vendorId}/branches/${branchId}`;
  const href = (tab: string, qs = "") => `/vendor/${vendorId}/branches/${branchId}/${tab}${qs}`;

  useEffect(() => {
    let alive = true;
    const [hours, closures, minimum, board, orders, stock, returns, invites] = [
      apiFetch<{ opening: Opening }>(`${base}/operating-hours`),
      allClosures(base),
      apiFetch<{ minimum_order_value: number | null }>(`${base}/minimum-order`),
      apiFetch<{ today: string; days: BoardDay[] }>(`${base}/delivery-windows/board`),
      apiFetch<{ counts: Record<string, number> }>(`${base}/order-queue?limit=1`),
      apiFetch<{ summary: { low: number; out: number } }>(`${base}/stock/board?limit=1`),
      apiFetch<{ status: string }[]>(`${base}/returns`),
      isOwner
        ? apiFetch<{ branch_id: string; status: string; expires_at: string }[]>(`/vendors/${vendorId}/staff-invites`)
        : Promise.resolve(null),
    ];
    void Promise.allSettled([hours, closures, minimum, board, orders, stock, returns, invites]).then((r) => {
      if (!alive) return;
      const ok = <T,>(x: PromiseSettledResult<T>): T | null => (x.status === "fulfilled" ? x.value : null);
      const now = Date.now();
      const h = ok(r[0] as PromiseSettledResult<{ opening: Opening }>);
      const cl = ok(r[1] as PromiseSettledResult<Closure[]>);
      const mo = ok(r[2] as PromiseSettledResult<{ minimum_order_value: number | null }>);
      const bd = ok(r[3] as PromiseSettledResult<{ today: string; days: BoardDay[] }>);
      const oq = ok(r[4] as PromiseSettledResult<{ counts: Record<string, number> }>);
      const sb = ok(r[5] as PromiseSettledResult<{ summary: { low: number; out: number } }>);
      const rt = ok(r[6] as PromiseSettledResult<{ status: string }[]>);
      const iv = ok(r[7] as PromiseSettledResult<{ branch_id: string; status: string; expires_at: string }[] | null>);

      let delivery: Facts["delivery"] = null;
      if (bd) {
        const any = bd.days.some((d) => d.windows.length > 0);
        let next: { date: string; start: string; end: string } | null = null;
        for (const d of bd.days) {
          const w = d.windows.find((x) => x.status === "OPEN");
          if (w) {
            next = { date: d.date, start: w.start_time, end: w.end_time };
            break;
          }
        }
        delivery = next ? { kind: "open", ...next, today: bd.today } : any ? { kind: "none" } : { kind: "no_windows" };
      }

      const follow: Facts["follow"] = [];
      if (oq) {
        follow.push({ key: "orders_new", n: oq.counts.new ?? 0, href: href("orders", "?tab=new") });
        follow.push({ key: "orders_attention", n: oq.counts.attention ?? 0, href: href("orders", "?tab=attention") });
        follow.push({ key: "orders_late", n: oq.counts.late ?? 0, href: href("orders", "?late=1") });
      }
      if (sb) {
        follow.push({ key: "stock_out", n: sb.summary.out, href: href("stock", "?filter=out") });
        follow.push({ key: "stock_low", n: sb.summary.low, href: href("stock", "?filter=low") });
      }
      if (rt) {
        follow.push({ key: "returns_pending", n: rt.filter((x) => x.status === "REQUESTED").length, href: href("returns") });
        follow.push({ key: "returns_dropoff", n: rt.filter((x) => x.status === "APPROVED_AWAITING_DROPOFF").length, href: href("returns", "?tab=awaiting_dropoff") });
      }
      if (iv) {
        const n = iv.filter((x) => x.branch_id === branchId && x.status === "PENDING" && new Date(x.expires_at).getTime() > now).length;
        follow.push({ key: "invites", n, href: href("staff") });
      }
      setFacts({
        opening: h?.opening ?? null,
        closure: cl?.find((c) => new Date(c.starts_at).getTime() <= now && new Date(c.ends_at).getTime() > now) ?? null,
        delivery,
        minimum: mo?.minimum_order_value ?? null,
        follow: follow.filter((f) => f.n > 0),
        partial: r.some((x) => x.status === "rejected"),
      });
    });
    return () => {
      alive = false;
    };
    // the branch and the role decide what is read
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorId, branchId, isOwner]);

  if (!facts) {
    return (
      <div className="bov" aria-busy="true">
        <p className="visually-hidden" role="status">{t("bov.loading")}</p>
        <div className="skeleton" style={{ height: 120, width: "100%" }} />
        <div className="skeleton" style={{ height: 160, width: "100%" }} />
      </div>
    );
  }

  const nowItems: { key: string; tone: "ok" | "off" | "note"; text: ReactNode }[] = [];
  const o = facts.opening;
  if (o) {
    if (o.open_now === null) nowItems.push({ key: "hours", tone: "note", text: t("bov.no_hours") });
    else if (o.open_now) nowItems.push({ key: "hours", tone: "ok", text: o.open_until ? fillBr(t("bov.open_until"), { t: when(o.open_until, lang, t) }) : t("bov.open") });
    else nowItems.push({ key: "hours", tone: "off", text: o.next_open_at ? fillBr(t("bov.closed_next"), { t: when(o.next_open_at, lang, t) }) : t("bov.closed") });
  }
  if (facts.closure) {
    nowItems.push({
      key: "closure",
      tone: "off",
      text: (
        <>
          {fillBr(t("bov.closure_until"), { t: when(facts.closure.ends_at, lang, t) })}
          {facts.closure.reason && <span className="bov-muted" dir="auto"> · {facts.closure.reason}</span>}
        </>
      ),
    });
  }
  const d = facts.delivery;
  if (d) {
    if (d.kind === "open") {
      nowItems.push({ key: "delivery", tone: "ok", text: fillBr(t("bov.delivery_open"), { t: `${dayWord(d.date, d.today, lang, t)} ${d.start}–${d.end}` }) });
    } else {
      nowItems.push({ key: "delivery", tone: "off", text: t(d.kind === "none" ? "bov.delivery_none" : "bov.delivery_no_windows") });
    }
  }
  if (facts.minimum !== null && facts.minimum > 0) {
    nowItems.push({ key: "minimum", tone: "note", text: fillBr(t("bov.minimum"), { v: new Intl.NumberFormat(loc(lang), { maximumFractionDigits: 2 }).format(facts.minimum) + " ₪" }) });
  }

  const quick: { tab: string; label: string }[] = [
    { tab: "orders", label: t("br.nav.orders") },
    { tab: "stock", label: t("br.nav.stock") },
    { tab: "hours", label: t("br.nav.hours") },
    { tab: "returns", label: t("br.nav.returns") },
  ];

  return (
    <div className="bov" data-testid="br-overview">
      {nowItems.length > 0 && (
        <section className="bov-sec" aria-labelledby="bov-now-title">
          <h2 id="bov-now-title" className="bov-title">{t("bov.now")}</h2>
          <ul className="bov-now" data-testid="bov-now">
            {nowItems.map((i) => (
              <li key={i.key} className={`bov-now-item is-${i.tone}`} data-testid={`bov-now-${i.key}`}>
                <span className="bov-dot" aria-hidden="true" />
                <span>{i.text}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="bov-sec" aria-labelledby="bov-follow-title">
        <h2 id="bov-follow-title" className="bov-title">{t("bov.follow")}</h2>
        {facts.follow.length === 0 ? (
          <p className="bov-clear" data-testid="bov-follow-none">{t("bov.follow_none")}</p>
        ) : (
          <ul className="bov-follow" data-testid="bov-follow">
            {facts.follow.map((f) => (
              <li key={f.key}>
                <Link href={f.href} replace className="bov-follow-link" data-testid={`bov-follow-${f.key}`}>
                  <span className="bov-count">{new Intl.NumberFormat(loc(lang)).format(f.n)}</span>
                  <span className="bov-follow-text">{t(`bov.f.${f.key}`)}</span>
                  <span className="bov-go" aria-hidden="true">‹</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {facts.partial && <p className="bov-muted" role="status" data-testid="bov-partial">{t("bov.partial")}</p>}
      </section>

      <nav className="bov-quick" aria-label={t("bov.quick")} data-testid="bov-quick">
        {quick.map((q) => (
          <Link key={q.tab} href={href(q.tab)} replace className="bov-quick-link" data-testid={`br-link-${q.tab}`}>
            {q.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
