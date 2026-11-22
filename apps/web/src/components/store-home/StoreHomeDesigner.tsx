"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IconArrowDown, IconArrowUp, IconBack, IconEdit, IconEye, IconPlus, IconTrash } from "@/components/product-wizard/wizardIcons";
import { SmallConfirm } from "@/components/owner/collections/SmallConfirm";
import { ErrorBanner } from "@/components/States";
import { ApiError, IMAGE_UPLOAD_ACCEPT, uploadVendorImage } from "@/lib/api";
import { inManagementFrame, pushFrameScreen } from "@/lib/manageFrame";
import { fill } from "@/lib/offerWizardText";
import {
  BLOCK_TYPES,
  type BlockType,
  HOME_STYLES,
  HOME_TEMPLATES,
  type HomeBlock,
  type HomeLayout,
  type HomeStyle,
  type HomeTemplate,
  type OwnerHome,
  type QualityIssue,
  EMPTY_CARD,
  emptyBlock,
  imageCount,
  pick,
  storeHomeApi,
} from "@/lib/storeHome";
import { TEMPLATE_OUTLINE, buildTemplate } from "@/lib/storeHomeTemplates";
import "@/lib/storeHomeText";
import "@/lib/collectionsText";
import { useLang, useT } from "@/lib/useLang";
import { HomeBlockEditor, type KnownProduct } from "./HomeBlockEditor";
import { HomeProductPicker } from "./HomeProductPicker";
import StoreHomeBlocks from "./StoreHomeBlocks";
import { livePreview } from "@/lib/storeHomePreview";
import { AddThumb, BlockThumb, SoonPreview } from "./HomeThumbs";
import StoreInfoSection, { type StoreInfoDto } from "./StoreInfoSection";
import { PreviewGuard } from "./PreviewGuard";

type View = { kind: "list" } | { kind: "block"; id: string } | { kind: "pick"; id: string; slide: number | null | "multi" };

const AUTOSAVE_MS = 800;

/**
 * «تصميم الصفحة الرئيسية» (2026-11-20): the owner's home page designer, a
 * page of the store's management window. The blocks list -> one block ->
 * its product picker replace each other in the window, with the window's
 * one «رجوع» (lib/manageFrame.ts) - never a panel inside a panel.
 *
 * Every change goes to the DRAFT, autosaved after a short pause with the
 * version it was based on: a save from a stale screen (another tab or
 * device) is refused and the screen says so - nothing newer is overwritten.
 * «معاينة» renders the draft with the shoppers' own component. Shoppers see
 * nothing until «نشر»; «تجاهل التغييرات» returns the draft to what they see.
 */
export function StoreHomeDesigner({ vendorId }: { vendorId: string }) {
  const t = useT();
  const lang = useLang();
  const [data, setData] = useState<OwnerHome | null>(null);
  const [layout, setLayout] = useState<HomeLayout>({ blocks: [] });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [device, setDevice] = useState<"desktop" | "phone">("desktop");
  const [stack, setStack] = useState<View[]>([{ kind: "list" }]);
  const [adding, setAdding] = useState(false);
  const [uploadingType, setUploadingType] = useState<BlockType | null>(null);
  const [deleting, setDeleting] = useState<HomeBlock | null>(null);
  // «القوالب الجاهزة»: the list of templates, and the one waiting for the owner's confirmation
  const [templating, setTemplating] = useState(false);
  const [confirmTemplate, setConfirmTemplate] = useState<HomeTemplate | null>(null);
  const [applying, setApplying] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [picked, setPicked] = useState<Map<string, KnownProduct>>(new Map());
  const [framed] = useState(() => inManagementFrame());
  // «معلومات المتجر» closes the home area - the preview shows it as shoppers will
  const [storeInfo, setStoreInfo] = useState<StoreInfoDto | null>(null);
  const previewSlug = data?.slug;
  useEffect(() => {
    if (!previewSlug) return;
    let cancelled = false;
    storeHomeApi
      .info(previewSlug)
      .then((r) => {
        if (!cancelled) setStoreInfo(r);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [previewSlug]);

  const layoutRef = useRef(layout);
  const versionRef = useRef(0);
  const seq = useRef(0);
  const savedSeq = useRef(0);
  const timer = useRef<number | null>(null);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const conflictRef = useRef(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const load = useCallback(() => {
    storeHomeApi
      .get(vendorId)
      .then((r) => {
        setLoadError(null);
        setStack([{ kind: "list" }]);
        setData(r);
        setLayout(r.draft);
        layoutRef.current = r.draft;
        versionRef.current = r.draft_version;
        seq.current = 0;
        savedSeq.current = 0;
        setDirty(false);
        setConflict(false);
        conflictRef.current = false;
        setSaveError(null);
      })
      .catch((err: unknown) => setLoadError(err instanceof ApiError ? err.message : t("home.load_failed")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorId]);
  useEffect(() => {
    load();
  }, [load]);

  // what the picker has shown, then the API's own view of the chosen products (newer)
  const known = new Map<string, KnownProduct>([...picked, ...Object.entries(data?.refs.offers ?? {})]);

  /** Sends the draft now (one request at a time); true when everything is saved. */
  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (inFlight.current) await inFlight.current;
    if (conflictRef.current) return false;
    if (seq.current === savedSeq.current) return true;
    const sending = seq.current;
    const body = layoutRef.current;
    setSaving(true);
    const run = (async () => {
      try {
        const r = await storeHomeApi.save(vendorId, versionRef.current, body);
        versionRef.current = r.draft_version;
        savedSeq.current = sending;
        setData(r);
        setSaveError(null);
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.code === "STORE_HOME_VERSION_CONFLICT") {
          conflictRef.current = true;
          setConflict(true);
        } else setSaveError(err instanceof ApiError ? err.message : String(err));
        return false;
      }
    })();
    inFlight.current = run;
    const ok = await run;
    inFlight.current = null;
    setSaving(false);
    setDirty(seq.current !== savedSeq.current);
    if (ok && seq.current !== savedSeq.current) schedule();
    return ok && seq.current === savedSeq.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorId]);
  function schedule() {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), AUTOSAVE_MS);
  }
  function change(next: HomeLayout) {
    if (conflictRef.current) return;
    layoutRef.current = next;
    setLayout(next);
    seq.current += 1;
    setDirty(true);
    setSaveError(null);
    schedule();
  }
  /** The blocks change; the page's style and template stay as they are. */
  const setBlocks = (blocks: HomeBlock[]) => change({ ...layoutRef.current, blocks });
  const updateBlock = (b: HomeBlock) => setBlocks(layoutRef.current.blocks.map((x) => (x.id === b.id ? b : x)));

  // a pending change is sent even when the window closes or the page goes away
  useEffect(() => {
    const leave = () => {
      if (seq.current !== savedSeq.current && !conflictRef.current) storeHomeApi.saveOnLeave(vendorId, versionRef.current, layoutRef.current);
    };
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [vendorId]);

  const top = stack[stack.length - 1];
  const topBlock = top.kind !== "list" ? layout.blocks.find((b) => b.id === top.id) ?? null : null;
  const blockName = useCallback((b: HomeBlock) => {
    const own = b.type === "hero" ? pick(lang, b.slides[0]?.title) : b.type === "text" || b.type === "banner" || b.type === "collections" || b.type === "products" || b.type === "categories" || b.type === "auto_products" || b.type === "category_cards" ? pick(lang, b.title) : b.type === "promo_grid" ? pick(lang, b.tiles[0]?.title) : "";
    return own ? `${t(`home.type.${b.type}`)} · ${own}` : t(`home.type.${b.type}`);
  }, [lang, t]);
  const viewTitle = useCallback((v: View): string => {
    if (v.kind === "list") return t("home.title");
    const b = layoutRef.current.blocks.find((x) => x.id === v.id);
    if (v.kind === "block") return b ? blockName(b) : t("home.title");
    return v.slide === "multi" ? t("home.pick.title") : t("home.pick.one");
  }, [blockName, t]);

  const push = (v: View) => setStack((s) => [...s, v]);
  const pop = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);

  // In the management window: its header shows this screen's title and the one «رجوع».
  const depth = stack.length;
  const topKey = top.kind === "list" ? "list" : `${top.kind}:${top.id}:${top.kind === "pick" ? String(top.slide) : ""}`;
  useEffect(() => {
    if (!framed || depth < 2) return;
    return pushFrameScreen({
      title: () => viewTitle(top),
      backTitle: () => viewTitle(stack[stack.length - 2]),
      back: pop,
      close: (done) => {
        void flush().then(() => done());
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [framed, depth, topKey]);
  // each screen starts with its title focused (and announced)
  useEffect(() => {
    requestAnimationFrame(() => headingRef.current?.focus());
  }, [topKey]);

  // «معاينة» shows the saved draft: send what is pending first
  useEffect(() => {
    if (tab === "preview") void flush();
  }, [tab, flush]);

  function move(b: HomeBlock, delta: number) {
    const list = layoutRef.current.blocks;
    const from = list.indexOf(b);
    const to = from + delta;
    if (to < 0 || to >= list.length) return;
    const next = [...list];
    next.splice(from, 1);
    next.splice(to, 0, b);
    setBlocks(next);
    setStatus(fill(t("home.moved"), { name: blockName(b), n: to + 1 }));
  }
  function add(type: BlockType) {
    if (type === "hero" || type === "banner") {
      setUploadingType(type);
      uploadRef.current?.click();
      return;
    }
    const b = emptyBlock(type);
    if (!b) return;
    setBlocks([...layoutRef.current.blocks, b]);
    setAdding(false);
    push({ kind: "block", id: b.id });
  }
  async function addWithImage(file: File) {
    const type = uploadingType;
    if (!type) return;
    try {
      const up = await uploadVendorImage(vendorId, file);
      const b = emptyBlock(type, { url: up.url, width: up.width ?? null, height: up.height ?? null, bytes: file.size });
      if (!b) return;
      setBlocks([...layoutRef.current.blocks, b]);
      setAdding(false);
      push({ kind: "block", id: b.id });
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setUploadingType(null);
    }
  }
  async function doPublish() {
    if (!(await flush())) return;
    setBusy(true);
    try {
      const r = await storeHomeApi.publish(vendorId, versionRef.current);
      setData(r);
      versionRef.current = r.draft_version;
      setToast(t("home.published_toast"));
    } catch (err) {
      if (err instanceof ApiError && err.code === "STORE_HOME_VERSION_CONFLICT") {
        conflictRef.current = true;
        setConflict(true);
      } else if (err instanceof ApiError && err.code === "STORE_HOME_NOT_READY") {
        // «فحص قبل النشر» found something to fix (shown in its panel): refresh what the API sees
        setSaveError(t("home.check.blocked"));
        storeHomeApi.get(vendorId).then((r) => setData(r)).catch(() => undefined);
      } else setSaveError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  /**
   * A ready template replaces the DRAFT's blocks (the owner confirmed it when
   * the draft had any) - never what shoppers see; the page's style is kept.
   * Built from the store's real things: the picker gives its buyable products.
   */
  async function applyTemplate(template: HomeTemplate) {
    if (!data) return;
    setApplying(true);
    try {
      const page = await storeHomeApi.products(vendorId, "", 1).catch(() => null);
      const products = page?.items ?? [];
      setPicked((prev) => {
        const next = new Map(prev);
        for (const p of products) next.set(p.id, p);
        return next;
      });
      change(buildTemplate(template, { data, products }, layoutRef.current.style));
      setTemplating(false);
      setConfirmTemplate(null);
      setStatus(fill(t("home.tpl.applied"), { name: t(`home.tpl.${template}`) }));
      setToast(fill(t("home.tpl.applied"), { name: t(`home.tpl.${template}`) }));
    } finally {
      setApplying(false);
    }
  }
  function chooseTemplate(template: HomeTemplate) {
    if (layoutRef.current.blocks.length > 0) setConfirmTemplate(template);
    else void applyTemplate(template);
  }
  function setStyle(style: HomeStyle) {
    change({ ...layoutRef.current, style });
  }
  async function doDiscard() {
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (inFlight.current) await inFlight.current;
    setBusy(true);
    try {
      const r = await storeHomeApi.discard(vendorId, versionRef.current);
      setData(r);
      setLayout(r.draft);
      layoutRef.current = r.draft;
      versionRef.current = r.draft_version;
      seq.current = 0;
      savedSeq.current = 0;
      setDirty(false);
      setDiscarding(false);
      setStack([{ kind: "list" }]);
    } catch (err) {
      if (err instanceof ApiError && err.code === "STORE_HOME_VERSION_CONFLICT") {
        conflictRef.current = true;
        setConflict(true);
      } else setSaveError(err instanceof ApiError ? err.message : String(err));
      setDiscarding(false);
    } finally {
      setBusy(false);
    }
  }
  /** «معاينة كاملة»: the store page with the unpublished draft (owner only), in a new tab - nothing is published. */
  async function openFullPreview() {
    if (!data) return;
    const url = `/store/${data.slug}?home_preview=draft`;
    // open at once (the click allows a new tab), then go there once the draft is saved
    const w = window.open("about:blank", "_blank");
    await flush();
    if (w) w.location.href = url;
    else window.open(url, "_blank");
  }
  const liveRef = useRef<HTMLDivElement>(null);
  const [tight, setTight] = useState(false);
  const editingId = top.kind === "block" ? top.id : null;
  useEffect(() => {
    const root = liveRef.current;
    if (!root) return;
    root.querySelectorAll(".sh-slot.is-editing").forEach((el) => el.classList.remove("is-editing"));
    if (!editingId) return;
    const el = root.querySelector<HTMLElement>(`[data-block-id="${editingId}"]`);
    if (!el) return;
    el.classList.add("is-editing");
    el.scrollIntoView({ block: "nearest" });
  });
  // P2: the edited block's text must fit its height - if it no longer does, the height may not go lower
  useEffect(() => {
    const el = editingId ? liveRef.current?.querySelector<HTMLElement>(`[data-block-id="${editingId}"]`) : null;
    const over = !!el && [...el.querySelectorAll<HTMLElement>(".sh-hero-text, .sh-banner-text")].some((x) => x.scrollHeight > x.clientHeight + 2);
    setTight(over);
  }, [layout, device, editingId, tab, data]);
  useEffect(() => {
    if (!toast) return;
    const h = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(h);
  }, [toast]);

  if (loadError) {
    return (
      <div className="owner-catalog owner-embedded col-view shd" data-testid="home-designer">
        <ErrorBanner message={loadError} />
        {loadError.includes("not currently available") ? null : (
          <button type="button" className="button button-secondary" onClick={load}>{t("home.reload")}</button>
        )}
      </div>
    );
  }
  if (!data) return <div className="skeleton" style={{ height: 200 }} aria-busy="true" />;

  const L = data.limits;
  const images = imageCount(layout);
  const unpublished = dirty || saving || data.has_unpublished_changes;
  const stateText = saving
    ? t("home.state.saving")
    : saveError
      ? t("home.state.error")
      : dirty
        ? t("home.state.saving")
        : unpublished
          ? data.has_published || data.published_version !== null
            ? t("home.state.unpublished")
            : t("home.state.never")
          : t("home.state.published");

  const live = livePreview(layout, data, known);
  const blockingErrors = data.checks?.errors.length ?? 0;
  const tabs = (
    <div className="shd-tabs" role="tablist" aria-label={t("home.title")}>
      {(["edit", "preview"] as const).map((k) => (
        <button key={k} type="button" role="tab" aria-selected={tab === k} className={`shd-tab${tab === k ? " is-on" : ""}`} onClick={() => setTab(k)} data-testid={`home-tab-${k}`}>
          {t(`home.tab.${k}`)}
        </button>
      ))}
    </div>
  );
  const fullPreview = (
    <button type="button" className="button-link owner-secondary shd-full-preview" onClick={() => void openFullPreview()} title={t("home.full_preview_hint")} disabled={conflict} data-testid="home-full-preview">
      <IconEye /> {t("home.full_preview")}
    </button>
  );
  const livePane = (
    <aside className="shd-live" aria-label={t("home.live")}>
      <div className="shd-live-head">
        <strong className="shd-live-title">{t("home.live")}</strong>
        <div className="shd-devices" role="radiogroup" aria-label={t("home.device")}>
          {(["desktop", "phone"] as const).map((d) => (
            <button key={d} type="button" role="radio" aria-checked={device === d} className={`shd-tab${device === d ? " is-on" : ""}`} onClick={() => setDevice(d)} data-testid={`home-device-${d}`}>
              {t(`home.device.${d}`)}
            </button>
          ))}
        </div>
      </div>
      <div ref={liveRef} className={`shd-preview is-${device}`} data-sh-frame data-testid="home-preview" aria-busy={saving || dirty}>
        {/* P1: nothing inside the preview acts (a short notice says so); the Hero's and strips' arrows move it locally */}
        <PreviewGuard mode="element">
          {live.length === 0 ? (
            <p className="muted shd-preview-empty">{t("home.empty_lead")}</p>
          ) : (
            <StoreHomeBlocks blocks={live} slug={data.slug} onTarget={() => undefined} device={device} preview look={layout.style} />
          )}
          {storeInfo && <StoreInfoSection info={storeInfo} />}
          <div className="shd-preview-browse" aria-hidden="true">
            <span className="shd-preview-ghost" />
          </div>
        </PreviewGuard>
      </div>
    </aside>
  );

  const backBar = !framed && depth > 1 && (
    <div className="shd-backbar">
      <button type="button" className="wz-close wzp-back" onClick={pop} aria-label={fill(t("panel.back_to"), { title: viewTitle(stack[depth - 2]) })} data-testid="home-back">
        <IconBack />
      </button>
    </div>
  );

  // ---------------------------------------------------------- sub screens
  if (top.kind === "block" && topBlock) {
    return (
      <div className="owner-catalog owner-embedded col-view shd" data-testid="home-designer" data-view="block">
        {backBar}
        <div className="shd-block-head">
          <h1 className="page-title col-title" ref={headingRef} tabIndex={-1}>{blockName(topBlock)}</h1>
          <div className="shd-publish">
            <SaveState text={stateText} saving={saving || dirty} />
            {fullPreview}
          </div>
        </div>
        {conflict && <ConflictBanner onReload={load} />}
        {saveError && <ErrorBanner message={fill(t("home.save_failed"), { msg: saveError })} />}
        {tabs}
        <div className={`shd-work is-${tab}`}>
        <div className="shd-main">
        <HomeBlockEditor
          vendorId={vendorId}
          block={topBlock}
          data={data}
          imagesLeft={L.images - images}
          products={known}
          onChange={updateBlock}
          patch={(fn) => {
            // the block as it is in the draft now (layoutRef is updated at once by every change)
            const current = layoutRef.current.blocks.find((x) => x.id === topBlock.id);
            if (current) updateBlock(fn(current));
          }}
          onPickProducts={() => push({ kind: "pick", id: topBlock.id, slide: "multi" })}
          onPickTarget={(slide) => push({ kind: "pick", id: topBlock.id, slide })}
          tight={tight}
        />
        <div className="shd-editor-foot">
          <button type="button" className="button owner-primary" onClick={pop} data-testid="home-block-done">{t("home.done")}</button>
        </div>
        </div>
        {livePane}
        </div>
      </div>
    );
  }
  if (top.kind === "pick" && topBlock) {
    const multi = top.slide === "multi";
    // slide: a hero slide (0..), null = the banner (its first card), -2 = the double banner's second card
    const selected =
      multi && topBlock.type === "products"
        ? topBlock.offer_ids
        : (() => {
            // a promo tile: slide = -(10 + its index)
            const target = topBlock.type === "hero" && typeof top.slide === "number" ? topBlock.slides[top.slide]?.target : topBlock.type === "banner" ? (top.slide === -2 ? topBlock.second?.target : topBlock.target) : topBlock.type === "promo_grid" && typeof top.slide === "number" ? topBlock.tiles[-top.slide - 10]?.target : null;
            return target?.kind === "product" ? [target.id] : [];
          })();
    return (
      <div className="owner-catalog owner-embedded col-view shd" data-testid="home-designer" data-view="pick">
        {backBar}
        <h1 className="page-title col-title" ref={headingRef} tabIndex={-1}>{viewTitle(top)}</h1>
        <HomeProductPicker
          vendorId={vendorId}
          selected={selected}
          max={multi ? L.products : 1}
          single={!multi}
          onToggle={(p) => {
            setPicked((prev) => new Map(prev).set(p.id, p));
            if (multi && topBlock.type === "products") {
              const ids = topBlock.offer_ids.includes(p.id) ? topBlock.offer_ids.filter((x) => x !== p.id) : [...topBlock.offer_ids, p.id];
              updateBlock({ ...topBlock, offer_ids: ids });
            } else if (topBlock.type === "hero" && typeof top.slide === "number") {
              const i = top.slide;
              updateBlock({ ...topBlock, slides: topBlock.slides.map((s, j) => (j === i ? { ...s, target: { kind: "product", id: p.id } } : s)) });
            } else if (topBlock.type === "promo_grid" && typeof top.slide === "number") {
              const i = -top.slide - 10;
              updateBlock({ ...topBlock, tiles: topBlock.tiles.map((x, j) => (j === i ? { ...x, target: { kind: "product", id: p.id } } : x)) });
            } else if (topBlock.type === "banner" && top.slide === -2) {
              updateBlock({ ...topBlock, second: { ...(topBlock.second ?? EMPTY_CARD), target: { kind: "product", id: p.id } } });
            } else if (topBlock.type === "banner") {
              updateBlock({ ...topBlock, target: { kind: "product", id: p.id } });
            }
          }}
          onDone={pop}
        />
      </div>
    );
  }

  // ---------------------------------------------------------- the list
  return (
    <div className="owner-catalog owner-embedded col-view shd" data-testid="home-designer" data-view="list">
      <header className="col-head shd-head">
        <div className="col-head-text">
          <h1 className="page-title col-title" ref={headingRef} tabIndex={-1}>{t("home.title")}</h1>
          <p className="wz-lead">{t("home.lead")}</p>
        </div>
        <div className="col-head-tools shd-publish">
          <SaveState text={stateText} saving={saving || dirty} />
          {fullPreview}
          {unpublished && (data.published_version !== null || layout.blocks.length > 0) && (
            <button type="button" className="button-link wz-ghost" onClick={() => setDiscarding(true)} disabled={busy || conflict} data-testid="home-discard">
              {t("home.discard")}
            </button>
          )}
          <button type="button" className="button owner-primary" onClick={() => void doPublish()} disabled={busy || conflict || !unpublished || blockingErrors > 0} title={blockingErrors > 0 ? t("home.check.blocked") : undefined} data-testid="home-publish">
            {data.published_version !== null ? t("home.publish_n") : t("home.publish")}
          </button>
        </div>
      </header>
      {toast && <div className="notice-banner" role="status" data-testid="home-toast">{toast}</div>}
      {conflict && <ConflictBanner onReload={load} />}
      {saveError && <ErrorBanner message={fill(t("home.save_failed"), { msg: saveError })} />}
      <p className="visually-hidden" role="status" aria-live="polite">{status}</p>

      {tabs}
      <div className={`shd-work is-${tab}`}>
        <div className="shd-main">
          <PageLook
            layout={layout}
            templating={templating}
            applying={applying}
            disabled={conflict}
            onTemplates={() => setTemplating((v) => !v)}
            onTemplate={chooseTemplate}
            onStyle={setStyle}
          />
          <QualityPanel checks={data.checks} pending={saving || dirty} name={(id) => { const b = layout.blocks.find((x) => x.id === id); return b ? blockName(b) : t("home.title"); }} onOpen={(id) => { if (layout.blocks.some((x) => x.id === id)) push({ kind: "block", id }); }} />
          <div className="shd-counts">
            <span className="col-count">{fill(t("home.count"), { n: layout.blocks.length, max: L.blocks })}</span>
            <span className="col-count">{fill(t("home.images_count"), { n: images, max: L.images })}</span>
          </div>
          {layout.blocks.length === 0 && (
            <div className="col-empty">
              <strong>{t("home.empty_title")}</strong>
              <p className="muted">{t("home.empty_lead")}</p>
            </div>
          )}
          {layout.blocks.length > 0 && (
            <ol className="shd-list" aria-label={t("home.title")}>
              {layout.blocks.map((b, i) => {
                const name = blockName(b);
                const review = data.review[b.id];
                const issues = blockIssues(b, data);
                return (
                  <li key={b.id} className={`shd-card${b.visible ? "" : " is-hidden"}`} data-testid={`home-row-${i}`} data-type={b.type}>
                    <button type="button" className="shd-card-thumb" onClick={() => push({ kind: "block", id: b.id })} aria-label={fill(t("home.edit"), { name })} tabIndex={-1}>
                      <BlockThumb block={b} data={data} known={known} />
                    </button>
                    <div className="shd-card-body">
                      <strong className="shd-card-name">{name}</strong>
                      <span className="col-meta">
                        <span>{summary(b, t)}</span>
                        <span className={`col-chip ${review?.shown ? "is-on" : "is-off"}`} data-testid={`home-row-${i}-state`}>
                          {!review ? t("home.status.unsaved") : review.shown ? t("home.status.shown") : review.reason === "hidden" ? t("home.status.hidden") : t("home.status.not_shown")}
                        </span>
                      </span>
                      {review && !review.shown && review.reason !== "hidden" && (
                        <span className="col-note is-warn" data-testid={`home-row-${i}-note`}>
                          {review.reason === "retired" ? t("home.status.retired") : review.reason === "no_image" ? t("home.status.no_image") : review.reason === "incomplete" ? t("home.status.incomplete") : b.type === "text" ? t("home.status.too_few_text") : fill(t("home.status.too_few"), { min: data.min_shown_items })}
                        </span>
                      )}
                      {issues > 0 && <span className="col-note is-warn">{fill(t("home.status.warnings"), { n: issues })}</span>}
                    </div>
                    <div className="shd-card-actions">
                      <span className="col-arrows">
                        <button type="button" className="col-icon-btn" onClick={() => move(b, -1)} disabled={i === 0} aria-label={fill(t("home.move_up"), { name })} title={fill(t("home.move_up"), { name })} data-testid={`home-row-${i}-up`}>
                          <IconArrowUp />
                        </button>
                        <button type="button" className="col-icon-btn" onClick={() => move(b, 1)} disabled={i === layout.blocks.length - 1} aria-label={fill(t("home.move_down"), { name })} title={fill(t("home.move_down"), { name })} data-testid={`home-row-${i}-down`}>
                          <IconArrowDown />
                        </button>
                      </span>
                      <button type="button" className="button-link owner-secondary" onClick={() => push({ kind: "block", id: b.id })} aria-label={fill(t("home.edit"), { name })} data-testid={`home-row-${i}-edit`}>
                        <IconEdit /> <span className="col-label">{t("col.edit")}</span>
                      </button>
                      <button type="button" className="button-link wz-ghost" onClick={() => updateBlock({ ...b, visible: !b.visible })} aria-label={fill(b.visible ? t("home.hide") : t("home.show"), { name })} aria-pressed={!b.visible} data-testid={`home-row-${i}-toggle`}>
                        <IconEye /> <span className="col-label">{b.visible ? t("col.hide") : t("col.show")}</span>
                      </button>
                      <button type="button" className="button-link wz-ghost" onClick={() => setDeleting(b)} aria-label={fill(t("home.delete"), { name })} data-testid={`home-row-${i}-delete`}>
                        <IconTrash /> <span className="col-label">{t("col.delete")}</span>
                      </button>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}

          <input ref={uploadRef} type="file" accept={IMAGE_UPLOAD_ACCEPT} hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void addWithImage(f); else setUploadingType(null); }} data-testid="home-add-image-input" />
          {layout.blocks.length >= L.blocks ? (
            <p className="wz-hint">{t("home.limit_blocks")}</p>
          ) : adding ? (
            <section className="shd-add" aria-labelledby="shd-add-title">
              <h2 id="shd-add-title" className="shd-sub-title">{t("home.add_title")}</h2>
              <ul className="shd-types">
                {BLOCK_TYPES.map((type) => {
                  const needsImage = type === "hero" || type === "banner";
                  // one Hero per page (its slides are the way to show more)
                  const heroTaken = type === "hero" && layout.blocks.some((x) => x.type === "hero");
                  const disabled = (needsImage && images >= L.images) || uploadingType !== null || heroTaken;
                  return (
                    <li key={type}>
                      <button type="button" className="shd-type" onClick={() => add(type)} disabled={disabled} data-testid={`home-add-${type}`}>
                        <AddThumb type={type} />
                        <span className="shd-type-text">
                          <strong>{t(`home.type.${type}`)}</strong>
                          <span className="muted">{uploadingType === type ? t("home.f.uploading") : heroTaken ? t("home.hero_taken") : t(`home.type.${type}.desc`)}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
                {/* «مقطع مميّز»: a look only, until the real video package - never added, saved or published */}
                <li>
                  <div className="shd-type is-soon" aria-disabled="true" data-testid="home-add-soon">
                    <SoonPreview />
                    <span className="shd-type-text">
                      <strong>{t("home.soon.title")}</strong>
                      <span className="muted">{t("home.soon.desc")}</span>
                      <span className="shd-soon-badge">{t("home.soon.badge")}</span>
                    </span>
                  </div>
                </li>
              </ul>
              {images >= L.images && <p className="wz-hint">{t("home.limit_images")}</p>}
              <button type="button" className="button-link wz-ghost" onClick={() => setAdding(false)}>{t("home.cancel")}</button>
            </section>
          ) : (
            <button type="button" className="button owner-primary shd-add-btn" onClick={() => setAdding(true)} disabled={conflict} data-testid="home-add">
              <IconPlus /> {t("home.add")}
            </button>
          )}
        </div>
        {livePane}
      </div>

      {deleting && (
        <SmallConfirm
          title={fill(t("home.delete_title"), { name: blockName(deleting) })}
          lead={t("home.delete_lead")}
          confirmLabel={t("home.delete_confirm")}
          cancelLabel={t("home.cancel")}
          onConfirm={() => {
            setBlocks(layoutRef.current.blocks.filter((x) => x.id !== deleting.id));
            setDeleting(null);
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
      {confirmTemplate && (
        <SmallConfirm
          title={fill(t("home.tpl.confirm_title"), { name: t(`home.tpl.${confirmTemplate}`) })}
          lead={fill(t("home.tpl.confirm_lead"), { n: layout.blocks.length })}
          confirmLabel={t("home.tpl.confirm")}
          cancelLabel={t("home.cancel")}
          busy={applying}
          onConfirm={() => void applyTemplate(confirmTemplate)}
          onCancel={() => setConfirmTemplate(null)}
        />
      )}
      {discarding && (
        <SmallConfirm
          title={t("home.discard_title")}
          lead={data.published_version !== null ? t("home.discard_lead") : t("home.discard_lead_none")}
          confirmLabel={t("home.discard_confirm")}
          cancelLabel={t("home.cancel")}
          busy={busy}
          onConfirm={() => void doDiscard()}
          onCancel={() => setDiscarding(false)}
        />
      )}
    </div>
  );
}

function summary(b: HomeBlock, t: (k: string) => string): string {
  switch (b.type) {
    case "hero":
      return b.slides.length === 1 ? t("home.sum.slide") : fill(t("home.sum.slides"), { n: b.slides.length });
    case "banner":
      return t("home.type.banner");
    case "collections":
      return fill(t("home.sum.items"), { n: b.collection_ids.length });
    case "products":
      return fill(t("home.sum.items"), { n: b.offer_ids.length });
    case "categories":
      return fill(t("home.sum.items"), { n: b.items.length });
    case "auto_products":
      return fill(t(b.source === "new" ? "home.sum.auto_new" : "home.sum.auto_sale"), { n: b.count });
    case "text":
      return b.style === "divider" ? t("home.sum.divider") : t("home.type.text");
    case "category_cards":
      return fill(t("home.sum.cards"), { n: b.items.length });
    case "promo_grid":
      return fill(t("home.sum.tiles"), { n: b.tiles.length });
  }
}

/** Chosen things shoppers do not see now (unpublished, sold out, deleted, hidden, no image). */
function blockIssues(b: HomeBlock, data: OwnerHome): number {
  const bad = (s: string | undefined) => (s && s !== "ok" ? 1 : 0);
  switch (b.type) {
    case "products":
      return b.offer_ids.reduce((n, id) => n + bad(data.refs.offers[id]?.status), 0);
    case "collections":
      return b.collection_ids.reduce((n, id) => n + bad(data.refs.collections[id]?.status), 0);
    case "categories":
      return b.items.reduce((n, x) => n + bad(data.refs.categories[`${x.audience}/${x.category}`]?.status), 0);
    case "hero":
      return b.slides.reduce((n, s) => n + (s.image ? bad(data.refs.images[s.image.url]) : 0) + (s.image_mobile ? bad(data.refs.images[s.image_mobile.url]) : 0), 0);
    case "banner":
      return (b.second ? [b, b.second] : [b]).reduce((n, c) => n + (c.image ? bad(data.refs.images[c.image.url]) : 0) + (c.image_mobile ? bad(data.refs.images[c.image_mobile.url]) : 0), 0);
    default:
      return 0;
  }
}

/**
 * «القالب والستايل»: the page's ready templates (a structure; it replaces the
 * draft after a confirmation) and its style (the look; ready tokens only).
 * The two are independent: changing one never changes the other.
 */
function PageLook({
  layout,
  templating,
  applying,
  disabled,
  onTemplates,
  onTemplate,
  onStyle,
}: {
  layout: HomeLayout;
  templating: boolean;
  applying: boolean;
  disabled: boolean;
  onTemplates: () => void;
  onTemplate: (t: HomeTemplate) => void;
  onStyle: (s: HomeStyle) => void;
}) {
  const t = useT();
  const style = layout.style ?? "default";
  return (
    <section className="shd-look" aria-labelledby="shd-look-title" data-testid="home-look">
      <div className="shd-look-head">
        <h2 id="shd-look-title" className="shd-sub-title">{t("home.look.title")}</h2>
        <button type="button" className="button-link owner-secondary" onClick={onTemplates} aria-expanded={templating} disabled={disabled} data-testid="home-templates">
          {t("home.tpl.open")}
        </button>
      </div>
      {templating && (
        <div className="shd-templates" data-testid="home-template-list">
          <p className="shd-hint">{t("home.tpl.lead")}</p>
          <ul className="shd-types shd-template-cards">
            {HOME_TEMPLATES.map((tpl) => (
              <li key={tpl}>
                <button type="button" className={`shd-type shd-template${layout.template === tpl ? " is-current" : ""}`} onClick={() => onTemplate(tpl)} disabled={applying || disabled} data-testid={`home-template-${tpl}`}>
                  <span className={`shd-tpl-draw is-${tpl}`} aria-hidden="true">
                    {TEMPLATE_OUTLINE[tpl].map((part, i) => <i key={i} className={`is-${part}`} />)}
                  </span>
                  <span className="shd-type-text">
                    <strong>{t(`home.tpl.${tpl}`)}</strong>
                    <span className="muted">{t(`home.tpl.${tpl}.desc`)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="shd-styles" role="radiogroup" aria-label={t("home.style.title")} data-testid="home-styles">
        <span className="shd-sub">{t("home.style.title")}</span>
        <span className="shd-style-list">
          {HOME_STYLES.map((s) => (
            <label key={s} className={`shd-style${style === s ? " is-on" : ""}`}>
              <input type="radio" name="home-style" checked={style === s} onChange={() => onStyle(s)} disabled={disabled} data-testid={`home-style-${s}`} />
              <span className={`shd-style-swatch is-${s}`} aria-hidden="true"><i /><i /><i /></span>
              <span className="shd-style-name">{t(`home.style.${s}`)}</span>
            </label>
          ))}
        </span>
        <p className="shd-hint">{t(`home.style.${style}.desc`)}</p>
      </div>
    </section>
  );
}

/**
 * «فحص قبل النشر»: what the API found in the saved draft. Errors (an
 * unfinished visible block, a destination that no longer exists, a second
 * Hero) stop «نشر»; warnings are advice and never do. Changes nothing.
 */
function QualityPanel({ checks, pending, name, onOpen }: { checks: OwnerHome["checks"]; pending: boolean; name: (id: string) => string; onOpen: (id: string) => void }) {
  const t = useT();
  if (!checks) return null;
  const { errors, warnings } = checks;
  const where = (i: QualityIssue) =>
    [name(i.block_id), i.slide !== undefined ? fill(t("home.f.slide_n"), { n: i.slide + 1 }) : null, i.card !== undefined ? fill(t("home.f.card_n"), { n: i.card }) : null, i.image === "phone" ? t("home.check.phone_image") : null]
      .filter(Boolean)
      .join(" · ");
  const row = (i: QualityIssue, k: number, kind: "error" | "warning") => (
    <li key={`${kind}-${k}`} className={`shd-check-item is-${kind}`} data-testid={`home-check-${kind}`} data-code={i.code}>
      <span className="shd-check-text">
        <strong>{t(`home.check.${i.code}`)}</strong>
        <span className="muted">{where(i)}</span>
      </span>
      <button type="button" className="button-link owner-secondary" onClick={() => onOpen(i.block_id)}>{t("home.check.fix")}</button>
    </li>
  );
  const ok = errors.length === 0 && warnings.length === 0;
  return (
    <section className={`shd-checks${errors.length ? " has-errors" : ""}`} aria-labelledby="shd-checks-title" data-testid="home-checks">
      <div className="shd-checks-head">
        <h2 id="shd-checks-title" className="shd-sub-title">{t("home.check.title")}</h2>
        <span className={`col-chip ${errors.length ? "is-off" : "is-on"}`} data-testid="home-checks-summary">
          {ok ? t("home.check.ok") : fill(t("home.check.summary"), { e: errors.length, w: warnings.length })}
        </span>
      </div>
      {pending && <p className="shd-hint" role="status">{t("home.check.pending")}</p>}
      {errors.length > 0 && (
        <>
          <p className="col-note is-warn">{t("home.check.errors_lead")}</p>
          <ul className="shd-check-list">{errors.map((i, k) => row(i, k, "error"))}</ul>
        </>
      )}
      {warnings.length > 0 && (
        <details className="shd-check-warnings" open={errors.length === 0}>
          <summary>{fill(t("home.check.warnings"), { n: warnings.length })}</summary>
          <ul className="shd-check-list">{warnings.map((i, k) => row(i, k, "warning"))}</ul>
        </details>
      )}
    </section>
  );
}

function SaveState({ text, saving }: { text: string; saving: boolean }) {
  return (
    <span className={`shd-state${saving ? " is-saving" : ""}`} role="status" aria-live="polite" data-testid="home-save-state">
      {text}
    </span>
  );
}

function ConflictBanner({ onReload }: { onReload: () => void }) {
  const t = useT();
  return (
    <div className="warning-banner shd-conflict" role="alert" data-testid="home-conflict">
      <span>{t("home.conflict")}</span>
      <button type="button" className="button button-secondary" onClick={onReload}>{t("home.reload")}</button>
    </div>
  );
}
