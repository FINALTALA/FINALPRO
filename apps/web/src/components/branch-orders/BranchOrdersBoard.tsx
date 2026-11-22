"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { readCurrentBranch, useBranchWorkspace } from "@/components/owner/BranchWorkspace";
import { EmptyState } from "@/components/States";
import { ApiError } from "@/lib/api";
import {
  QUEUE_TABS,
  dayLabel,
  clock,
  fetchOrder,
  fetchQueue,
  fetchTimeline,
  lateBy,
  money,
  relativeTime,
  statusKey,
  type OrderDetail,
  type QueueCounts,
  type QueueFilters,
  type QueueRow,
  type QueueTab,
  type TimelineEvent,
} from "@/lib/branchOrders";
import { fillBo } from "@/lib/branchOrdersText";
import { isUnauthorized } from "@/lib/apiErrors";
import { orderListLoadError } from "@/lib/orders";
import { useLang, useT } from "@/lib/useLang";
import { useSessionExpiredRedirect } from "@/lib/useSessionExpiredRedirect";
import OrderDetailView, { MethodIcon } from "./OrderDetailView";
import "./branchOrders.css";

/** Below this width of the board itself: the list, then a full detail screen. */
const NARROW = 860;

function readFilters(sp: URLSearchParams): QueueFilters {
  const tab = sp.get("tab");
  const method = sp.get("method");
  const sort = sp.get("sort");
  return {
    tab: QUEUE_TABS.includes(tab as QueueTab) ? (tab as QueueTab) : "active",
    method: method === "PICKUP" || method === "DELIVERY" ? method : null,
    late: sp.get("late") === "1",
    q: sp.get("q") ?? "",
    sort: sort === "newest" || sort === "priority" ? sort : null,
  };
}

/**
 * «إدارة طلبات الفرع v1» (2026-11-22): the branch's operating screen.
 * Desktop: the queue on one side, the chosen order on the other, one line
 * between them. Phone: the queue, then the order as a full screen with one
 * «رجوع» back to the same tab, filters and scroll. Everything the screen
 * shows is in the URL (tab, filters, search, the order), so a link -
 * a notification's included - opens exactly that.
 */
export default function BranchOrdersBoard({ vendorId, branchId }: { vendorId: string; branchId: string }) {
  const t = useT();
  const lang = useLang();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const ws = useBranchWorkspace(vendorId);
  // an expired session: sign in again and come back here (TB-34) - never an error text
  const onExpired = useSessionExpiredRedirect();
  const filters = useMemo(() => readFilters(new URLSearchParams(sp.toString())), [sp]);
  const selected = sp.get("order");

  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [counts, setCounts] = useState<QueueCounts | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /** the last loaded order (details + activity), for the id it was loaded for */
  const [od, setOd] = useState<{
    id: string;
    order: OrderDetail | null;
    events: TimelineEvent[] | null;
    truncated: boolean;
    missing: boolean;
    error: string | null;
  } | null>(null);
  const cur = od && od.id === selected ? od : null;
  const order = cur?.order ?? null;
  const events = cur?.events ?? null;
  const truncated = cur?.truncated ?? false;
  const orderMissing = cur?.missing ?? false;
  const orderError = cur?.error ?? null;
  const [notice, setNotice] = useState("");
  const [searchText, setSearchText] = useState(filters.q);
  const [qSeen, setQSeen] = useState(filters.q);
  if (qSeen !== filters.q) {
    // the URL's search changed (back, a link, «مسح»): the box follows it
    setQSeen(filters.q);
    setSearchText(filters.q);
  }
  // The owner opened an order of another branch (a link from a notification):
  // the dashboard follows that branch - say so once. Read on the first render,
  // before the branch layout stores the new current branch (this screen only
  // renders after hydration, so the browser storage is there).
  const [switchedFrom] = useState<string | null>(() => {
    const before = readCurrentBranch(vendorId);
    return selected && before && before !== branchId ? before : null;
  });
  /** the order this screen was opened FOR (a link / notification): marked as such */
  const [linked] = useState(selected);
  const pushedRef = useRef(false);
  const scrollRef = useRef(0);
  const listSeq = useRef(0);
  const orderSeq = useRef(0);

  const foreign = ws.ready && !ws.isOwner && ws.ownBranchId !== null && ws.ownBranchId !== branchId;
  const canLoad = ws.ready && !foreign;

  // the board's own width decides the layout (it lives inside the management window)
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < NARROW));
    ro.observe(el);
    setNarrow(el.clientWidth < NARROW);
    return () => ro.disconnect();
  }, [canLoad]);

  // the two panes fit the window's height on a computer (each scrolls by itself)
  useEffect(() => {
    const el = rootRef.current;
    if (!el || narrow) return;
    const fit = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      const h = `${Math.max(480, Math.round(window.innerHeight - top - 12))}px`;
      if (el.style.getPropertyValue("--bo-h") !== h) el.style.setProperty("--bo-h", h);
    };
    fit();
    // what sits above the board (the branch header, a notice) can still load
    // after it: measure again whenever the page's layout changes
    const ro = new ResizeObserver(fit);
    ro.observe(document.body);
    window.addEventListener("resize", fit);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [narrow, canLoad]);

  const go = useCallback(
    (patch: Record<string, string | null>, mode: "replace" | "push" = "replace") => {
      const next = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "") next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      if (mode === "push") router.push(url, { scroll: false });
      else router.replace(url, { scroll: false });
    },
    [sp, pathname, router],
  );

  // ---- the queue
  const loadQueue = useCallback((): Promise<void> => {
    const seq = ++listSeq.current;
    return fetchQueue(vendorId, branchId, filters).then(
      (page) => {
        if (seq !== listSeq.current) return;
        setRows(page.items);
        setCounts(page.counts);
        setCursor(page.next_cursor);
        setListError(null);
      },
      (err: unknown) => {
        if (seq !== listSeq.current) return;
        if (isUnauthorized(err)) return onExpired();
        setListError(orderListLoadError(err, lang));
      },
    );
  }, [vendorId, branchId, filters, lang, onExpired]);

  useEffect(() => {
    if (!canLoad) return;
    void loadQueue();
  }, [canLoad, loadQueue]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await fetchQueue(vendorId, branchId, filters, cursor);
      setRows((r) => [...(r ?? []), ...page.items.filter((i) => !(r ?? []).some((x) => x.id === i.id))]);
      setCounts(page.counts);
      setCursor(page.next_cursor);
    } catch (err) {
      if (isUnauthorized(err)) return onExpired();
      setListError(orderListLoadError(err, lang));
    } finally {
      setLoadingMore(false);
    }
  }

  // an action's confirmation stays a few seconds, then leaves
  useEffect(() => {
    if (!notice) return;
    const h = window.setTimeout(() => setNotice(""), 6000);
    return () => window.clearTimeout(h);
  }, [notice]);

  // ---- the search box writes to the URL after a short pause
  useEffect(() => {
    if (searchText === filters.q) return;
    const h = window.setTimeout(() => go({ q: searchText.trim() || null }), 350);
    return () => window.clearTimeout(h);
  }, [searchText, filters.q, go]);

  // ---- one order
  const loadOrder = useCallback(
    (id: string): Promise<void> => {
      const seq = ++orderSeq.current;
      return Promise.all([fetchOrder(vendorId, branchId, id), fetchTimeline(vendorId, branchId, id)]).then(
        ([d, tl]) => {
          if (seq !== orderSeq.current) return;
          setOd({ id, order: d, events: tl.items, truncated: tl.truncated, missing: false, error: null });
        },
        (err: unknown) => {
          if (seq !== orderSeq.current) return;
          if (isUnauthorized(err)) return onExpired();
          const missing = err instanceof ApiError && err.status === 404;
          // a key, translated when shown: `t` is a new function on every render
          // and must never be a dependency of this loader (it would reload in a loop)
          setOd({ id, order: null, events: null, truncated: false, missing, error: missing ? null : "bo.err.load" });
        },
      );
    },
    [vendorId, branchId, onExpired],
  );

  useEffect(() => {
    if (!canLoad || !selected) {
      // a reply still on its way for an order no longer chosen is dropped
      orderSeq.current += 1;
      return;
    }
    void loadOrder(selected);
  }, [canLoad, selected, loadOrder]);

  // on a phone the order is its own screen: its title takes the focus
  useEffect(() => {
    if (narrow && order && order.id === selected) headingRef.current?.focus();
  }, [narrow, order, selected]);

  // the linked order is in view in the list
  useEffect(() => {
    if (!rows || !selected) return;
    const el = listRef.current?.querySelector(`[data-order-id="${CSS.escape(selected)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [rows, selected]);

  // a phone returning to the queue: the same scroll position
  useEffect(() => {
    if (narrow && !selected && scrollRef.current) {
      const y = scrollRef.current;
      window.requestAnimationFrame(() => window.scrollTo({ top: y }));
    }
  }, [narrow, selected]);

  function openOrder(id: string) {
    if (id === selected) return;
    if (narrow) {
      scrollRef.current = window.scrollY;
      pushedRef.current = true;
      go({ order: id }, "push");
      window.scrollTo({ top: 0 });
    } else {
      go({ order: id });
    }
  }
  function backToQueue() {
    if (pushedRef.current) {
      pushedRef.current = false;
      router.back();
    } else {
      go({ order: null });
    }
  }

  async function refreshAll() {
    await Promise.all([loadQueue(), selected ? loadOrder(selected) : Promise.resolve()]);
  }

  function onListKey(e: KeyboardEvent<HTMLUListElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const links = Array.from(listRef.current?.querySelectorAll<HTMLAnchorElement>("a.bo-row-link") ?? []);
    if (links.length === 0) return;
    e.preventDefault();
    const i = links.indexOf(document.activeElement as HTMLAnchorElement);
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? links.length - 1 : e.key === "ArrowDown" ? Math.min(links.length - 1, i + 1) : Math.max(0, i - 1);
    links[next]?.focus();
  }

  const hrefFor = (id: string) => {
    const next = new URLSearchParams(sp.toString());
    next.set("order", id);
    return `${pathname}?${next.toString()}`;
  };

  // ---------------------------------------------------------------- render
  if (!ws.ready) {
    return <div className="skeleton" style={{ height: 320, width: "100%" }} />;
  }
  if (foreign) {
    return (
      <div className="page-shell br-ws">
        <EmptyState title={t("bo.foreign")} actionHref={ws.ownBranchId ? `/vendor/${vendorId}/branches/${ws.ownBranchId}/orders` : "/account"} actionLabel={t("bo.back")} />
      </div>
    );
  }

  const branchName = ws.branches?.find((b) => b.id === branchId)?.name ?? "";
  const showDetailOnly = narrow && Boolean(selected);
  const owner = ws.isOwner;
  const tabCount = (k: QueueTab) => counts?.[k] ?? null;
  const filtered = filters.method !== null || filters.late || filters.q !== "";
  const inTab =
    !order || filters.tab === order.bucket || (filters.tab === "active" && order.bucket !== "done");
  const sortValue = filters.sort ?? (filters.tab === "done" ? "newest" : "priority");

  const queue = (
    <section className="bo-queue" aria-labelledby="bo-queue-title" hidden={showDetailOnly}>
      <h2 id="bo-queue-title" className="visually-hidden">{t("bo.list")}</h2>
      <nav className="bo-tabs" aria-label={t("bo.tabs")} data-testid="bo-tabs">
        {QUEUE_TABS.map((k) => {
          const n = tabCount(k);
          return (
            <a
              key={k}
              href={`${pathname}?${new URLSearchParams({ ...(k !== "active" ? { tab: k } : {}) }).toString()}`}
              className={`bo-tab${filters.tab === k ? " is-active" : ""}`}
              aria-current={filters.tab === k ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                go({ tab: k === "active" ? null : k, cursor: null });
              }}
              data-testid={`bo-tab-${k}`}
            >
              {t(`bo.tab.${k}`)}
              {n !== null && <span className="bo-count" data-testid={`bo-count-${k}`}>{n}</span>}
            </a>
          );
        })}
      </nav>
      <div className="bo-filters">
        <div className="bo-search">
          <label htmlFor="bo-search" className="visually-hidden">{t("bo.search")}</label>
          <input
            id="bo-search"
            type="search"
            className="bo-input"
            value={searchText}
            maxLength={40}
            placeholder={t("bo.search.placeholder")}
            onChange={(e) => setSearchText(e.target.value.replace(/[^#0-9A-Za-z\s-]/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") go({ q: searchText.trim() || null });
            }}
            data-testid="bo-search"
          />
        </div>
        <div className="bo-seg" role="group" aria-label={t("bo.filter.method")}>
          {([null, "PICKUP", "DELIVERY"] as const).map((m) => (
            <button
              key={m ?? "all"}
              type="button"
              className={`bo-seg-btn${filters.method === m ? " is-on" : ""}`}
              aria-pressed={filters.method === m}
              onClick={() => go({ method: m })}
              data-testid={`bo-method-${m ?? "all"}`}
            >
              {m === null ? t("bo.filter.all") : m === "PICKUP" ? t("bo.filter.pickup") : t("bo.filter.delivery")}
            </button>
          ))}
        </div>
        <label className="bo-check">
          {/* ticks at once (the URL follows, then re-creates it with the same value) */}
          <input key={String(filters.late)} type="checkbox" defaultChecked={filters.late} onChange={(e) => go({ late: e.target.checked ? "1" : null })} data-testid="bo-late" />
          <span>{counts ? fillBo(t("bo.filter.late_n"), { n: counts.late }) : t("bo.filter.late")}</span>
        </label>
        {owner && (
          <label className="bo-sort">
            <span className="visually-hidden">{t("bo.sort")}</span>
            <select value={sortValue} onChange={(e) => go({ sort: e.target.value === (filters.tab === "done" ? "newest" : "priority") ? null : e.target.value })} aria-label={t("bo.sort")} data-testid="bo-sort">
              <option value="priority">{t("bo.sort.priority")}</option>
              <option value="newest">{t("bo.sort.newest")}</option>
            </select>
          </label>
        )}
      </div>
      {listError && <div className="error-banner" role="alert">{listError}</div>}
      {order && !inTab && (
        <p className="bo-hint" role="status" data-testid="bo-not-in-tab">
          {t("bo.not_in_tab")}{" "}
          <button type="button" className="bo-link-btn" onClick={() => go({ tab: order.bucket === "done" ? "done" : null })}>
            {fillBo(t("bo.show_in_tab"), { tab: t(`bo.tab.${order.bucket === "done" ? "done" : "active"}`) })}
          </button>
        </p>
      )}
      {!rows && !listError && <div className="skeleton" style={{ height: 240, width: "100%" }} />}
      {rows && rows.length === 0 && <p className="bo-empty" data-testid="bo-empty">{filtered ? t("bo.empty.filtered") : t("bo.empty")}</p>}
      {rows && rows.length > 0 && (
        <ul className="bo-list" ref={listRef} onKeyDown={onListKey} data-testid="bo-list">
          {rows.map((r) => {
            const isSel = r.id === selected;
            const slot = r.scheduled_date && r.window ? `${dayLabel(r.scheduled_date, lang)} ${clock(r.window.start_minute, lang)}` : null;
            // the owner: the order's total; the employee: what is still to collect (open orders only)
            const amount = owner && r.total !== undefined ? r.total : r.bucket === "done" ? null : r.amount_due;
            return (
              <li key={r.id}>
                <a
                  href={hrefFor(r.id)}
                  className={`bo-row-link${isSel ? " is-selected" : ""}${isSel && linked === r.id ? " is-notified" : ""}${r.is_late ? " is-late" : ""}`}
                  aria-current={isSel ? "true" : undefined}
                  data-order-id={r.id}
                  data-testid={`branch-order-${r.id}`}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    openOrder(r.id);
                  }}
                >
                  <span className="bo-row-top">
                    <span className="bo-row-num" dir="ltr">#{r.number}</span>
                    <span className="bo-row-method" title={t(`bo.method.${r.fulfilment_method}`)}>
                      <MethodIcon method={r.fulfilment_method} />
                      <span className="visually-hidden">{t(`bo.method.${r.fulfilment_method}`)}</span>
                    </span>
                    <span className={`bo-chip is-${r.status.toLowerCase()}`}>{t(statusKey(r.status))}</span>
                    <span className="bo-row-time">
                      {r.is_late && r.due_at ? (
                        <span className="bo-late" data-testid="bo-row-late">{fillBo(t("bo.late"), { t: lateBy(r.due_at, lang) })}</span>
                      ) : slot ? (
                        <span>{slot}</span>
                      ) : (
                        <time dateTime={r.created_at}>{relativeTime(r.created_at, lang)}</time>
                      )}
                    </span>
                  </span>
                  <span className="bo-row-bottom">
                    <span dir="auto" className="bo-row-name">{r.customer_short ?? "—"}</span>
                    <span className="bo-muted" dir="ltr">•••• {r.phone_last4}</span>
                    <span className="bo-muted">{r.item_count === 1 ? t("bo.item_one") : fillBo(t("bo.items_n"), { n: r.item_count })}</span>
                    {amount !== null && amount !== undefined && <span className="bo-row-amount">{money(amount, lang)}</span>}
                    {r.payment_method === "COD" ? (
                      <span className="bo-pay is-cod">{t("bo.pay.cod")}</span>
                    ) : (
                      <span className="bo-pay">{t("bo.pay.online")}</span>
                    )}
                    {r.has_open_not_received_report && <span className="bo-pay is-warn">{t("bo.report_open")}</span>}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
      {cursor && (
        <button type="button" className="bo-btn bo-btn-quiet bo-more" disabled={loadingMore} aria-busy={loadingMore} onClick={() => void loadMore()} data-testid="bo-load-more">
          {loadingMore ? t("bo.loading") : t("bo.more")}
        </button>
      )}
    </section>
  );

  const back = narrow ? (
    <button type="button" className="bo-back" onClick={backToQueue} data-testid="bo-back">
      <span aria-hidden="true" className="bo-back-arrow">‹</span> {t("bo.back")}
    </button>
  ) : null;

  const detail = (
    <div className="bo-pane" hidden={narrow && !selected}>
      {!selected && <p className="bo-choose bo-muted">{t("bo.choose")}</p>}
      {selected && orderMissing && (
        <div className="bo-missing" role="status" data-testid="bo-missing">
          {back}
          <p>{t("bo.not_here")}</p>
        </div>
      )}
      {selected && orderError && (
        <div className="bo-missing">
          {back}
          <div className="error-banner" role="alert">{t(orderError)}</div>
        </div>
      )}
      {selected && !order && !orderMissing && !orderError && <div className="skeleton" style={{ height: 320, width: "100%" }} />}
      {order && (
        <OrderDetailView
          key={order.id}
          vendorId={vendorId}
          branchId={branchId}
          order={order}
          events={events}
          truncated={truncated}
          isOwner={owner}
          lang={lang}
          t={t}
          onChanged={refreshAll}
          onNotice={setNotice}
          headingRef={headingRef}
          backButton={back}
        />
      )}
    </div>
  );

  return (
    <div ref={rootRef} className={`bo${narrow ? " is-narrow" : ""}${showDetailOnly ? " is-detail" : ""}`} data-testid="branch-orders">
      <h2 className="visually-hidden">{t("bo.title")}</h2>
      {switchedFrom && owner && branchName && (
        <p className="bo-switched" role="status" data-testid="bo-switched">
          {fillBo(t("bo.switched"), { branch: branchName })}
        </p>
      )}
      <p className={notice ? "bo-notice" : "visually-hidden"} role="status" aria-live="polite" data-testid="bo-notice">{notice}</p>
      <div className="bo-split">
        {queue}
        {detail}
      </div>
    </div>
  );
}
