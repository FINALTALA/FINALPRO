"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import SafeImage from "@/components/SafeImage";
import { useBranchWorkspace } from "@/components/owner/BranchWorkspace";
import { EmptyState } from "@/components/States";
import { ApiError } from "@/lib/api";
import { isUnauthorized } from "@/lib/apiErrors";
import { relativeTime } from "@/lib/branchOrders";
import {
  BOARD_FILTERS,
  fetchBoard,
  fetchLine,
  type BoardFilter,
  type BoardSummary,
  type StockLine,
  type StockLineDetail,
} from "@/lib/branchStock";
import { useLang, useT } from "@/lib/useLang";
import { useSessionExpiredRedirect } from "@/lib/useSessionExpiredRedirect";
import StockLineView, { Badges, lineTitle, lineVariant } from "./StockLineView";
import StockModal from "./StockModal";
import "./branchStock.css";

/** Below this width of the board itself: the list, then a full line screen. */
const NARROW = 860;

/**
 * «إدارة مخزون الفرع v1» (2026-11-22): the branch's stock operating screen.
 * Top: the summary (each number a filter), search, filters, «+ استلام بضاعة».
 * Desktop: the list on one side, the chosen line on the other. Phone: the
 * list, then the line as a full screen with one «رجوع». The URL holds the
 * search, the filter and the chosen line (`variant` - also what a low-stock
 * notice links to: that line is fetched and pinned even off the first page).
 */
export default function StockBoard({ vendorId, branchId }: { vendorId: string; branchId: string }) {
  const t = useT();
  const lang = useLang();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const ws = useBranchWorkspace(vendorId);
  const onExpired = useSessionExpiredRedirect();
  const q = sp.get("q") ?? "";
  const rawFilter = sp.get("filter");
  const filter: BoardFilter = BOARD_FILTERS.includes(rawFilter as BoardFilter) ? (rawFilter as BoardFilter) : "all";
  const selected = sp.get("variant");
  /** the line this screen was opened FOR (a low-stock link): pinned and marked */
  const [linked] = useState(selected);
  // the list pins only the linked line - choosing another line never reloads the list
  const query = useMemo(() => ({ q, filter, variant: linked }), [q, filter, linked]);

  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [rows, setRows] = useState<StockLine[] | null>(null);
  const [summary, setSummary] = useState<BoardSummary | null>(null);
  const [pinned, setPinned] = useState<StockLine | null>(null);
  const [pinnedMissing, setPinnedMissing] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [line, setLine] = useState<{ id: string; detail: StockLineDetail | null; error: string | null } | null>(null);
  const [notice, setNotice] = useState("");
  const [searchText, setSearchText] = useState(q);
  const [qSeen, setQSeen] = useState(q);
  if (qSeen !== q) {
    setQSeen(q);
    setSearchText(q);
  }
  const [receiveOpen, setReceiveOpen] = useState(false);
  /** a line opened from «+ استلام بضاعة» opens its receive form once */
  const [openReceiveFor, setOpenReceiveFor] = useState<{ id: string; n: number } | null>(null);
  const pushedRef = useRef(false);
  const scrollRef = useRef(0);
  const listSeq = useRef(0);
  const lineSeq = useRef(0);

  const foreign = ws.ready && !ws.isOwner && ws.ownBranchId !== null && ws.ownBranchId !== branchId;
  const canLoad = ws.ready && !foreign;

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < NARROW));
    ro.observe(el);
    setNarrow(el.clientWidth < NARROW);
    return () => ro.disconnect();
  }, [canLoad]);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || narrow) return;
    // the list | line area starts under the summary and the tools
    const split = el.querySelector<HTMLElement>(".sk-split") ?? el;
    const fit = () => {
      const top = split.getBoundingClientRect().top + window.scrollY;
      const h = `${Math.max(480, Math.round(window.innerHeight - top - 12))}px`;
      if (el.style.getPropertyValue("--sk-h") !== h) el.style.setProperty("--sk-h", h);
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

  // ---- the list (and the summary, and a pinned line)
  const loadBoard = useCallback((): Promise<void> => {
    const n = ++listSeq.current;
    return fetchBoard(vendorId, branchId, query).then(
      (page) => {
        if (n !== listSeq.current) return;
        setRows(page.items);
        setSummary(page.summary);
        setCursor(page.next_cursor);
        setPinned(page.pinned);
        setPinnedMissing(Boolean(query.variant) && page.pinned === null);
        setListError(null);
      },
      (err: unknown) => {
        if (n !== listSeq.current) return;
        if (isUnauthorized(err)) return onExpired();
        setListError("sk.err.load");
      },
    );
  }, [vendorId, branchId, query, onExpired]);
  useEffect(() => {
    if (canLoad) void loadBoard();
  }, [canLoad, loadBoard]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await fetchBoard(vendorId, branchId, query, cursor);
      setRows((r) => [...(r ?? []), ...page.items.filter((i) => !(r ?? []).some((x) => x.offer_variant_id === i.offer_variant_id))]);
      setCursor(page.next_cursor);
    } catch (err) {
      if (isUnauthorized(err)) return onExpired();
      setListError("sk.err.load");
    } finally {
      setLoadingMore(false);
    }
  }

  // ---- one line
  const loadLine = useCallback(
    (id: string): Promise<void> => {
      const n = ++lineSeq.current;
      return fetchLine(vendorId, branchId, id).then(
        (d) => {
          if (n === lineSeq.current) setLine({ id, detail: d, error: null });
        },
        (err: unknown) => {
          if (n !== lineSeq.current) return;
          if (isUnauthorized(err)) return onExpired();
          setLine({ id, detail: null, error: err instanceof ApiError && err.status === 404 ? "sk.pinned_missing" : "sk.err.load" });
        },
      );
    },
    [vendorId, branchId, onExpired],
  );
  useEffect(() => {
    if (!canLoad || !selected) {
      lineSeq.current += 1;
      return;
    }
    void loadLine(selected);
  }, [canLoad, selected, loadLine]);
  const current = line && line.id === selected ? line : null;

  useEffect(() => {
    if (!notice) return;
    const h = window.setTimeout(() => setNotice(""), 6000);
    return () => window.clearTimeout(h);
  }, [notice]);
  useEffect(() => {
    if (searchText === q) return;
    const h = window.setTimeout(() => go({ q: searchText.trim() || null }), 350);
    return () => window.clearTimeout(h);
  }, [searchText, q, go]);
  useEffect(() => {
    if (narrow && current?.detail) headingRef.current?.focus();
  }, [narrow, current]);
  useEffect(() => {
    if (narrow && !selected && scrollRef.current) {
      const y = scrollRef.current;
      window.requestAnimationFrame(() => window.scrollTo({ top: y }));
    }
  }, [narrow, selected]);

  function openLine(id: string) {
    if (id === selected) return;
    if (narrow) {
      scrollRef.current = window.scrollY;
      pushedRef.current = true;
      go({ variant: id }, "push");
      window.scrollTo({ top: 0 });
    } else {
      go({ variant: id });
    }
  }
  function back() {
    if (pushedRef.current) {
      pushedRef.current = false;
      router.back();
    } else {
      go({ variant: null });
    }
  }
  async function refresh() {
    await Promise.all([loadBoard(), selected ? loadLine(selected) : Promise.resolve()]);
  }
  function onListKey(e: KeyboardEvent<HTMLUListElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const links = Array.from(listRef.current?.querySelectorAll<HTMLAnchorElement>("a.sk-row-link") ?? []);
    if (!links.length) return;
    e.preventDefault();
    const i = links.indexOf(document.activeElement as HTMLAnchorElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? links.length - 1 : e.key === "ArrowDown" ? Math.min(links.length - 1, i + 1) : Math.max(0, i - 1);
    links[next]?.focus();
  }
  const hrefFor = (id: string) => {
    const next = new URLSearchParams(sp.toString());
    next.set("variant", id);
    return `${pathname}?${next.toString()}`;
  };

  if (!ws.ready) return <div className="skeleton" style={{ height: 320, width: "100%" }} />;
  if (foreign) {
    return (
      <div className="page-shell br-ws">
        <EmptyState title={t("sk.foreign")} actionHref={ws.ownBranchId ? `/vendor/${vendorId}/branches/${ws.ownBranchId}/stock` : "/account"} actionLabel={t("sk.back")} />
      </div>
    );
  }

  const showDetailOnly = narrow && Boolean(selected);
  const filtered = filter !== "all" || q !== "";
  const pinnedOffPage = pinned && !(rows ?? []).some((r) => r.offer_variant_id === pinned.offer_variant_id);

  const row = (r: StockLine, extra?: string) => {
    const isSel = r.offer_variant_id === selected;
    return (
      <li key={`${extra ?? ""}${r.offer_variant_id}`}>
        <a
          href={hrefFor(r.offer_variant_id)}
          className={`sk-row-link${isSel ? " is-selected" : ""}${linked === r.offer_variant_id ? " is-notified" : ""}`}
          aria-current={isSel ? "true" : undefined}
          data-variant-id={r.offer_variant_id}
          data-testid={`stock-row-${r.offer_variant_id}`}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            openLine(r.offer_variant_id);
          }}
        >
          <span className="sk-row-img"><SafeImage src={r.image_url} alt="" width={48} height={48} loading="lazy" /></span>
          <span className="sk-row-main">
            <span className="sk-row-title" dir="auto">{lineTitle(r, lang)}</span>
            <span className="sk-row-sub">
              {r.color_hex && <span className="sk-swatch" style={{ background: r.color_hex }} aria-hidden="true" />}
              <span dir="auto">{lineVariant(r, lang) || "—"}</span>
              <Badges line={r} t={t} />
            </span>
            <span className="sk-row-nums">
              <span><b data-testid="sk-row-available">{r.available_quantity}</b> {t("sk.available")}</span>
              <span>{r.reserved_quantity} {t("sk.reserved")}</span>
              <span>{r.quantity} {t("sk.physical")}</span>
              <span className="sk-muted">
                {r.last_physical_count_at ? relativeTime(r.last_physical_count_at, lang) : t("sk.never_counted")}
              </span>
            </span>
          </span>
        </a>
      </li>
    );
  };

  const chips: { key: BoardFilter; label: string; value: number | undefined; testId: string }[] = [
    { key: "all", label: t("sk.sum.pieces"), value: summary?.total_pieces, testId: "sk-sum-pieces" },
    { key: "all", label: t("sk.sum.lines"), value: summary?.lines, testId: "sk-sum-lines" },
    { key: "low", label: t("sk.sum.low"), value: summary?.low, testId: "sk-sum-low" },
    { key: "out", label: t("sk.sum.out"), value: summary?.out, testId: "sk-sum-out" },
    { key: "stale", label: t("sk.sum.stale"), value: summary?.stale, testId: "sk-sum-stale" },
  ];

  const list = (
    <section className="sk-list-pane" aria-labelledby="sk-list-title" hidden={showDetailOnly}>
      <h2 id="sk-list-title" className="visually-hidden">{t("sk.list")}</h2>
      {listError && <div className="error-banner" role="alert">{t(listError)}</div>}
      {pinnedMissing && <p className="sk-hint" role="status" data-testid="sk-pinned-missing">{t("sk.pinned_missing")}</p>}
      {pinned && pinnedOffPage && (
        <div className="sk-pinned" data-testid="sk-pinned">
          <p className="sk-pinned-label">{t("sk.pinned")}</p>
          <ul className="sk-list">{row(pinned, "pin-")}</ul>
        </div>
      )}
      {!rows && !listError && <div className="skeleton" style={{ height: 240, width: "100%" }} />}
      {rows && rows.length === 0 && <p className="sk-empty" data-testid="sk-empty">{filtered ? t("sk.empty.filtered") : t("sk.empty")}</p>}
      {rows && rows.length > 0 && (
        <ul className="sk-list" ref={listRef} onKeyDown={onListKey} data-testid="sk-list">
          {rows.map((r) => row(r))}
        </ul>
      )}
      {cursor && (
        <button type="button" className="sk-btn sk-btn-quiet sk-more" disabled={loadingMore} aria-busy={loadingMore} onClick={() => void loadMore()} data-testid="sk-load-more">
          {loadingMore ? t("sk.loading") : t("sk.more")}
        </button>
      )}
    </section>
  );

  const backBtn = narrow ? (
    <button type="button" className="sk-back" onClick={back} data-testid="sk-back">
      <span aria-hidden="true" className="sk-back-arrow">‹</span> {t("sk.back")}
    </button>
  ) : null;

  const detail = (
    <div className="sk-pane" hidden={narrow && !selected}>
      {!selected && <p className="sk-choose sk-muted">{t("sk.choose")}</p>}
      {selected && current?.error && (
        <div className="sk-missing" role="status" data-testid="sk-line-missing">
          {backBtn}
          <p>{t(current.error)}</p>
        </div>
      )}
      {selected && !current && <div className="skeleton" style={{ height: 320, width: "100%" }} />}
      {current?.detail && (
        <StockLineView
          key={`${current.id}:${openReceiveFor?.id === current.id ? openReceiveFor.n : 0}`}
          initialForm={openReceiveFor?.id === current.id ? "receive" : null}
          vendorId={vendorId}
          branchId={branchId}
          line={current.detail}
          isOwner={ws.isOwner}
          lang={lang}
          t={t}
          onChanged={refresh}
          onNotice={setNotice}
          headingRef={headingRef}
          backButton={backBtn}
        />
      )}
    </div>
  );

  return (
    <div ref={rootRef} className={`sk${narrow ? " is-narrow" : ""}`} data-testid="branch-stock">
      <h2 className="visually-hidden">{t("sk.title")}</h2>
      <div className="sk-top" hidden={showDetailOnly}>
        <ul className="sk-summary" aria-label={t("sk.summary")} data-testid="sk-summary">
          {chips.map((c) => (
            <li key={c.testId}>
              <button
                type="button"
                className={`sk-chip${c.key !== "all" && filter === c.key ? " is-on" : ""}${c.key === "low" || c.key === "out" ? ` is-${c.key}` : ""}`}
                aria-pressed={c.key !== "all" ? filter === c.key : undefined}
                onClick={() => go({ filter: c.key === "all" || filter === c.key ? null : c.key })}
                data-testid={c.testId}
              >
                <b>{c.value ?? "–"}</b>
                <span>{c.label}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="sk-tools">
          <label htmlFor="sk-search" className="visually-hidden">{t("sk.search")}</label>
          <input
            id="sk-search"
            type="search"
            className="sk-input sk-search"
            value={searchText}
            maxLength={60}
            placeholder={t("sk.search.placeholder")}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") go({ q: searchText.trim() || null });
            }}
            data-testid="sk-search"
          />
          <div className="sk-seg" role="group" aria-label={t("sk.filter")}>
            {BOARD_FILTERS.map((k) => (
              <button key={k} type="button" className={`sk-seg-btn${filter === k ? " is-on" : ""}`} aria-pressed={filter === k} onClick={() => go({ filter: k === "all" ? null : k })} data-testid={`sk-filter-${k}`}>
                {t(`sk.filter.${k}`)}
              </button>
            ))}
          </div>
          <button type="button" className="sk-btn sk-btn-primary" onClick={() => setReceiveOpen(true)} data-testid="sk-receive-open">
            {t("sk.receive_btn")}
          </button>
        </div>
        <p className="sk-sale-note" data-testid="stock-sale-note">
          {t("sk.sale_note")}{" "}
          <Link href={`/vendor/${vendorId}/cashier`} data-testid="stock-open-cashier">{t("sk.sale_link")}</Link>.
        </p>
      </div>
      <p className={notice ? "sk-notice" : "visually-hidden"} role="status" aria-live="polite" data-testid="sk-notice">{notice}</p>
      <div className="sk-split">
        {list}
        {detail}
      </div>
      {receiveOpen && (
        <ReceivePicker
          vendorId={vendorId}
          branchId={branchId}
          lang={lang}
          t={t}
          onClose={() => setReceiveOpen(false)}
          onPick={(id) => {
            setReceiveOpen(false);
            setOpenReceiveFor((o) => ({ id, n: (o?.n ?? 0) + 1 }));
            if (id !== selected) openLine(id);
          }}
        />
      )}
    </div>
  );
}

/** «+ استلام بضاعة»: find the line by name or a scanned barcode, then its receive form. */
function ReceivePicker({
  vendorId,
  branchId,
  lang,
  t,
  onClose,
  onPick,
}: {
  vendorId: string;
  branchId: string;
  lang: "ar" | "en";
  t: (k: string) => string;
  onClose: () => void;
  onPick: (id: string) => void;
}) {
  const [text, setText] = useState("");
  const [found, setFound] = useState<StockLine[] | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    const q = text.trim();
    const n = ++seq.current;
    const h = window.setTimeout(() => {
      fetchBoard(vendorId, branchId, { q, filter: "all", variant: null }).then(
        (p) => {
          if (n === seq.current) setFound(p.items.slice(0, 8));
        },
        () => {
          if (n === seq.current) setFound([]);
        },
      );
    }, 250);
    return () => window.clearTimeout(h);
  }, [text, vendorId, branchId]);
  return (
    <StockModal title={t("sk.receive.title")} busy={false} onClose={onClose} testId="sk-receive-picker">
      <label htmlFor="sk-receive-find" className="sk-label">{t("sk.receive.find")}</label>
      <input
        id="sk-receive-find"
        type="search"
        className="sk-input"
        value={text}
        maxLength={60}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // a store scanner types the code and presses Enter: one match opens it
          if (e.key === "Enter" && found && found.length === 1) onPick(found[0].offer_variant_id);
        }}
        data-testid="sk-receive-find"
      />
      <p className="sk-label">{t("sk.receive.pick")}</p>
      {!found && <div className="skeleton" style={{ height: 80, width: "100%" }} />}
      {found && found.length === 0 && <p className="sk-muted">{t("sk.empty.filtered")}</p>}
      {found && found.length > 0 && (
        <ul className="sk-pick-list">
          {found.map((l) => (
            <li key={l.offer_variant_id}>
              <button type="button" className="sk-pick" onClick={() => onPick(l.offer_variant_id)} data-testid={`sk-pick-${l.offer_variant_id}`}>
                <span dir="auto">{lineTitle(l, lang)}</span>
                <span className="sk-muted" dir="auto">{lineVariant(l, lang)}</span>
                <span className="sk-muted">{l.quantity} {t("sk.physical")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="sk-row sk-dialog-actions">
        <button type="button" className="sk-btn sk-btn-quiet" onClick={onClose}>{t("sk.close")}</button>
      </div>
    </StockModal>
  );
}
