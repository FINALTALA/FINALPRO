"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { readCurrentBranch, useBranchWorkspace } from "@/components/owner/BranchWorkspace";
import { EmptyState } from "@/components/States";
import { ApiError } from "@/lib/api";
import DwDialog from "@/components/branch-delivery/DwDialog";
import {
  QUEUE_TABS,
  cleanSearch,
  dayLabel,
  clock,
  fetchOrder,
  fetchQueue,
  fetchTimeline,
  lateBy,
  money,
  relativeTime,
  shortDay,
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
import "@/components/branch-delivery/deliveryBoard.css";
import "./branchOrders.css";

/** Below this width of the board itself: the list, then a full detail screen. */
const NARROW = 860;
/** The lowest height of the two panes on a computer; a shorter window scrolls the page instead. */
const MIN_H = 420;
/** Statuses whose full name is too long for a queue row: the row says it shortly. */
const SHORT_STATUS = new Set(["DELIVERED", "REFUND_REQUESTED"]);
/** Below this board height on a computer the filters fold into the «الفلاتر» button. */
const COMPACT_BELOW = 560;

function readFilters(sp: URLSearchParams): QueueFilters {
  const tab = sp.get("tab");
  const method = sp.get("method");
  const sort = sp.get("sort");
  return {
    tab: QUEUE_TABS.includes(tab as QueueTab) ? (tab as QueueTab) : "active",
    method: method === "PICKUP" || method === "DELIVERY" ? method : null,
    late: sp.get("late") === "1",
    cod: sp.get("cod") === "1",
    today: sp.get("today") === "1",
    q: cleanSearch(sp.get("q") ?? ""),
    sort: sort === "newest" || sort === "priority" ? sort : null,
    date: /^\d{4}-\d{2}-\d{2}$/.test(sp.get("date") ?? "") ? sp.get("date") : null,
    window: /^[0-9a-f-]{36}$/i.test(sp.get("window") ?? "") ? sp.get("window") : null,
    scope: sp.get("scope") === "all" ? "all" : "branch",
    branch: /^[0-9a-f-]{36}$/i.test(sp.get("branch") ?? "") ? sp.get("branch") : null,
  };
}

/**
 * «إدارة طلبات الفرع v1» (2026-11-22): the branch's operating screen.
 * Desktop: the queue on one side, the chosen order on the other, one line
 * between them. Phone: the queue, then the order as a full screen with one
 * «رجوع» back to the same tab, filters and scroll. Everything the screen
 * shows is in the URL (tab, filters, search, the order), so a link -
 * a notification's included - opens exactly that. The owner also picks the
 * scope: «الفرع الحالي» (default) or «كل الفروع» (?scope=all: every branch,
 * a branch badge on each order, a branch filter; an opened order keeps its
 * branch in ?ob= and its actions go to that branch). An employee never gets
 * the scope (the server refuses it too).
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
  const urlFilters = useMemo(() => readFilters(new URLSearchParams(sp.toString())), [sp]);
  // only the owner has a scope; anyone else always reads this branch
  const filters = useMemo<QueueFilters>(
    () => (ws.isOwner || urlFilters.scope === "branch" ? urlFilters : { ...urlFilters, scope: "branch", branch: null }),
    [urlFilters, ws.isOwner],
  );
  const allScope = filters.scope === "all";
  // the scope radios answer at once; the URL (the real state) follows a moment later
  const [pendingScope, setPendingScope] = useState<"all" | "branch" | null>(null);
  if (pendingScope !== null && pendingScope === filters.scope) setPendingScope(null);
  const shownAll = (pendingScope ?? filters.scope) === "all";
  const selected = sp.get("order");

  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /** a computer: the box that scrolls the results (only the results) */
  const resultsRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  /** a computer with a short board (e.g. inside the store's management window) */
  const [shortBoard, setShortBoard] = useState(false);
  /** the filters behind one «الفلاتر» button (a dialog, a bottom sheet on a phone) - the list keeps its room */
  const compactFilters = narrow || shortBoard;
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [counts, setCounts] = useState<QueueCounts | null>(null);
  const [branchCounts, setBranchCounts] = useState<Record<string, number>>({});
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
  // «كل الفروع»: an order neither in the loaded list nor with a branch in the link
  const unknownBranch = filters.scope === "all" && Boolean(selected) && rows !== null && !rows.some((r) => r.id === selected) && !/^[0-9a-f-]{36}$/i.test(sp.get("ob") ?? "");
  const orderMissing = cur?.missing ?? unknownBranch;
  const orderError = cur?.error ?? null;
  const [notice, setNotice] = useState("");
  /** a phone: the filters live in a bottom sheet */
  const [sheetOpen, setSheetOpen] = useState(false);
  const filtersBtnRef = useRef<HTMLButtonElement>(null);
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

  // The two panes fill exactly what is left of the window under the branch
  // header and its tools bar on a computer: the page (or the management
  // window around it) does not scroll - only the list and the details do,
  // each inside its own box. Below MIN_H (a very short window) the page may
  // scroll as a last resort.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || narrow) return;
    const fit = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      let h = Math.max(MIN_H, Math.round(window.innerHeight - top - 12));
      el.style.setProperty("--bo-h", `${h}px`);
      // whatever the page keeps under the board (paddings, the shell's space) must fit too
      const over = document.documentElement.scrollHeight - window.innerHeight;
      if (over > 0 && h > MIN_H) {
        h = Math.max(MIN_H, h - over);
        el.style.setProperty("--bo-h", `${h}px`);
      }
      setShortBoard(h < COMPACT_BELOW);
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
        setBranchCounts(Object.fromEntries((page.branch_counts ?? []).map((b) => [b.branch_id, b.active])));
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

  // ---- one order (in «كل الفروع»: under its own branch - from its row, or ?ob= of a link)
  const obParam = sp.get("ob");
  const detailBranch = allScope
    ? (rows?.find((r) => r.id === selected)?.branch_id ?? (obParam && /^[0-9a-f-]{36}$/i.test(obParam) ? obParam : null))
    : branchId;
  const loadOrder = useCallback(
    (id: string): Promise<void> => {
      const seq = ++orderSeq.current;
      if (!detailBranch) return Promise.resolve();
      return Promise.all([fetchOrder(vendorId, detailBranch, id), fetchTimeline(vendorId, detailBranch, id)]).then(
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
    [vendorId, detailBranch, onExpired],
  );

  useEffect(() => {
    // «كل الفروع»: the order's branch comes from the list (or the link's ?ob=)
    if (!canLoad || !selected || !detailBranch) {
      // a reply still on its way for an order no longer chosen is dropped
      orderSeq.current += 1;
      return;
    }
    void loadOrder(selected);
  }, [canLoad, selected, detailBranch, loadOrder]);

  // on a phone the order is its own screen: its title takes the focus
  useEffect(() => {
    if (narrow && order && order.id === selected) headingRef.current?.focus();
  }, [narrow, order, selected]);

  // the linked order is in view in the list
  useEffect(() => {
    if (!rows || !selected) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-order-id="${CSS.escape(selected)}"]`);
    const box = resultsRef.current;
    if (!el) return;
    if (narrow || !box) {
      el.scrollIntoView({ block: "nearest" });
      return;
    }
    // a computer: only the results box moves - never the page or the window around it
    const r = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (r.top < b.top) box.scrollTop -= b.top - r.top + 8;
    else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom + 8;
  }, [rows, selected, narrow]);

  // a phone returning to the queue: the same scroll position
  useEffect(() => {
    if (narrow && !selected && scrollRef.current) {
      const y = scrollRef.current;
      window.requestAnimationFrame(() => window.scrollTo({ top: y }));
    }
  }, [narrow, selected]);

  function openOrder(id: string) {
    if (id === selected) return;
    const ob = allScope ? (rows?.find((r) => r.id === id)?.branch_id ?? null) : null;
    if (narrow) {
      scrollRef.current = window.scrollY;
      pushedRef.current = true;
      go({ order: id, ob }, "push");
      window.scrollTo({ top: 0 });
    } else {
      go({ order: id, ob });
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

  const hrefFor = (r: QueueRow) => {
    const next = new URLSearchParams(sp.toString());
    next.set("order", r.id);
    if (allScope) next.set("ob", r.branch_id);
    return `${pathname}?${next.toString()}`;
  };
  const setScope = (all: boolean) => {
    setPendingScope(all ? "all" : "branch");
    go({ scope: all ? "all" : null, branch: null, order: null, ob: null, date: null, window: null, slot: null, cursor: null });
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
  const filtered =
    filters.method !== null || filters.late || filters.cod || filters.today || filters.q !== "" || filters.date !== null || filters.branch !== null;
  /** the filters chosen in the sheet (a phone): shown on its button */
  const activeFilters = [filters.method !== null, filters.late, filters.cod, filters.today, allScope && filters.branch !== null].filter(Boolean).length;
  const closeSheet = () => {
    setSheetOpen(false);
    window.setTimeout(() => filtersBtnRef.current?.focus(), 0);
  };
  const slotLabel = sp.get("slot");
  const inTab =
    !order || filters.tab === order.bucket || (filters.tab === "active" && order.bucket !== "done");
  const sortValue = filters.sort ?? (filters.tab === "done" ? "newest" : "priority");

  // The filters: in a row on a computer, in a bottom sheet on a phone (one
  // copy at a time). Every change goes to the URL at once.
  const toggle = (key: "late" | "cod" | "today", on: boolean, label: string) => (
    <label className={`bo-check${on ? " is-on" : ""}`}>
      {/* ticks at once (the URL follows, then re-creates it with the same value) */}
      <input key={String(on)} type="checkbox" defaultChecked={on} onChange={(e) => go({ [key]: e.target.checked ? "1" : null, cursor: null })} data-testid={`bo-${key}`} />
      <span>{label}</span>
    </label>
  );
  const filterControls = (
    <>
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
      <div className="bo-toggles">
        {toggle("late", filters.late, counts ? fillBo(t("bo.filter.late_n"), { n: counts.late }) : t("bo.filter.late"))}
        {toggle("cod", filters.cod, t("bo.filter.cod"))}
        {toggle("today", filters.today, t("bo.filter.today"))}
      </div>
      {allScope && (
        <label className="bo-sort bo-branch-filter">
          <span className="visually-hidden">{t("bo.filter.branch")}</span>
          <select value={filters.branch ?? ""} onChange={(e) => go({ branch: e.target.value || null, order: null, ob: null })} aria-label={t("bo.filter.branch")} data-testid="bo-branch-filter">
            <option value="">{t("bo.filter.branch_all")}</option>
            {(ws.branches ?? [])
              .filter((b) => !b.archived_at || branchCounts[b.id])
              .map((b) => (
                <option key={b.id} value={b.id}>
                  {fillBo(t("bo.filter.branch_n"), { name: b.name, n: branchCounts[b.id] ?? 0 })}
                </option>
              ))}
          </select>
        </label>
      )}
      {owner && (
        <label className="bo-sort">
          <span className="visually-hidden">{t("bo.sort")}</span>
          <select value={sortValue} onChange={(e) => go({ sort: e.target.value === (filters.tab === "done" ? "newest" : "priority") ? null : e.target.value })} aria-label={t("bo.sort")} data-testid="bo-sort">
            <option value="priority">{t("bo.sort.priority")}</option>
            <option value="newest">{t("bo.sort.newest")}</option>
          </select>
        </label>
      )}
    </>
  );

  const queue = (
    <section className="bo-queue" aria-labelledby="bo-queue-title" hidden={showDetailOnly}>
      {/* the head of the list stays: title, scope, tabs, search and filters; only the results below scroll */}
      <div className="bo-queue-head" data-testid="bo-queue-head">
      <div className="bo-pane-head-row bo-queue-title-row">
        <h2 id="bo-queue-title" className="bo-pane-title">{t("bo.list_title")}</h2>
      {owner && (
        <fieldset className="bo-scope" data-testid="bo-scope">
          <legend className="visually-hidden">{t("bo.scope")}</legend>
          <label className={`bo-scope-opt${!shownAll ? " is-on" : ""}`}>
            <input type="radio" name="bo-scope" checked={!shownAll} onChange={() => setScope(false)} data-testid="bo-scope-branch" />
            <span>{t("bo.scope.branch")}</span>
            {branchName && <span className="bo-scope-name" dir="auto">{branchName}</span>}
          </label>
          <label className={`bo-scope-opt${shownAll ? " is-on" : ""}`}>
            <input type="radio" name="bo-scope" checked={shownAll} onChange={() => setScope(true)} data-testid="bo-scope-all" />
            <span>{t("bo.scope.all")}</span>
          </label>
        </fieldset>
      )}
      </div>
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
      {filters.date && (
        <p className="bo-slot-filter" role="status" data-testid="bo-slot-filter">
          <span>
            {fillBo(t(filters.window ? "bo.filter.slot_window" : "bo.filter.slot"), {
              date: filters.date,
              time: slotLabel && /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(slotLabel) ? slotLabel : "",
            })}
          </span>
          <button type="button" className="bo-link-btn" onClick={() => go({ date: null, window: null, slot: null })} data-testid="bo-slot-filter-clear">
            {t("bo.filter.slot_clear")}
          </button>
        </p>
      )}
      <div className={`bo-filters${compactFilters ? " is-compact" : ""}`}>
        <div className="bo-search">
          <label htmlFor="bo-search" className="visually-hidden">{t("bo.search")}</label>
          <input
            id="bo-search"
            type="search"
            className="bo-input"
            value={searchText}
            maxLength={40}
            dir="auto"
            placeholder={t("bo.search.placeholder")}
            onChange={(e) => setSearchText(cleanSearch(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === "Enter") go({ q: searchText.trim() || null });
            }}
            data-testid="bo-search"
          />
        </div>
        {compactFilters ? (
          <button
            ref={filtersBtnRef}
            type="button"
            className={`bo-btn bo-btn-quiet bo-filters-open${activeFilters ? " is-on" : ""}`}
            aria-haspopup="dialog"
            onClick={() => setSheetOpen(true)}
            data-testid="bo-filters-open"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M4 6h16M7 12h10M10 18h4" />
            </svg>
            {activeFilters ? fillBo(t("bo.filters_n"), { n: activeFilters }) : t("bo.filters")}
          </button>
        ) : (
          filterControls
        )}
      </div>
      {/* a computer with the filters folded: what is on stays in sight, each removable */}
      {compactFilters && !narrow && activeFilters > 0 && (
        <ul className="bo-active-filters" aria-label={t("bo.filters")} data-testid="bo-active-filters">
          {(
            [
              filters.method ? ["method", t(filters.method === "PICKUP" ? "bo.filter.pickup" : "bo.filter.delivery")] : null,
              filters.late ? ["late", t("bo.filter.late")] : null,
              filters.cod ? ["cod", t("bo.filter.cod")] : null,
              filters.today ? ["today", t("bo.filter.today")] : null,
              allScope && filters.branch ? ["branch", ws.branches?.find((b) => b.id === filters.branch)?.name ?? t("bo.filter.branch")] : null,
            ].filter(Boolean) as [string, string][]
          ).map(([key, label]) => (
            <li key={key}>
              <button
                type="button"
                className="bo-active-filter"
                onClick={() => go({ [key]: null, ...(key === "branch" ? { order: null, ob: null } : {}) })}
                aria-label={fillBo(t("bo.filters.remove"), { f: label })}
                data-testid={`bo-active-${key}`}
              >
                <span dir="auto">{label}</span>
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {sheetOpen && compactFilters && (
        <DwDialog title={t("bo.filters.title")} busy={false} onClose={closeSheet} testId="bo-filters-sheet">
          <div className="bo-sheet-filters">{filterControls}</div>
          <div className="dw-dialog-actions">
            <button type="button" className="bo-btn bo-btn-primary" onClick={closeSheet} data-testid="bo-filters-done">
              {t("bo.filters.done")}
            </button>
            {activeFilters > 0 && (
              <button
                type="button"
                className="bo-btn bo-btn-quiet"
                onClick={() => go({ method: null, late: null, cod: null, today: null, branch: null, order: null, ob: null })}
                data-testid="bo-filters-clear"
              >
                {t("bo.filters.clear")}
              </button>
            )}
          </div>
        </DwDialog>
      )}
      {listError && <div className="error-banner" role="alert">{listError}</div>}
      {order && !inTab && (
        <p className="bo-hint" role="status" data-testid="bo-not-in-tab">
          {t("bo.not_in_tab")}{" "}
          <button type="button" className="bo-link-btn" onClick={() => go({ tab: order.bucket === "done" ? "done" : null })}>
            {fillBo(t("bo.show_in_tab"), { tab: t(`bo.tab.${order.bucket === "done" ? "done" : "active"}`) })}
          </button>
        </p>
      )}
      </div>
      <div className="bo-results" ref={resultsRef} data-testid="bo-results">
      {!rows && !listError && <div className="skeleton" style={{ height: 240, width: "100%" }} />}
      {rows && rows.length === 0 && <p className="bo-empty" data-testid="bo-empty">{filtered ? t("bo.empty.filtered") : t("bo.empty")}</p>}
      {rows && rows.length > 0 && (
        <ul className="bo-list" ref={listRef} onKeyDown={onListKey} data-testid="bo-list">
          {rows.map((r) => {
            const isSel = r.id === selected;
            const hours = r.window ? `${clock(r.window.start_minute, lang)}–${clock(r.window.end_minute, lang)}` : "";
            const slot = r.scheduled_date && r.window ? `${shortDay(r.scheduled_date, lang)} · ${hours}` : null;
            const slotFull = r.scheduled_date && r.window ? `${dayLabel(r.scheduled_date, lang)} · ${hours}` : undefined;
            // phase 2: a ready order says so - «جاهز للاستلام» / «جاهز للإرسال»
            const ready = r.is_ready === true;
            const statusFull = ready ? t(`bo.ready.${r.fulfilment_method}`) : t(statusKey(r.status));
            const statusShort = !ready && SHORT_STATUS.has(r.status) ? t(`bo.short.${r.status}`) : null;
            // cash on delivery, still open: what to collect (both roles); otherwise
            // the owner sees the order's total, the employee no amount at all
            const collect = r.payment_method === "COD" && r.bucket !== "done" && r.amount_due !== null ? r.amount_due : null;
            const total = collect === null && owner && r.total !== undefined ? r.total : null;
            return (
              <li key={r.id}>
                <a
                  href={hrefFor(r)}
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
                  {/* line 1: which order and where it stands · when */}
                  <span className="bo-row-top">
                    <span className="bo-row-num" dir="ltr">#{r.number}</span>
                    {/* never cut: a long status has a short, clear name in the row; the full
                        one is read by screen readers, shown as a tooltip and in the details */}
                    <span className={`bo-chip bo-row-status ${ready ? "is-ready" : `is-${r.status.toLowerCase()}`}`} title={statusShort ? statusFull : undefined} data-testid="bo-row-status">
                      {statusShort ? (
                        <>
                          <span aria-hidden="true" data-testid="bo-row-status-short">{statusShort}</span>
                          <span className="visually-hidden">{statusFull}</span>
                        </>
                      ) : (
                        statusFull
                      )}
                    </span>
                    <span className="bo-row-method" data-testid="bo-row-method">
                      <MethodIcon method={r.fulfilment_method} />
                      <span>{r.fulfilment_method === "PICKUP" ? t("bo.filter.pickup") : t("bo.filter.delivery")}</span>
                    </span>
                    {allScope && <span className="bo-branch" dir="auto" title={r.branch_name} data-testid="bo-row-branch">{r.branch_name}</span>}
                    <span className="bo-row-time" data-testid="bo-row-time">
                      {r.is_late && r.due_at ? (
                        <span className="bo-late" data-testid="bo-row-late">{fillBo(t("bo.late"), { t: lateBy(r.due_at, lang) })}</span>
                      ) : slot ? (
                        <span title={slotFull}>{slot}</span>
                      ) : (
                        <time dateTime={r.created_at}>{relativeTime(r.created_at, lang)}</time>
                      )}
                    </span>
                  </span>
                  {/* line 2: who, how many · the money */}
                  <span className="bo-row-bottom">
                    <span dir="auto" className="bo-row-name">{r.customer_short ?? "—"}</span>
                    <span className="bo-muted bo-row-phone" dir="ltr">•••• {r.phone_last4}</span>
                    <span className="bo-muted bo-row-pieces">{r.item_count === 1 ? t("bo.item_one") : fillBo(t("bo.items_n"), { n: r.item_count })}</span>
                    {r.has_open_not_received_report && <span className="bo-pay is-warn">{t("bo.report_open")}</span>}
                    <span className="bo-row-money" data-testid="bo-row-money">
                      {collect !== null ? (
                        <span className="bo-row-amount is-cod">{fillBo(t("bo.row.collect"), { amount: money(collect, lang) })}</span>
                      ) : (
                        <>
                          {total !== null && <span className="bo-row-amount">{money(total, lang)}</span>}
                          <span className={`bo-pay${r.payment_method === "COD" ? " is-cod" : ""}`}>{t(r.payment_method === "COD" ? "bo.pay.cod" : "bo.pay.online")}</span>
                        </>
                      )}
                    </span>
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
      </div>
    </section>
  );

  const back = narrow ? (
    <button type="button" className="bo-back" onClick={backToQueue} data-testid="bo-back">
      <span aria-hidden="true" className="bo-back-arrow">‹</span> {t("bo.back")}
    </button>
  ) : null;

  const detail = (
    <div className="bo-pane" hidden={narrow && !selected} data-testid="bo-pane">
      {/* a computer: the details have their own head; only their content scrolls below it */}
      {!narrow && (
        <div className="bo-pane-head-row bo-detail-head-row">
          <p className="bo-pane-title" data-testid="bo-detail-pane-title">{t("bo.detail_title")}</p>
        </div>
      )}
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
          branchId={detailBranch ?? branchId}
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
    <div ref={rootRef} className={`bo bo-orders${narrow ? " is-narrow" : ""}${showDetailOnly ? " is-detail" : ""}`} data-testid="branch-orders">
      <h2 className="visually-hidden">{t(allScope ? "bo.title_all" : "bo.title")}</h2>
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
