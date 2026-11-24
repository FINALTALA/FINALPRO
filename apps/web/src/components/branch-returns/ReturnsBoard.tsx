"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useBranchWorkspace } from "@/components/owner/BranchWorkspace";
import { EmptyState } from "@/components/States";
import SafeImage from "@/components/SafeImage";
import { ApiError } from "@/lib/api";
import { isUnauthorized } from "@/lib/apiErrors";
import { relativeTime } from "@/lib/branchOrders";
import {
  RETURN_TABS,
  fetchReturn,
  fetchReturnQueue,
  fetchReturnTimeline,
  itemColor,
  itemTitle,
  readReturnFilters,
  type ReturnDetail,
  type ReturnEvent,
  type ReturnFilters,
  type ReturnRow,
  type ReturnTab,
} from "@/lib/branchReturns";
import { fillRb } from "@/lib/branchReturnsText";
import { returnReasonLabel, returnStatusLabel } from "@/lib/returns";
import { useLang, useT } from "@/lib/useLang";
import { useSessionExpiredRedirect } from "@/lib/useSessionExpiredRedirect";
import { ReturnPolicySummary } from "./BranchReturnsTools";
import ReceiveReturnDialog, { moneyLine } from "./ReceiveReturnDialog";
import ReturnDetailView from "./ReturnDetailView";
import "../branch-orders/branchOrders.css";
import "./returnsBoard.css";

/** Below this width of the board itself: the list, then a full detail screen. */
const NARROW = 860;

/**
 * IX-P2 «لوحة إرجاعات الفرع» (2026-11-23): the branch's returns as an
 * operating screen, the same shape as «إدارة الطلبات» - on a computer the list
 * and the chosen return side by side; on a phone the list, then the return as
 * a full screen with «رجوع». Tabs with the server's counts, search, type and
 * date filters; the owner's scope «هذا الفرع | كل الفروع» (an employee: her
 * branch only, no scope). «استلام إرجاع» in the head is the ONE entry for a
 * return code (?receive=1; the old ?redeem=1 and /returns/redeem open it).
 * Everything shown is in the URL (tab, filters, search, the return).
 */
export default function ReturnsBoard({ vendorId, branchId }: { vendorId: string; branchId: string }) {
  const t = useT();
  const lang = useLang();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const ws = useBranchWorkspace(vendorId);
  const onExpired = useSessionExpiredRedirect();
  const urlFilters = useMemo(() => readReturnFilters(new URLSearchParams(sp.toString())), [sp]);
  const filters = useMemo<ReturnFilters>(
    () => (ws.isOwner || urlFilters.scope === "branch" ? urlFilters : { ...urlFilters, scope: "branch", branch: null }),
    [urlFilters, ws.isOwner],
  );
  const allScope = filters.scope === "all";
  const [pendingScope, setPendingScope] = useState<"all" | "branch" | null>(null);
  if (pendingScope !== null && pendingScope === filters.scope) setPendingScope(null);
  const shownAll = (pendingScope ?? filters.scope) === "all";
  const selected = sp.get("return");
  const receiveOpen = sp.get("receive") === "1" || sp.get("redeem") === "1";

  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const receiveBtnRef = useRef<HTMLButtonElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [rows, setRows] = useState<ReturnRow[] | null>(null);
  const [counts, setCounts] = useState<Record<ReturnTab, number> | null>(null);
  const [branchCounts, setBranchCounts] = useState<Record<string, number>>({});
  const [cursor, setCursor] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [rd, setRd] = useState<{
    id: string;
    detail: ReturnDetail | null;
    events: ReturnEvent[] | null;
    truncated: boolean;
    missing: boolean;
    error: boolean;
  } | null>(null);
  const cur = rd && rd.id === selected ? rd : null;
  const detail = cur?.detail ?? null;
  const [notice, setNotice] = useState("");
  const [searchText, setSearchText] = useState(filters.q);
  const [qSeen, setQSeen] = useState(filters.q);
  if (qSeen !== filters.q) {
    setQSeen(filters.q);
    setSearchText(filters.q);
  }
  const pushedRef = useRef(false);
  const scrollRef = useRef(0);
  const listSeq = useRef(0);
  const detailSeq = useRef(0);

  const foreign = ws.ready && !ws.isOwner && ws.ownBranchId !== null && ws.ownBranchId !== branchId;
  const canLoad = ws.ready && !foreign;
  const branch = ws.branches?.find((b) => b.id === branchId);
  const branchName = branch?.name ?? "";
  const archived = Boolean(branch?.archived_at);

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

  // ---- the list
  const loadList = useCallback((): Promise<void> => {
    const seq = ++listSeq.current;
    return fetchReturnQueue(vendorId, branchId, filters).then(
      (page) => {
        if (seq !== listSeq.current) return;
        setRows(page.items);
        setCounts(page.counts);
        setBranchCounts(Object.fromEntries((page.branch_counts ?? []).map((b) => [b.branch_id, b.open])));
        setCursor(page.next_cursor);
        setListError(null);
      },
      (err: unknown) => {
        if (seq !== listSeq.current) return;
        if (isUnauthorized(err)) return onExpired();
        setListError("rb.err.list");
      },
    );
  }, [vendorId, branchId, filters, onExpired]);

  useEffect(() => {
    if (!canLoad) return;
    void loadList();
  }, [canLoad, loadList]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await fetchReturnQueue(vendorId, branchId, filters, cursor);
      setRows((r) => [...(r ?? []), ...page.items.filter((i) => !(r ?? []).some((x) => x.id === i.id))]);
      setCounts(page.counts);
      setCursor(page.next_cursor);
    } catch (err) {
      if (isUnauthorized(err)) return onExpired();
      setListError("rb.err.list");
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    if (!notice) return;
    const h = window.setTimeout(() => setNotice(""), 6000);
    return () => window.clearTimeout(h);
  }, [notice]);

  // the search box writes to the URL after a short pause
  useEffect(() => {
    if (searchText === filters.q) return;
    const h = window.setTimeout(() => go({ q: searchText.trim() || null }), 350);
    return () => window.clearTimeout(h);
  }, [searchText, filters.q, go]);

  // ---- one return (in «كل الفروع»: under its own branch - from its row, or ?rb= of a link)
  const rbParam = sp.get("rb");
  const detailBranch = allScope
    ? (rows?.find((r) => r.id === selected)?.branch_id ?? (rbParam && /^[0-9a-f-]{36}$/i.test(rbParam) ? rbParam : null))
    : branchId;
  const loadDetail = useCallback(
    (id: string): Promise<void> => {
      const seq = ++detailSeq.current;
      if (!detailBranch) return Promise.resolve();
      return Promise.all([fetchReturn(vendorId, detailBranch, id), fetchReturnTimeline(vendorId, detailBranch, id)]).then(
        ([d, tl]) => {
          if (seq !== detailSeq.current) return;
          setRd({ id, detail: d, events: tl.items, truncated: tl.truncated, missing: false, error: false });
        },
        (err: unknown) => {
          if (seq !== detailSeq.current) return;
          if (isUnauthorized(err)) return onExpired();
          const missing = err instanceof ApiError && (err.status === 404 || err.status === 403);
          setRd({ id, detail: null, events: null, truncated: false, missing, error: !missing });
        },
      );
    },
    [vendorId, detailBranch, onExpired],
  );

  useEffect(() => {
    if (!canLoad || !selected || !detailBranch) {
      detailSeq.current += 1;
      return;
    }
    void loadDetail(selected);
  }, [canLoad, selected, detailBranch, loadDetail]);

  useEffect(() => {
    if (narrow && detail && detail.id === selected) headingRef.current?.focus();
  }, [narrow, detail, selected]);

  useEffect(() => {
    if (!rows || !selected) return;
    listRef.current?.querySelector(`[data-return-id="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [rows, selected]);

  useEffect(() => {
    if (narrow && !selected && scrollRef.current) {
      const y = scrollRef.current;
      window.requestAnimationFrame(() => window.scrollTo({ top: y }));
    }
  }, [narrow, selected]);

  function openReturn(id: string) {
    if (id === selected) return;
    const rb = allScope ? (rows?.find((r) => r.id === id)?.branch_id ?? null) : null;
    if (narrow) {
      scrollRef.current = window.scrollY;
      pushedRef.current = true;
      go({ return: id, rb }, "push");
      window.scrollTo({ top: 0 });
    } else {
      go({ return: id, rb });
    }
  }
  function backToList() {
    if (pushedRef.current) {
      pushedRef.current = false;
      router.back();
    } else {
      go({ return: null, rb: null });
    }
  }
  async function refreshAll() {
    await Promise.all([loadList(), selected ? loadDetail(selected) : Promise.resolve()]);
  }
  function setReceive(open: boolean) {
    go({ receive: open ? "1" : null, redeem: null });
  }
  // the dialog closed (it leaves with the URL): the focus goes back to «استلام إرجاع»
  const wasReceiveOpen = useRef(receiveOpen);
  useEffect(() => {
    if (wasReceiveOpen.current && !receiveOpen) receiveBtnRef.current?.focus();
    wasReceiveOpen.current = receiveOpen;
  }, [receiveOpen]);

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
  const hrefFor = (r: ReturnRow) => {
    const next = new URLSearchParams(sp.toString());
    next.set("return", r.id);
    if (allScope) next.set("rb", r.branch_id);
    return `${pathname}?${next.toString()}`;
  };
  const setScope = (all: boolean) => {
    setPendingScope(all ? "all" : "branch");
    go({ scope: all ? "all" : null, branch: null, return: null, rb: null });
  };

  // ---------------------------------------------------------------- render
  if (!ws.ready) return <div className="skeleton" style={{ height: 320, width: "100%" }} />;
  if (foreign) {
    return (
      <div className="page-shell br-ws">
        <EmptyState title={t("rb.foreign")} actionHref={ws.ownBranchId ? `/vendor/${vendorId}/branches/${ws.ownBranchId}/returns` : "/account"} actionLabel={t("rb.to_own")} />
      </div>
    );
  }

  const owner = ws.isOwner;
  const showDetailOnly = narrow && Boolean(selected);
  const filtered = filters.outcome !== null || filters.q !== "" || filters.from !== null || filters.to !== null || filters.branch !== null;

  const head = (
    <div className="rb-head" hidden={showDetailOnly}>
      <ReturnPolicySummary vendorId={vendorId} isOwner={owner} />
      {!archived && (
        <button ref={receiveBtnRef} type="button" className="bo-btn bo-btn-primary rb-receive-open" onClick={() => setReceive(true)} data-testid="rb-receive-open">
          <ScanIcon /> {t("rb.receive.open")}
        </button>
      )}
    </div>
  );

  const list = (
    <section className="bo-queue" aria-labelledby="rb-list-title" hidden={showDetailOnly}>
      <h2 id="rb-list-title" className="visually-hidden">{t("rb.list")}</h2>
      {owner && (
        <fieldset className="bo-scope" data-testid="rb-scope">
          <legend className="visually-hidden">{t("rb.scope")}</legend>
          <label className={`bo-scope-opt${!shownAll ? " is-on" : ""}`}>
            <input type="radio" name="rb-scope" checked={!shownAll} onChange={() => setScope(false)} data-testid="rb-scope-branch" />
            <span>{t("rb.scope.branch")}</span>
            {branchName && <span className="bo-scope-name" dir="auto">{branchName}</span>}
          </label>
          <label className={`bo-scope-opt${shownAll ? " is-on" : ""}`}>
            <input type="radio" name="rb-scope" checked={shownAll} onChange={() => setScope(true)} data-testid="rb-scope-all" />
            <span>{t("rb.scope.all")}</span>
          </label>
        </fieldset>
      )}
      <nav className="bo-tabs" aria-label={t("rb.tabs")} data-testid="rb-tabs">
        {RETURN_TABS.map((k) => {
          const n = counts?.[k] ?? null;
          return (
            <a
              key={k}
              href={`${pathname}?${new URLSearchParams({ ...(k !== "pending_decision" ? { tab: k } : {}) }).toString()}`}
              className={`bo-tab${filters.tab === k ? " is-active" : ""}`}
              aria-current={filters.tab === k ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                go({ tab: k === "pending_decision" ? null : k });
              }}
              data-testid={`rb-tab-${k}`}
            >
              {t(`rb.tab.${k}`)}
              {n !== null && <span className="bo-count" data-testid={`rb-count-${k}`}>{n}</span>}
            </a>
          );
        })}
      </nav>
      <div className="bo-filters">
        <div className="bo-search">
          <label htmlFor="rb-search" className="visually-hidden">{t("rb.search")}</label>
          <input
            id="rb-search"
            type="search"
            className="bo-input"
            value={searchText}
            maxLength={40}
            placeholder={t("rb.search.placeholder")}
            onChange={(e) => setSearchText(e.target.value.replace(/[^#0-9A-Za-z\s-]/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") go({ q: searchText.trim() || null });
            }}
            data-testid="rb-search"
          />
        </div>
        <div className="bo-seg" role="group" aria-label={t("rb.filter.type")}>
          {([null, "RETURN", "EXCHANGE"] as const).map((o) => (
            <button
              key={o ?? "all"}
              type="button"
              className={`bo-seg-btn${filters.outcome === o ? " is-on" : ""}`}
              aria-pressed={filters.outcome === o}
              onClick={() => go({ type: o })}
              data-testid={`rb-type-${o ?? "all"}`}
            >
              {o === null ? t("rb.filter.all") : t(`rb.outcome.${o}`)}
            </button>
          ))}
        </div>
        <label className="rb-date">
          <span>{t("rb.filter.from")}</span>
          <input type="date" className="bo-input" value={filters.from ?? ""} max={filters.to ?? undefined} onChange={(e) => go({ from: e.target.value || null })} data-testid="rb-from" />
        </label>
        <label className="rb-date">
          <span>{t("rb.filter.to")}</span>
          <input type="date" className="bo-input" value={filters.to ?? ""} min={filters.from ?? undefined} onChange={(e) => go({ to: e.target.value || null })} data-testid="rb-to" />
        </label>
        {(filters.from || filters.to) && (
          <button type="button" className="bo-link-btn" onClick={() => go({ from: null, to: null })} data-testid="rb-dates-clear">
            {t("rb.filter.clear_dates")}
          </button>
        )}
        {allScope && (
          <label className="bo-sort bo-branch-filter">
            <span className="visually-hidden">{t("rb.filter.branch")}</span>
            <select value={filters.branch ?? ""} onChange={(e) => go({ branch: e.target.value || null, return: null, rb: null })} aria-label={t("rb.filter.branch")} data-testid="rb-branch-filter">
              <option value="">{t("rb.filter.branch_all")}</option>
              {(ws.branches ?? [])
                .filter((b) => !b.archived_at || branchCounts[b.id])
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {fillRb(t("rb.filter.branch_n"), { name: b.name, n: branchCounts[b.id] ?? 0 })}
                  </option>
                ))}
            </select>
          </label>
        )}
      </div>
      {listError && <div className="error-banner" role="alert">{t(listError)}</div>}
      {!rows && !listError && <div className="skeleton" style={{ height: 240, width: "100%" }} />}
      {rows && rows.length === 0 && <p className="bo-empty" data-testid="rb-empty">{filtered ? t("rb.empty.filtered") : t("rb.empty")}</p>}
      {rows && rows.length > 0 && (
        <ul className="bo-list" ref={listRef} onKeyDown={onListKey} data-testid="rb-list">
          {rows.map((r) => {
            const isSel = r.id === selected;
            const color = itemColor(r.item, lang);
            const m = moneyLine(r.money, lang, t);
            return (
              <li key={r.id}>
                <a
                  href={hrefFor(r)}
                  className={`bo-row-link rb-row${isSel ? " is-selected" : ""}`}
                  aria-current={isSel ? "true" : undefined}
                  data-return-id={r.id}
                  data-testid={`rb-row-${r.id}`}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    openReturn(r.id);
                  }}
                >
                  <span className="rb-row-img" aria-hidden="true">
                    {r.item.image_url ? <SafeImage src={r.item.image_url} alt="" width={48} height={48} loading="lazy" /> : <span className="rb-item-ph" />}
                  </span>
                  <span className="rb-row-main">
                    <span className="bo-row-top">
                      <span className="rb-row-title" dir="auto">{itemTitle(r.item, lang)}</span>
                      <span className={`bo-chip rb-chip is-${r.status.toLowerCase()}`}>{returnStatusLabel(r.status, lang)}</span>
                    </span>
                    <span className="bo-row-bottom">
                      <span className="bo-muted">
                        {[color, r.item.size_label].filter(Boolean).join(" · ")}
                      </span>
                      <span className="bo-row-num" dir="ltr">#{r.order_number}</span>
                      {allScope && <span className="bo-branch" dir="auto" data-testid="rb-row-branch">{r.branch_name}</span>}
                    </span>
                    <span className="bo-row-bottom">
                      <span className={`rb-outcome is-${r.outcome.toLowerCase()}`}>{t(`rb.outcome.${r.outcome}`)}</span>
                      <span>{returnReasonLabel(r.reason, lang)}</span>
                      <span dir="auto" className="bo-row-name">{r.customer_short ?? "—"}</span>
                    </span>
                    <span className="bo-row-bottom">
                      {m && <span className="rb-row-money" data-testid="rb-row-money">{m}</span>}
                      {r.deadline ? (
                        <span className="bo-row-time" data-testid="rb-row-deadline">
                          {fillRb(t(`rb.deadline.${r.deadline.kind}`), { t: relativeTime(r.deadline.at, lang) })}
                        </span>
                      ) : (
                        <time className="bo-row-time" dateTime={r.created_at}>{relativeTime(r.created_at, lang)}</time>
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
        <button type="button" className="bo-btn bo-btn-quiet bo-more" disabled={loadingMore} aria-busy={loadingMore} onClick={() => void loadMore()} data-testid="rb-load-more">
          {loadingMore ? t("rb.loading") : t("rb.more")}
        </button>
      )}
    </section>
  );

  const back = narrow ? (
    <button type="button" className="bo-back" onClick={backToList} data-testid="rb-back">
      <span aria-hidden="true" className="bo-back-arrow">‹</span> {t("rb.back")}
    </button>
  ) : null;

  const pane = (
    <div className="bo-pane" hidden={narrow && !selected}>
      {!selected && <p className="bo-choose bo-muted">{t("rb.choose")}</p>}
      {selected && cur?.missing && (
        <div className="bo-missing" role="status" data-testid="rb-missing">
          {back}
          <p>{t("rb.not_here")}</p>
        </div>
      )}
      {selected && cur?.error && (
        <div className="bo-missing">
          {back}
          <div className="error-banner" role="alert">{t("rb.err.load")}</div>
        </div>
      )}
      {selected && !detail && !cur?.missing && !cur?.error && <div className="skeleton" style={{ height: 320, width: "100%" }} />}
      {detail && (
        <ReturnDetailView
          key={detail.id}
          vendorId={vendorId}
          branchId={detailBranch ?? branchId}
          r={detail}
          events={cur?.events ?? null}
          truncated={cur?.truncated ?? false}
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
    <div ref={rootRef} className={`bo rb${narrow ? " is-narrow" : ""}${showDetailOnly ? " is-detail" : ""}`} data-testid="returns-board">
      <h2 className="visually-hidden">{t(allScope ? "rb.title_all" : "rb.title")}</h2>
      {head}
      <p className={notice ? "bo-notice" : "visually-hidden"} role="status" aria-live="polite" data-testid="rb-notice">{notice}</p>
      <div className="bo-split">
        {list}
        {pane}
      </div>
      {receiveOpen && !archived && branchName && (
        <ReceiveReturnDialog
          vendorId={vendorId}
          branchId={branchId}
          branchName={branchName}
          isOwner={owner}
          lang={lang}
          t={t}
          onClose={() => setReceive(false)}
          onReceived={() => void refreshAll()}
        />
      )}
    </div>
  );
}

function ScanIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2M7 9v6M10 9v6M13 9v6M16 9v6" />
    </svg>
  );
}
