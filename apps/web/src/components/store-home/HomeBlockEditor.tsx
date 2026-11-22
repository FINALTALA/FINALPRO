"use client";

import { createContext, useContext, useId, useLayoutEffect, useRef, useState } from "react";
import { IconArrowDown, IconArrowUp, IconImage, IconPlus, IconTrash } from "@/components/product-wizard/wizardIcons";
import { ApiError, IMAGE_UPLOAD_ACCEPT, uploadVendorImage } from "@/lib/api";
import { fill } from "@/lib/offerWizardText";
import {
  type BannerCard,
  BLOCK_VARIANTS,
  CARD_SHAPES,
  type CategoryCard,
  EMPTY_TILE,
  PROMO_DIVIDERS,
  PROMO_LAYOUTS,
  PROMO_SHARES,
  type PromoTile,
  promoLayoutFor,
  type BlockDisplay,
  DISPLAY_KEYS,
  EMPTY_CARD,
  FOCUS_POINTS,
  type FocusPoint,
  DISPLAY_VALUES,
  type DisplayKey,
  FINE_KEYS,
  FINE_STEPS,
  type FineKey,
  PER_VIEW,
  PRESET_SPACE,
  displayOf,
  type HeroSlide,
  type HomeBlock,
  type HomeImage,
  type HomeTarget,
  IMAGE_SPECS,
  type LocalText,
  NO_TEXT,
  type OwnerHome,
  imageWarnings,
} from "@/lib/storeHome";
import "@/lib/storeHomeText";
import { useLang, useT } from "@/lib/useLang";

/**
 * An upload ends later: its image is applied to the block AS IT IS IN THE
 * DRAFT AT THAT MOMENT (the designer's own, synchronous copy) - never to the
 * copy of the last render, which another upload or what was typed meanwhile
 * may already have changed (two uploads ending together lost one image).
 */
const PatchCtx = createContext<(fn: (b: HomeBlock) => HomeBlock) => void>(() => undefined);

/** What the owner's screens know of a product (picker results, the API's refs). */
export type KnownProduct = { title_ar: string | null; title_en: string | null; image_url: string | null; status: string };

/** Moves item `from` by `delta` (a copy). */
function moved<T>(list: T[], from: number, delta: number): T[] {
  const to = from + delta;
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x);
  return next;
}

/**
 * One block's settings (inside the management window: it replaces the list,
 * one «رجوع»). Every change goes straight to the draft (autosaved by the
 * designer). Images are uploaded to the store's own uploads; destinations
 * are chosen from the store's own things - never typed.
 */
export function HomeBlockEditor({
  vendorId,
  block,
  data,
  imagesLeft,
  products,
  onChange,
  onPickProducts,
  onPickTarget,
  tight = false,
  patch,
}: {
  vendorId: string;
  /** changes the block as it is in the draft now (uploads) */
  patch: (fn: (b: HomeBlock) => HomeBlock) => void;
  /** P2: the live preview shows this block's text no longer fits - its height may not go lower */
  tight?: boolean;
  block: HomeBlock;
  data: OwnerHome;
  /** images that can still be added to the page */
  imagesLeft: number;
  /** what the owner's screens know of products (picker results, the API's refs) */
  products: Map<string, KnownProduct>;
  onChange: (next: HomeBlock) => void;
  onPickProducts: () => void;
  /** choose a product destination for the slide `slide` (null: the banner) */
  onPickTarget: (slide: number | null) => void;
}) {
  const t = useT();
  const L = data.text_limits;
  const min = data.min_shown_items;
  const review = data.review[block.id];
  return (
    <PatchCtx.Provider value={patch}>
    <div className="shd-editor" data-testid="home-block-editor" data-type={block.type}>
      <p className="wz-lead">{t(`home.type.${block.type}.desc`)}</p>
      {review && !review.shown && review.reason !== "hidden" && (
        <p className="col-note is-warn" role="status" data-testid="home-block-note">
          {review.reason === "retired" ? t("home.status.retired") : review.reason === "no_image" ? t("home.status.no_image") : block.type === "text" ? t("home.status.too_few_text") : fill(t("home.status.too_few"), { min })}
        </p>
      )}
      {(block.type === "hero" || block.type === "banner" || block.type === "products" || block.type === "auto_products") && (
        <VariantField block={block} onChange={(variant) => onChange({ ...block, variant } as HomeBlock)} />
      )}
      <DisplayField block={block} keys={data.display?.keys ?? DISPLAY_KEYS} onChange={(display) => onChange({ ...block, display } as HomeBlock)} />
      <FineField block={block} keys={data.display?.fine_keys ?? FINE_KEYS} tight={tight} onChange={(display) => onChange({ ...block, display } as HomeBlock)} />
      {block.type === "hero" && (
        <HeroEditor vendorId={vendorId} block={block} data={data} imagesLeft={imagesLeft} products={products} onChange={onChange} onPickTarget={onPickTarget} />
      )}
      {block.type === "banner" && (() => {
        const double = block.variant === "double";
        const spec = double ? IMAGE_SPECS.banner_double : IMAGE_SPECS.banner;
        const second = block.second ?? EMPTY_CARD;
        const cardFields = (card: BannerCard, set: (c: BannerCard) => void, n: 1 | 2) => (
          <CardFields vendorId={vendorId} card={card} which={n} spec={spec} data={data} imagesLeft={imagesLeft} products={products} onChange={set} onPickProduct={() => onPickTarget(n === 1 ? null : -2)} testid={n === 1 ? "banner" : "banner2"} required={double} />
        );
        const first: BannerCard = { image: block.image, image_mobile: block.image_mobile, title: block.title, text: block.text, target: block.target, alt: block.alt, focus: block.focus };
        return double ? (
          <>
            <fieldset className="shd-slide" data-testid="banner-card-1">
              <legend className="shd-slide-head"><span>{fill(t("home.f.card_n"), { n: 1 })}</span></legend>
              {cardFields(first, (c) => onChange({ ...block, ...c }), 1)}
            </fieldset>
            <fieldset className="shd-slide" data-testid="banner-card-2">
              <legend className="shd-slide-head"><span>{fill(t("home.f.card_n"), { n: 2 })}</span></legend>
              {cardFields(second, (c) => onChange({ ...block, second: c }), 2)}
            </fieldset>
            <p className="shd-hint">{t("home.f.card_rule")}</p>
          </>
        ) : (
          cardFields(first, (c) => onChange({ ...block, ...c }), 1)
        );
      })()}
      {block.type === "collections" && (
        <>
          <TextField label={t("home.f.section_title")} hint={t("home.f.section_title_hint")} value={block.title} max={L.title} onChange={(v) => onChange({ ...block, title: v })} />
          <ChooseList
            chosen={block.collection_ids}
            max={data.limits.collections}
            min={min}
            options={data.options.collections.map((c) => ({ key: c.id, label: c.name_ar, labelEn: c.name_en, meta: fill(t("home.f.n_available"), { n: c.count }) }))}
            status={(id) => data.refs.collections[id]?.status ?? (data.options.collections.find((c) => c.id === id) ? "ok" : "missing")}
            nameOf={(id) => data.options.collections.find((c) => c.id === id)?.name_ar ?? data.refs.collections[id]?.name_ar ?? "—"}
            empty={t("home.f.no_collections")}
            onChange={(ids) => onChange({ ...block, collection_ids: ids })}
            testid="collections"
          />
        </>
      )}
      {block.type === "categories" && review?.reason !== "retired" && (
        <>
          <TextField label={t("home.f.section_title")} hint={t("home.f.section_title_hint")} value={block.title} max={L.title} onChange={(v) => onChange({ ...block, title: v })} />
          <ChooseList
            chosen={block.items.map((x) => `${x.audience}/${x.category}`)}
            max={data.limits.categories}
            min={min}
            options={data.options.categories.map((c) => ({ key: `${c.audience}/${c.category}`, label: `${c.name_ar} · ${c.audience_ar}`, labelEn: `${c.name_en} · ${c.audience_en}`, meta: fill(t("home.f.n_available"), { n: c.count }) }))}
            status={(key) => data.refs.categories[key]?.status ?? (data.options.categories.some((c) => `${c.audience}/${c.category}` === key) ? "ok" : "empty")}
            nameOf={(key) => {
              const c = data.options.categories.find((x) => `${x.audience}/${x.category}` === key) ?? data.refs.categories[key];
              return c ? `${c.name_ar} · ${c.audience_ar}` : key;
            }}
            empty={t("home.f.no_categories")}
            onChange={(keys) => onChange({ ...block, items: keys.map((k) => ({ audience: k.split("/")[0], category: k.split("/")[1] })) })}
            testid="categories"
          />
        </>
      )}
      {block.type === "products" && (
        <>
          <TextField label={t("home.f.section_title")} hint={t("home.f.section_title_hint")} value={block.title} max={L.title} onChange={(v) => onChange({ ...block, title: v })} />
          {block.variant === "side" && <TextField label={t("home.f.side_text")} hint={t("home.f.side_text_hint")} value={block.text ?? NO_TEXT} max={L.sideText ?? 140} onChange={(v) => onChange({ ...block, text: v })} testid="side-text" />}
          <ChosenProducts ids={block.offer_ids} max={data.limits.products} min={min} products={products} onChange={(ids) => onChange({ ...block, offer_ids: ids })} onPick={onPickProducts} />
        </>
      )}
      {block.type === "auto_products" && (
        <>
          <fieldset className="shd-field">
            <legend>{t("home.f.source")}</legend>
            {(["new", "sale"] as const).map((src) => (
              <label key={src} className="shd-radio">
                <input type="radio" name={`src-${block.id}`} checked={block.source === src} onChange={() => onChange({ ...block, source: src })} />
                <span>{t(`home.f.source.${src}`)}</span>
                <span className="muted">{fill(t("home.f.source_count"), { n: src === "new" ? data.options.new_count : data.options.sale_count })}</span>
              </label>
            ))}
          </fieldset>
          <label className="shd-field">
            <span className="shd-label">{t("home.f.count")}</span>
            <select value={block.count} onChange={(e) => onChange({ ...block, count: Number(e.target.value) })} data-testid="auto-count">
              {Array.from({ length: data.limits.autoMax - data.limits.autoMin + 1 }, (_, i) => data.limits.autoMin + i).map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
          <TextField label={t("home.f.section_title")} hint={t("home.f.section_title_hint")} value={block.title} max={L.title} onChange={(v) => onChange({ ...block, title: v })} />
          {block.variant === "side" && <TextField label={t("home.f.side_text")} hint={t("home.f.side_text_hint")} value={block.text ?? NO_TEXT} max={L.sideText ?? 140} onChange={(v) => onChange({ ...block, text: v })} testid="side-text" />}
        </>
      )}
      {block.type === "promo_grid" && (
        <PromoGridEditor vendorId={vendorId} block={block} data={data} imagesLeft={imagesLeft} products={products} onChange={onChange} onPickTarget={onPickTarget} />
      )}
      {block.type === "category_cards" && (
        <CategoryCardsEditor vendorId={vendorId} block={block} data={data} imagesLeft={imagesLeft} onChange={onChange} />
      )}
      {block.type === "text" && (
        <>
          <fieldset className="shd-field">
            <legend>{t("home.f.style")}</legend>
            {(["text", "divider"] as const).map((st) => (
              <label key={st} className="shd-radio">
                <input type="radio" name={`style-${block.id}`} checked={block.style === st} onChange={() => onChange({ ...block, style: st })} />
                <span>{t(`home.f.style.${st}`)}</span>
              </label>
            ))}
          </fieldset>
          <TextField label={t("home.f.title")} value={block.title} max={L.title} onChange={(v) => onChange({ ...block, title: v })} testid="text-title" />
          {block.style === "text" && <TextField label={t("home.f.text")} value={block.text} max={L.body} multiline onChange={(v) => onChange({ ...block, text: v })} testid="text-body" />}
        </>
      )}
    </div>
    </PatchCtx.Provider>
  );
}

function HeroEditor({
  vendorId,
  block,
  data,
  imagesLeft,
  products,
  onChange,
  onPickTarget,
}: {
  vendorId: string;
  block: Extract<HomeBlock, { type: "hero" }>;
  data: OwnerHome;
  imagesLeft: number;
  products: Map<string, KnownProduct>;
  onChange: (b: HomeBlock) => void;
  onPickTarget: (slide: number | null) => void;
}) {
  const t = useT();
  const L = data.text_limits;
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const addRef = useRef<HTMLInputElement>(null);
  const patch = useContext(PatchCtx);
  const setSlide = (i: number, s: HeroSlide) => onChange({ ...block, slides: block.slides.map((x, j) => (j === i ? s : x)) });
  /** an upload's image, on the slide as it is in the draft now */
  const patchSlide = (i: number, part: Partial<HeroSlide>) => patch((b) => (b.type === "hero" ? { ...b, slides: b.slides.map((x, j) => (j === i ? { ...x, ...part } : x)) } : b));
  const spec = block.variant === "split" ? IMAGE_SPECS.hero_split : IMAGE_SPECS.hero;
  async function addSlide(file: File) {
    setAdding(true);
    setAddError(null);
    try {
      const up = await uploadVendorImage(vendorId, file);
      const image: HomeImage = { url: up.url, width: up.width ?? null, height: up.height ?? null, bytes: file.size };
      patch((b) => (b.type === "hero" ? { ...b, slides: [...b.slides, { image, image_mobile: null, title: NO_TEXT, text: NO_TEXT, button: NO_TEXT, target: null, align: "start", alt: NO_TEXT, focus: "center" }] } : b));
    } catch (err) {
      setAddError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }
  return (
    <div className="shd-slides">
      {block.slides.map((s, i) => (
        <fieldset key={i} className="shd-slide" data-testid={`hero-slide-${i}`}>
          <legend className="shd-slide-head">
            <span>{fill(t("home.f.slide_n"), { n: i + 1 })}</span>
          </legend>
          {block.slides.length > 1 && (
            <div className="shd-slide-tools">
              <button type="button" className="col-icon-btn" onClick={() => onChange({ ...block, slides: moved(block.slides, i, -1) })} disabled={i === 0} aria-label={fill(t("home.move_up"), { name: fill(t("home.f.slide_n"), { n: i + 1 }) })}>
                <IconArrowUp />
              </button>
              <button type="button" className="col-icon-btn" onClick={() => onChange({ ...block, slides: moved(block.slides, i, 1) })} disabled={i === block.slides.length - 1} aria-label={fill(t("home.move_down"), { name: fill(t("home.f.slide_n"), { n: i + 1 }) })}>
                <IconArrowDown />
              </button>
              <button type="button" className="col-icon-btn" onClick={() => onChange({ ...block, slides: block.slides.filter((_, j) => j !== i) })} aria-label={fill(t("home.f.remove_slide"), { n: i + 1 })}>
                <IconTrash />
              </button>
            </div>
          )}
          <ImageField vendorId={vendorId} label={t("home.f.image_desktop")} spec={spec.desktop} value={s.image} data={data} canAdd={!!s.image || imagesLeft > 0} onChange={(img) => img && patchSlide(i, { image: img })} testid={`hero-image-${i}`} />
          <ImageField vendorId={vendorId} label={t("home.f.image_phone")} spec={spec.phone} value={s.image_mobile} data={data} canAdd={imagesLeft > 0} onChange={(img) => patchSlide(i, { image_mobile: img })} removable testid={`hero-image-phone-${i}`} />
          <FocusField value={s.focus} image={s.image_mobile?.url ?? s.image?.url ?? null} onChange={(focus) => setSlide(i, { ...s, focus })} testid={`hero-focus-${i}`} />
          <TextField label={t("home.f.title")} value={s.title} max={L.title} onChange={(v) => setSlide(i, { ...s, title: v })} testid={`hero-title-${i}`} />
          <TextField label={t("home.f.text")} value={s.text} max={L.heroText} onChange={(v) => setSlide(i, { ...s, text: v })} />
          <TextField label={t("home.f.button")} hint={t("home.f.button_hint")} value={s.button} max={L.button} onChange={(v) => setSlide(i, { ...s, button: v })} testid={`hero-button-${i}`} />
          <TargetField value={s.target} data={data} products={products} onChange={(v) => setSlide(i, { ...s, target: v })} onPickProduct={() => onPickTarget(i)} testid={`hero-target-${i}`} />
          <fieldset className="shd-field shd-inline">
            <legend>{t("home.f.align")}</legend>
            {(["start", "center", "end"] as const).map((a) => (
              <label key={a} className="shd-radio">
                <input type="radio" name={`align-${block.id}-${i}`} checked={s.align === a} onChange={() => setSlide(i, { ...s, align: a })} />
                <span>{t(`home.f.align.${a}`)}</span>
              </label>
            ))}
          </fieldset>
          <TextField label={t("home.f.alt")} hint={t("home.f.alt_hint")} value={s.alt} max={L.alt} onChange={(v) => setSlide(i, { ...s, alt: v })} />
        </fieldset>
      ))}
      {block.slides.length < data.limits.heroSlides && (
        <div className="shd-add-slide">
          <input ref={addRef} type="file" accept={IMAGE_UPLOAD_ACCEPT} hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void addSlide(f); }} data-testid="hero-add-slide-input" />
          <button type="button" className="button-link owner-secondary" onClick={() => addRef.current?.click()} disabled={adding || imagesLeft <= 0} data-testid="hero-add-slide">
            <IconPlus /> {adding ? t("home.f.uploading") : t("home.f.add_slide")}
          </button>
          {addError && <p className="col-note is-warn" role="alert">{addError}</p>}
        </div>
      )}
    </div>
  );
}

function TextField({
  label,
  hint,
  value,
  max,
  multiline = false,
  onChange,
  testid,
}: {
  label: string;
  hint?: string;
  value: LocalText;
  max: number;
  multiline?: boolean;
  onChange: (v: LocalText) => void;
  testid?: string;
}) {
  const t = useT();
  const id = useId();
  return (
    <fieldset className="shd-field shd-text-field">
      <legend className="shd-label">{label}</legend>
      {hint && <p className="shd-hint" id={`${id}-hint`}>{hint}</p>}
      <div className="shd-text-pair">
        {(["ar", "en"] as const).map((lang) => (
          <label key={lang} className="shd-text-lang">
            <span className="shd-sub">{t(`home.f.${lang}`)}</span>
            {multiline ? (
              <textarea
                dir={lang === "ar" ? "rtl" : "ltr"}
                lang={lang}
                value={value[lang]}
                maxLength={max}
                rows={4}
                aria-describedby={hint ? `${id}-hint` : undefined}
                onChange={(e) => onChange({ ...value, [lang]: e.target.value })}
                data-testid={testid ? `${testid}-${lang}` : undefined}
              />
            ) : (
              <input
                dir={lang === "ar" ? "rtl" : "ltr"}
                lang={lang}
                value={value[lang]}
                maxLength={max}
                aria-describedby={hint ? `${id}-hint` : undefined}
                onChange={(e) => onChange({ ...value, [lang]: e.target.value })}
                data-testid={testid ? `${testid}-${lang}` : undefined}
              />
            )}
            <span className="shd-count" aria-hidden="true">{[...value[lang]].length} / {max}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function ImageField({
  vendorId,
  label,
  spec,
  value,
  data,
  canAdd,
  removable = false,
  onChange,
  testid,
  noRatio = false,
}: {
  vendorId: string;
  label: string;
  spec: { w: number; h: number; minW: number };
  value: HomeImage | null;
  data: OwnerHome;
  canAdd: boolean;
  removable?: boolean;
  onChange: (img: HomeImage | null) => void;
  testid: string;
  /** a place whose shape changes with the layout: no ratio warning */
  noRatio?: boolean;
}) {
  const t = useT();
  const ref = useRef<HTMLInputElement>(null);
  // the upload's answer goes to the newest onChange (what was typed meanwhile is kept)
  const onChangeRef = useRef(onChange);
  useLayoutEffect(() => {
    onChangeRef.current = onChange;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const up = await uploadVendorImage(vendorId, file);
      onChangeRef.current({ url: up.url, width: up.width ?? null, height: up.height ?? null, bytes: file.size });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  const warnings = value ? imageWarnings(value, spec).filter((w) => !(noRatio && w === "ratio")) : [];
  const missing = value && data.refs.images[value.url] === "missing";
  return (
    <div className="shd-field shd-image-field" data-testid={testid}>
      <span className="shd-label">{label}</span>
      <span className="shd-hint">{fill(t("home.f.image_spec"), { w: spec.w, h: spec.h })}</span>
      <div className="shd-image-row">
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={value.url} alt="" className="shd-thumb" style={{ aspectRatio: `${spec.w} / ${spec.h}` }} />
        ) : removable ? (
          <span className="shd-thumb shd-thumb-empty" style={{ aspectRatio: `${spec.w} / ${spec.h}` }} aria-hidden="true"><IconImage /></span>
        ) : (
          // an image place a template left: clearly empty, never shown to shoppers
          <span className="shd-thumb shd-thumb-empty is-needed" style={{ aspectRatio: `${spec.w} / ${spec.h}` }} data-testid={`${testid}-needed`}>
            <IconImage /> <span>{t("home.f.add_image")}</span>
          </span>
        )}
        <div className="shd-image-actions">
          <input ref={ref} type="file" accept={IMAGE_UPLOAD_ACCEPT} hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} data-testid={`${testid}-input`} />
          <button type="button" className="button-link owner-secondary" onClick={() => ref.current?.click()} disabled={busy || (!value && !canAdd)}>
            {busy ? t("home.f.uploading") : value ? t("home.f.replace") : t("home.f.upload")}
          </button>
          {removable && value && (
            <button type="button" className="button-link wz-ghost" onClick={() => onChange(null)}>
              <IconTrash /> {t("home.f.remove_image")}
            </button>
          )}
        </div>
      </div>
      {removable && !value && <p className="shd-hint">{t("home.f.no_phone")}</p>}
      {missing && <p className="col-note is-warn">{t("home.warn.missing")}</p>}
      {warnings.length > 0 && (
        <ul className="shd-warnings" data-testid={`${testid}-warnings`}>
          {warnings.map((w) => <li key={w}>{t(`home.warn.${w}`)}</li>)}
        </ul>
      )}
      {error && <p className="col-note is-warn" role="alert">{error}</p>}
    </div>
  );
}

/** A promo tile's shape doesn't follow one ratio (the layout decides it): size and weight warnings only. */
const TILE_SPEC = { w: 1200, h: 900, minW: 600 };

/**
 * «لوحة ترويجية» (P3): the layout (ready ones for the number of tiles), the
 * wide tile's part, how the tiles meet, then 2-4 tiles - each one its image,
 * an Arabic title (English optional), a description, and a button with its
 * internal destination together or neither. Never free sizes or links.
 */
function PromoGridEditor({
  vendorId,
  block,
  data,
  imagesLeft,
  products,
  onChange,
  onPickTarget,
}: {
  vendorId: string;
  block: Extract<HomeBlock, { type: "promo_grid" }>;
  data: OwnerHome;
  imagesLeft: number;
  products: Map<string, KnownProduct>;
  onChange: (b: HomeBlock) => void;
  onPickTarget: (slide: number | null) => void;
}) {
  const t = useT();
  const patch = useContext(PatchCtx);
  const L = data.text_limits;
  const n = block.tiles.length;
  const max = data.limits.promoTiles ?? 4;
  const layouts = PROMO_LAYOUTS[n] ?? [];
  const big = block.layout === "big_start" || block.layout === "big_end";
  const setTiles = (tiles: PromoTile[]) => onChange({ ...block, tiles, layout: promoLayoutFor(block.layout, tiles.length) });
  const setTile = (i: number, tile: PromoTile) => setTiles(block.tiles.map((x, j) => (j === i ? tile : x)));
  return (
    <div className="shd-promo-editor" data-testid="promo-editor">
      {layouts.length > 0 ? (
        <fieldset className="shd-field shd-display">
          <legend className="shd-label">{t("home.pg.layout")}</legend>
          <div className="shd-seg-row" role="radiogroup" aria-label={t("home.pg.layout")}>
            <span className="shd-seg shd-variants">
              {layouts.map((l) => (
                <label key={l} className={`shd-seg-opt shd-variant${block.layout === l ? " is-on" : ""}`}>
                  <input type="radio" name={`${block.id}-layout`} checked={block.layout === l} onChange={() => onChange({ ...block, layout: l })} data-testid={`promo-layout-${l}`} />
                  <span className={`shd-pg-draw is-n${n} is-${l}`} aria-hidden="true">{Array.from({ length: n }, (_, i) => <i key={i} />)}</span>
                  <span>{t(`home.pg.layout.${n}.${l}`)}</span>
                </label>
              ))}
            </span>
          </div>
        </fieldset>
      ) : (
        <p className="shd-hint">{fill(t("home.pg.need_two"), { min: data.min_shown_items })}</p>
      )}
      {big && (
        <div className="shd-seg-row" role="radiogroup" aria-label={t("home.pg.share")}>
          <span className="shd-sub">{t("home.pg.share")}</span>
          <span className="shd-seg">
            {PROMO_SHARES.map((s) => (
              <label key={s} className={`shd-seg-opt${block.share === s ? " is-on" : ""}`}>
                <input type="radio" name={`${block.id}-share`} checked={block.share === s} onChange={() => onChange({ ...block, share: s })} data-testid={`promo-share-${s}`} />
                <span>{fill(t("home.pg.share_n"), { n: s })}</span>
              </label>
            ))}
          </span>
        </div>
      )}
      <div className="shd-seg-row" role="radiogroup" aria-label={t("home.pg.divider")}>
        <span className="shd-sub">{t("home.pg.divider")}</span>
        <span className="shd-seg">
          {PROMO_DIVIDERS.map((dv) => (
            <label key={dv} className={`shd-seg-opt${block.divider === dv ? " is-on" : ""}`}>
              <input type="radio" name={`${block.id}-divider`} checked={block.divider === dv} onChange={() => onChange({ ...block, divider: dv })} data-testid={`promo-divider-${dv}`} />
              <span>{t(`home.pg.divider.${dv}`)}</span>
            </label>
          ))}
        </span>
      </div>
      <p className="shd-hint">{t("home.pg.divider_hint")}</p>
      <p className="shd-hint">{fill(t("home.pg.rule"), { min: data.min_shown_items, max })}</p>
      {block.tiles.map((tile, i) => {
        const name = fill(t("home.pg.tile_n"), { n: i + 1 });
        return (
          <fieldset key={i} className="shd-slide" data-testid={`tile-${i}`}>
            <legend className="shd-slide-head"><span>{name}</span></legend>
            <div className="shd-slide-tools">
              <button type="button" className="col-icon-btn" onClick={() => setTiles(moved(block.tiles, i, -1))} disabled={i === 0} aria-label={fill(t("home.move_up"), { name })}><IconArrowUp /></button>
              <button type="button" className="col-icon-btn" onClick={() => setTiles(moved(block.tiles, i, 1))} disabled={i === n - 1} aria-label={fill(t("home.move_down"), { name })}><IconArrowDown /></button>
              <button type="button" className="col-icon-btn" onClick={() => setTiles(block.tiles.filter((_, j) => j !== i))} aria-label={fill(t("home.f.remove"), { name })} data-testid={`tile-${i}-remove`}><IconTrash /></button>
            </div>
            <ImageField vendorId={vendorId} label={t("home.pg.image")} spec={TILE_SPEC} value={tile.image} data={data} canAdd={!!tile.image || imagesLeft > 0} onChange={(img) => img && patch((b) => (b.type === "promo_grid" ? { ...b, tiles: b.tiles.map((x, j) => (j === i ? { ...x, image: img } : x)) } : b))} testid={`tile-${i}-image`} noRatio />
            <FocusField value={tile.focus} image={tile.image?.url ?? null} onChange={(focus) => setTile(i, { ...tile, focus })} testid={`tile-${i}-focus`} />
            <TextField label={t("home.pg.title")} hint={t("home.pg.title_hint")} value={tile.title} max={L.tileTitle ?? 40} onChange={(v) => setTile(i, { ...tile, title: v })} testid={`tile-${i}-title`} />
            <TextField label={t("home.pg.text")} value={tile.text} max={L.tileText ?? 80} onChange={(v) => setTile(i, { ...tile, text: v })} testid={`tile-${i}-text`} />
            <TextField label={t("home.f.button")} hint={t("home.pg.button_hint")} value={tile.button} max={L.button} onChange={(v) => setTile(i, { ...tile, button: v })} testid={`tile-${i}-button`} />
            <TargetField value={tile.target} data={data} products={products} onChange={(v) => setTile(i, { ...tile, target: v })} onPickProduct={() => onPickTarget(-(10 + i))} testid={`tile-${i}-target`} />
            <TextField label={t("home.f.alt")} hint={t("home.f.alt_hint")} value={tile.alt} max={L.alt} onChange={(v) => setTile(i, { ...tile, alt: v })} />
          </fieldset>
        );
      })}
      {n < max && (
        <button type="button" className="button-link owner-secondary" onClick={() => setTiles([...block.tiles, { ...EMPTY_TILE }])} disabled={imagesLeft <= 0} data-testid="tiles-add">
          <IconPlus /> {t("home.pg.add")}
        </button>
      )}
    </div>
  );
}

/**
 * «بطاقات التصنيفات» (P1): the block's shape and heading, then 2-8 cards -
 * each one a destination chosen from the store's REAL departments and
 * categories (never typed), its own image, an Arabic title (English
 * optional), a short line, a focus point and a description.
 */
function CategoryCardsEditor({
  vendorId,
  block,
  data,
  imagesLeft,
  onChange,
}: {
  vendorId: string;
  block: Extract<HomeBlock, { type: "category_cards" }>;
  data: OwnerHome;
  imagesLeft: number;
  onChange: (b: HomeBlock) => void;
}) {
  const t = useT();
  const lang = useLang();
  const patch = useContext(PatchCtx);
  const L = data.text_limits;
  const max = data.limits.categoryCards ?? 8;
  const spec = block.shape === "portrait" ? IMAGE_SPECS.card_portrait : IMAGE_SPECS.card_square;
  // the destinations: the store's departments and its categories with products shoppers can buy now
  const options = [
    ...(data.options.audiences ?? []).map((a) => ({ key: `${a.audience}/`, audience: a.audience, category: null as string | null, label: lang === "en" ? a.name_en : a.name_ar, count: a.count })),
    ...data.options.categories.map((c) => ({ key: `${c.audience}/${c.category}`, audience: c.audience, category: c.category as string | null, label: lang === "en" ? `${c.audience_en} · ${c.name_en}` : `${c.audience_ar} · ${c.name_ar}`, count: c.count })),
  ];
  const keyOf = (c: CategoryCard) => `${c.audience}/${c.category ?? ""}`;
  const used = new Set(block.items.map(keyOf));
  const set = (i: number, c: CategoryCard) => onChange({ ...block, items: block.items.map((x, j) => (j === i ? c : x)) });
  const free = options.find((o) => !used.has(o.key));
  function add() {
    if (!free) return;
    onChange({ ...block, items: [...block.items, { audience: free.audience as CategoryCard["audience"], category: free.category, image: null, title: NO_TEXT, text: NO_TEXT, alt: NO_TEXT, focus: "center" }] });
  }
  return (
    <div className="shd-cards-editor" data-testid="cards-editor">
      <fieldset className="shd-field shd-display">
        <legend className="shd-label">{t("home.cards.shape")}</legend>
        <div className="shd-seg-row" role="radiogroup" aria-label={t("home.cards.shape")}>
          <span className="shd-seg">
            {CARD_SHAPES.map((s) => (
              <label key={s} className={`shd-seg-opt${block.shape === s ? " is-on" : ""}`}>
                <input type="radio" name={`${block.id}-shape`} checked={block.shape === s} onChange={() => onChange({ ...block, shape: s })} data-testid={`cards-shape-${s}`} />
                <span>{t(`home.cards.shape.${s}`)}</span>
              </label>
            ))}
          </span>
        </div>
      </fieldset>
      <TextField label={t("home.f.section_title")} hint={t("home.cards.title_hint")} value={block.title} max={L.title} onChange={(v) => onChange({ ...block, title: v })} testid="cards-heading" />
      <p className="shd-hint">{fill(t("home.cards.rule"), { min: data.min_shown_items, max })}</p>
      {block.items.map((c, i) => {
        const n = i + 1;
        const name = fill(t("home.f.card_n"), { n });
        const current = options.find((o) => o.key === keyOf(c));
        return (
          <fieldset key={i} className="shd-slide" data-testid={`card-${i}`}>
            <legend className="shd-slide-head"><span>{name}</span></legend>
            <div className="shd-slide-tools">
              <button type="button" className="col-icon-btn" onClick={() => onChange({ ...block, items: moved(block.items, i, -1) })} disabled={i === 0} aria-label={fill(t("home.move_up"), { name })}><IconArrowUp /></button>
              <button type="button" className="col-icon-btn" onClick={() => onChange({ ...block, items: moved(block.items, i, 1) })} disabled={i === block.items.length - 1} aria-label={fill(t("home.move_down"), { name })}><IconArrowDown /></button>
              <button type="button" className="col-icon-btn" onClick={() => onChange({ ...block, items: block.items.filter((_, j) => j !== i) })} aria-label={fill(t("home.f.remove"), { name })} data-testid={`card-${i}-remove`}><IconTrash /></button>
            </div>
            <label className="shd-field">
              <span className="shd-label">{t("home.cards.target")}</span>
              <select
                value={keyOf(c)}
                onChange={(e) => {
                  const o = options.find((x) => x.key === e.target.value);
                  if (o) set(i, { ...c, audience: o.audience as CategoryCard["audience"], category: o.category });
                }}
                data-testid={`card-${i}-target`}
              >
                {!current && <option value={keyOf(c)}>{t("home.cards.target_gone")}</option>}
                {options.map((o) => (
                  <option key={o.key} value={o.key} disabled={o.key !== keyOf(c) && used.has(o.key)}>
                    {o.label} ({o.count})
                  </option>
                ))}
              </select>
            </label>
            {!current && <p className="col-note is-warn">{t("home.cards.target_gone_note")}</p>}
            <ImageField vendorId={vendorId} label={t("home.cards.image")} spec={spec.desktop} value={c.image} data={data} canAdd={!!c.image || imagesLeft > 0} onChange={(img) => img && patch((b) => (b.type === "category_cards" ? { ...b, items: b.items.map((x, j) => (j === i ? { ...x, image: img } : x)) } : b))} testid={`card-${i}-image`} />
            <FocusField value={c.focus} image={c.image?.url ?? null} onChange={(focus) => set(i, { ...c, focus })} testid={`card-${i}-focus`} />
            <TextField label={t("home.cards.card_title")} hint={t("home.cards.card_title_hint")} value={c.title} max={L.cardTitle ?? 24} onChange={(v) => set(i, { ...c, title: v })} testid={`card-${i}-title`} />
            <TextField label={t("home.cards.card_text")} value={c.text} max={L.cardText ?? 40} onChange={(v) => set(i, { ...c, text: v })} testid={`card-${i}-text`} />
            <TextField label={t("home.f.alt")} hint={t("home.cards.alt_hint")} value={c.alt} max={L.alt} onChange={(v) => set(i, { ...c, alt: v })} />
          </fieldset>
        );
      })}
      {block.items.length < max && (
        <button type="button" className="button-link owner-secondary" onClick={add} disabled={!free} data-testid="cards-add">
          <IconPlus /> {t("home.cards.add")}
        </button>
      )}
      {!free && block.items.length < max && <p className="shd-hint">{t("home.cards.no_more")}</p>}
    </div>
  );
}

/** One banner card's fields (the single banner, or each card of the double one). */
function CardFields({
  vendorId,
  card,
  spec,
  data,
  imagesLeft,
  products,
  onChange,
  onPickProduct,
  testid,
  required,
  which,
}: {
  /** the banner's first card or the double banner's second one */
  which: 1 | 2;
  vendorId: string;
  card: BannerCard;
  spec: { desktop: { w: number; h: number; minW: number }; phone: { w: number; h: number; minW: number } };
  data: OwnerHome;
  imagesLeft: number;
  products: Map<string, KnownProduct>;
  onChange: (c: BannerCard) => void;
  onPickProduct: () => void;
  testid: string;
  /** a card of the double banner shows only with its image, a title or text, and a destination */
  required: boolean;
}) {
  const t = useT();
  const L = data.text_limits;
  const patch = useContext(PatchCtx);
  /** an upload's image, on this card as it is in the draft now */
  const patchCard = (part: Partial<BannerCard>) =>
    patch((b) => (b.type !== "banner" ? b : which === 1 ? { ...b, ...part } : { ...b, second: { ...(b.second ?? EMPTY_CARD), ...part } }));
  return (
    <>
      <ImageField vendorId={vendorId} label={t("home.f.image_desktop")} spec={spec.desktop} value={card.image} data={data} canAdd={!!card.image || imagesLeft > 0} onChange={(img) => img && patchCard({ image: img })} testid={`${testid}-image`} />
      <ImageField vendorId={vendorId} label={t("home.f.image_phone")} spec={spec.phone} value={card.image_mobile} data={data} canAdd={imagesLeft > 0} onChange={(img) => patchCard({ image_mobile: img })} removable testid={`${testid}-image-phone`} />
      <FocusField value={card.focus} image={card.image_mobile?.url ?? card.image?.url ?? null} onChange={(focus) => onChange({ ...card, focus })} testid={`${testid}-focus`} />
      <TextField label={required ? t("home.f.title_required") : t("home.f.title")} value={card.title} max={L.title} onChange={(v) => onChange({ ...card, title: v })} testid={`${testid}-title`} />
      <TextField label={t("home.f.text")} value={card.text} max={L.bannerText} onChange={(v) => onChange({ ...card, text: v })} />
      <TargetField value={card.target} data={data} products={products} onChange={(v) => onChange({ ...card, target: v })} onPickProduct={onPickProduct} testid={`${testid}-target`} />
      <TextField label={t("home.f.alt")} hint={t("home.f.alt_hint")} value={card.alt} max={L.alt} onChange={(v) => onChange({ ...card, alt: v })} />
    </>
  );
}

/** «الشكل»: the block's shape (closed values; the first one is the look before). */
function VariantField({ block, onChange }: { block: Extract<HomeBlock, { type: "hero" | "banner" | "products" | "auto_products" }>; onChange: (v: string) => void }) {
  const t = useT();
  const values = BLOCK_VARIANTS[block.type] as readonly string[];
  const current = block.variant ?? values[0];
  return (
    <fieldset className="shd-field shd-display" data-testid="home-variant">
      <legend className="shd-label">{t("home.v.title")}</legend>
      <div className="shd-seg-row" role="radiogroup" aria-label={t("home.v.title")}>
        <span className="shd-seg shd-variants">
          {values.map((v) => (
            <label key={v} className={`shd-seg-opt shd-variant${current === v ? " is-on" : ""}`}>
              <input type="radio" name={`${block.id}-variant`} checked={current === v} onChange={() => onChange(v)} data-testid={`home-variant-${v}`} />
              <span className={`shd-variant-draw is-${block.type}-${v}`} aria-hidden="true"><i /><i /><i /></span>
              <span>{t(`home.v.${block.type}.${v}`)}</span>
            </label>
          ))}
        </span>
      </div>
      <p className="shd-hint">{t(`home.v.${block.type}.${current}.hint`)}</p>
    </fieldset>
  );
}

/**
 * «نقطة التركيز»: where the image's subject is, on a 3x3 grid (never numbers)
 * - the crop keeps it in view, on a phone above all. Physical sides: images
 * are never mirrored between Arabic and English, so this grid is not either.
 */
function FocusField({ value, image, onChange, testid }: { value: FocusPoint | undefined; image: string | null; onChange: (f: FocusPoint) => void; testid: string }) {
  const t = useT();
  const id = useId();
  const current = value ?? "center";
  return (
    <fieldset className="shd-field shd-focus" data-testid={testid}>
      <legend className="shd-label">{t("home.focus.title")}</legend>
      <p className="shd-hint" id={`${id}-hint`}>{t("home.focus.hint")}</p>
      <div className="shd-focus-row">
        <div className="shd-focus-grid" role="radiogroup" aria-label={t("home.focus.title")} aria-describedby={`${id}-hint`} dir="ltr" style={image ? { backgroundImage: `url("${image.replace(/"/g, "%22")}")` } : undefined}>
          {FOCUS_POINTS.map((f) => (
            <label key={f} className={`shd-focus-cell${current === f ? " is-on" : ""}`} title={t(`home.focus.${f}`)}>
              <input type="radio" name={`${id}-focus`} checked={current === f} onChange={() => onChange(f)} aria-label={t(`home.focus.${f}`)} data-testid={`${testid}-${f}`} />
              <span aria-hidden="true" />
            </label>
          ))}
        </div>
        {image && (
          <span className="shd-focus-sample" aria-hidden="true">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={image} alt="" className={`sh-fp-${current}`} />
          </span>
        )}
      </div>
    </fieldset>
  );
}

/**
 * «القياس الدقيق» (P2): whole steps over the presets above - −10 / +10, the
 * value now, «رجوع للافتراضي». Never a typed px or %: each type gets only
 * its own keys, each key its own range (the API refuses anything else); a
 * phone derives its own safe value. «0» / «افتراضي» = the look before.
 */
function FineField({ block, keys, tight, onChange }: { block: HomeBlock; keys: Record<string, FineKey[]>; tight: boolean; onChange: (d: BlockDisplay) => void }) {
  const t = useT();
  const own = keys[block.type] ?? [];
  if (own.length === 0) return null;
  const d = displayOf(block.type, block.display);
  const set = (k: FineKey, v: number | string | null) => {
    const next = { ...d } as Record<string, unknown>;
    if (v === null) delete next[k];
    else next[k] = v;
    onChange(next as BlockDisplay);
  };
  const clamp = (k: keyof typeof FINE_STEPS, v: number) => Math.max(FINE_STEPS[k].min, Math.min(FINE_STEPS[k].max, v));
  const preset = PRESET_SPACE[d.spacing ?? "normal"];
  const perView = block.type === "category_cards" ? PER_VIEW[block.shape] : PER_VIEW[block.type];
  return (
    <fieldset className="shd-field shd-display shd-fine" data-testid="home-fine">
      <legend className="shd-label">{t("home.fine.title")}</legend>
      <p className="shd-hint">{t("home.fine.hint")}</p>
      {own.includes("height_step") && (
        <Stepper
          k="height_step"
          label={t("home.fine.height")}
          text={`${(d.height_step ?? 0) > 0 ? "+" : ""}${(d.height_step ?? 0) * 10}px`}
          unit="px"
          canDown={!tight && (d.height_step ?? 0) > FINE_STEPS.height_step.min}
          canUp={(d.height_step ?? 0) < FINE_STEPS.height_step.max}
          onStep={(delta) => {
            const v = clamp("height_step", (d.height_step ?? 0) + delta);
            set("height_step", v === 0 ? null : v);
          }}
          isDefault={!d.height_step}
          onReset={() => set("height_step", null)}
          note={tight ? t("home.fine.too_tight") : undefined}
        />
      )}
      {(["space_before", "space_after"] as const).filter((k) => own.includes(k)).map((k) => {
        const v = d[k];
        const base = Math.round(preset / 10);
        return (
          <Stepper
            key={k}
            k={k}
            label={t(`home.fine.${k}`)}
            text={v === undefined || v === null ? fill(t("home.fine.default_px"), { v: preset }) : `${v * 10}px`}
            unit="px"
            canDown={(v ?? base) > FINE_STEPS[k].min}
            canUp={(v ?? base) < FINE_STEPS[k].max}
            onStep={(delta) => set(k, clamp(k, (v ?? base) + delta))}
            isDefault={v === undefined || v === null}
            onReset={() => set(k, null)}
          />
        );
      })}
      {own.includes("content_width") && (
        <Stepper
          k="content_width"
          label={t("home.fine.content_width")}
          text={`${(d.content_width ?? 10) * 10}%`}
          unit="%"
          canDown={(d.content_width ?? 10) > FINE_STEPS.content_width.min}
          canUp={(d.content_width ?? 10) < FINE_STEPS.content_width.max}
          onStep={(delta) => {
            const v = clamp("content_width", (d.content_width ?? 10) + delta);
            set("content_width", v === 10 ? null : v);
          }}
          isDefault={!d.content_width || d.content_width === 10}
          onReset={() => set("content_width", null)}
          note={t("home.fine.phone_full")}
        />
      )}
      {own.includes("text_width") && (
        <Stepper
          k="text_width"
          label={t("home.fine.text_width")}
          text={d.text_width ? `${d.text_width * 10}%` : t("home.fine.default_text_width")}
          unit="%"
          canDown={(d.text_width ?? 6) > FINE_STEPS.text_width.min}
          canUp={(d.text_width ?? 6) < FINE_STEPS.text_width.max}
          onStep={(delta) => set("text_width", clamp("text_width", (d.text_width ?? 6) + delta))}
          isDefault={!d.text_width}
          onReset={() => set("text_width", null)}
          note={block.type === "hero" && block.variant === "split" ? t("home.fine.text_width_overlay") : undefined}
        />
      )}
      {own.includes("content_align") && (
        <div className="shd-seg-row" role="radiogroup" aria-label={t("home.fine.align")}>
          <span className="shd-sub">{t("home.fine.align")}</span>
          <span className="shd-seg">
            {(["start", "center", "end"] as const).map((a) => {
              const on = (d.content_align ?? "start") === a;
              return (
                <label key={a} className={`shd-seg-opt${on ? " is-on" : ""}`}>
                  <input type="radio" name={`${block.id}-align`} checked={on} onChange={() => set("content_align", a === "start" ? null : a)} data-testid={`fine-align-${a}`} />
                  <span>{t(`home.fine.align.${a}`)}</span>
                </label>
              );
            })}
          </span>
        </div>
      )}
      {own.includes("per_view") && perView && (
        <div className="shd-seg-row" role="radiogroup" aria-label={t("home.fine.per_view")}>
          <span className="shd-sub">{t("home.fine.per_view")}</span>
          <span className="shd-seg">
            {[null, ...perView].map((n) => {
              const on = (d.per_view ?? null) === n;
              return (
                <label key={String(n)} className={`shd-seg-opt${on ? " is-on" : ""}`}>
                  <input type="radio" name={`${block.id}-per-view`} checked={on} onChange={() => set("per_view", n)} data-testid={`fine-per-view-${n ?? "default"}`} />
                  <span>{n === null ? t("home.fine.default") : String(n)}</span>
                </label>
              );
            })}
          </span>
        </div>
      )}
    </fieldset>
  );
}

function Stepper({
  k,
  label,
  text,
  unit,
  canDown,
  canUp,
  onStep,
  isDefault,
  onReset,
  note,
}: {
  k: string;
  label: string;
  text: string;
  unit: "px" | "%";
  canDown: boolean;
  canUp: boolean;
  onStep: (delta: number) => void;
  isDefault: boolean;
  onReset: () => void;
  note?: string;
}) {
  const t = useT();
  const id = useId();
  return (
    <div className="shd-step-row" data-testid={`fine-${k}`} role="group" aria-labelledby={`${id}-l`}>
      <span className="shd-sub" id={`${id}-l`}>{label}</span>
      <span className="shd-stepper">
        <button type="button" className="shd-step-btn" onClick={() => onStep(-1)} disabled={!canDown} aria-label={fill(t("home.fine.less"), { label, unit })} data-testid={`fine-${k}-down`}>
          −10{unit}
        </button>
        <output className="shd-step-value" aria-live="polite" data-testid={`fine-${k}-value`}>{text}</output>
        <button type="button" className="shd-step-btn" onClick={() => onStep(1)} disabled={!canUp} aria-label={fill(t("home.fine.more"), { label, unit })} data-testid={`fine-${k}-up`}>
          +10{unit}
        </button>
        <button type="button" className="button-link wz-ghost shd-step-reset" onClick={onReset} disabled={isDefault} data-testid={`fine-${k}-reset`}>
          {t("home.fine.reset")}
        </button>
      </span>
      {note && <p className="shd-hint">{note}</p>}
    </div>
  );
}

const TARGET_KINDS = ["none", "products", "new", "sale", "collection", "category", "product"] as const;

function TargetField({
  value,
  data,
  products,
  onChange,
  onPickProduct,
  testid,
}: {
  value: HomeTarget | null;
  data: OwnerHome;
  products: Map<string, KnownProduct>;
  onChange: (v: HomeTarget | null) => void;
  onPickProduct: () => void;
  testid?: string;
}) {
  const t = useT();
  const lang = useLang();
  const id = useId();
  const kind = value?.kind ?? "none";
  // whether the destination still leads somewhere (else the button is not shown)
  const gone =
    (value?.kind === "collection" && (data.refs.collections[value.id]?.status ?? "ok") !== "ok") ||
    (value?.kind === "product" && (data.refs.offers[value.id]?.status ?? products.get(value.id)?.status ?? "ok") !== "ok") ||
    (value?.kind === "category" && (data.refs.categories[`${value.audience}/${value.category}`]?.status ?? "ok") !== "ok") ||
    (value?.kind === "new" && data.options.new_count === 0) ||
    (value?.kind === "sale" && data.options.sale_count === 0);
  function setKind(k: (typeof TARGET_KINDS)[number]) {
    if (k === "none") onChange(null);
    else if (k === "products" || k === "new" || k === "sale") onChange({ kind: k });
    else if (k === "collection") {
      const first = data.options.collections[0];
      onChange(first ? { kind: "collection", id: first.id } : null);
    } else if (k === "category") {
      const first = data.options.categories[0];
      onChange(first ? { kind: "category", audience: first.audience, category: first.category } : null);
    } else onPickProduct();
  }
  const product = value?.kind === "product" ? (products.get(value.id) ?? data.refs.offers[value.id]) : null;
  return (
    <div className="shd-field" data-testid={testid}>
      <label className="shd-label" htmlFor={`${id}-kind`}>{t("home.f.target")}</label>
      <select id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value as (typeof TARGET_KINDS)[number])} data-testid={testid ? `${testid}-kind` : undefined}>
        {TARGET_KINDS.map((k) => (
          <option key={k} value={k} disabled={(k === "collection" && data.options.collections.length === 0) || (k === "category" && data.options.categories.length === 0)}>
            {t(`home.t.${k}`)}
          </option>
        ))}
      </select>
      {value?.kind === "collection" && (
        <select aria-label={t("home.t.pick_collection")} value={value.id} onChange={(e) => onChange({ kind: "collection", id: e.target.value })}>
          {!data.options.collections.some((c) => c.id === value.id) && <option value={value.id}>{data.refs.collections[value.id]?.name_ar ?? "—"}</option>}
          {data.options.collections.map((c) => (
            <option key={c.id} value={c.id}>{lang === "en" && c.name_en ? c.name_en : c.name_ar}</option>
          ))}
        </select>
      )}
      {value?.kind === "category" && (
        <select
          aria-label={t("home.t.pick_category")}
          value={`${value.audience}/${value.category}`}
          onChange={(e) => {
            const [audience, category] = e.target.value.split("/");
            onChange({ kind: "category", audience, category });
          }}
        >
          {!data.options.categories.some((c) => c.audience === value.audience && c.category === value.category) && (
            <option value={`${value.audience}/${value.category}`}>{value.category}</option>
          )}
          {data.options.categories.map((c) => (
            <option key={`${c.audience}/${c.category}`} value={`${c.audience}/${c.category}`}>
              {lang === "en" ? `${c.name_en} · ${c.audience_en}` : `${c.name_ar} · ${c.audience_ar}`}
            </option>
          ))}
        </select>
      )}
      {value?.kind === "product" && (
        <div className="shd-target-product">
          <span>{(lang === "en" ? product?.title_en : product?.title_ar) || product?.title_ar || "—"}</span>
          <button type="button" className="button-link owner-secondary" onClick={onPickProduct}>{t("home.t.change_product")}</button>
        </div>
      )}
      {gone && <p className="col-note is-warn">{t("home.t.gone")}</p>}
    </div>
  );
}

/** Choose from a list, keep the chosen ones in the owner's order. */
function ChooseList({
  chosen,
  max,
  min,
  options,
  status,
  nameOf,
  empty,
  onChange,
  testid,
}: {
  chosen: string[];
  max: number;
  min: number;
  options: { key: string; label: string; labelEn: string | null; meta: string }[];
  status: (key: string) => string;
  nameOf: (key: string) => string;
  empty: string;
  onChange: (keys: string[]) => void;
  testid: string;
}) {
  const t = useT();
  const lang = useLang();
  const full = chosen.length >= max;
  return (
    <div className="shd-choose" data-testid={`${testid}-choose`}>
      <p className="shd-hint">{fill(t("home.f.min_hint"), { min })}</p>
      <h3 className="shd-sub-title">{fill(t("home.f.chosen"), { n: chosen.length, max })}</h3>
      {chosen.length === 0 ? (
        <p className="muted">{t("home.f.none_chosen")}</p>
      ) : (
        <ol className="shd-chosen">
          {chosen.map((key, i) => {
            const st = status(key);
            const name = nameOf(key);
            return (
              <li key={key} className={st === "ok" ? "" : "is-warn"} data-testid={`${testid}-chosen-${i}`}>
                <span className="shd-chosen-name">{name}</span>
                {st !== "ok" && <span className="col-note is-warn">{t(`home.ref.${st}`)}</span>}
                <span className="col-arrows">
                  <button type="button" className="col-icon-btn" onClick={() => onChange(moved(chosen, i, -1))} disabled={i === 0} aria-label={fill(t("home.move_up"), { name })}><IconArrowUp /></button>
                  <button type="button" className="col-icon-btn" onClick={() => onChange(moved(chosen, i, 1))} disabled={i === chosen.length - 1} aria-label={fill(t("home.move_down"), { name })}><IconArrowDown /></button>
                  <button type="button" className="col-icon-btn" onClick={() => onChange(chosen.filter((k) => k !== key))} aria-label={fill(t("home.f.remove"), { name })}><IconTrash /></button>
                </span>
              </li>
            );
          })}
        </ol>
      )}
      <h3 className="shd-sub-title">{t("home.f.available")}</h3>
      {options.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ul className="shd-options">
          {options.map((o) => {
            const on = chosen.includes(o.key);
            return (
              <li key={o.key}>
                <label className="shd-check">
                  <input type="checkbox" checked={on} disabled={!on && full} onChange={() => onChange(on ? chosen.filter((k) => k !== o.key) : [...chosen, o.key])} data-testid={`${testid}-option-${o.key}`} />
                  <span>{lang === "en" && o.labelEn ? o.labelEn : o.label}</span>
                  <span className="muted">{o.meta}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {full && <p className="shd-hint">{fill(t("home.pick.limit"), { max })}</p>}
    </div>
  );
}

function ChosenProducts({
  ids,
  max,
  min,
  products,
  onChange,
  onPick,
}: {
  ids: string[];
  max: number;
  min: number;
  products: Map<string, KnownProduct>;
  onChange: (ids: string[]) => void;
  onPick: () => void;
}) {
  const t = useT();
  const lang = useLang();
  return (
    <div className="shd-choose" data-testid="products-chosen">
      <p className="shd-hint">{fill(t("home.f.min_hint"), { min })}</p>
      <div className="shd-sub-row">
        <h3 className="shd-sub-title">{fill(t("home.f.chosen"), { n: ids.length, max })}</h3>
        <button type="button" className="button owner-primary" onClick={onPick} data-testid="products-pick">
          <IconPlus /> {t("home.f.choose_products")}
        </button>
      </div>
      {ids.length === 0 ? (
        <p className="muted">{t("home.f.none_chosen")}</p>
      ) : (
        <ol className="shd-chosen shd-chosen-products">
          {ids.map((id, i) => {
            const p = products.get(id);
            const name = (lang === "en" ? p?.title_en : p?.title_ar) || p?.title_ar || "—";
            const st = p?.status ?? "ok";
            return (
              <li key={id} className={st === "ok" ? "" : "is-warn"} data-testid={`products-chosen-${i}`}>
                {p?.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.image_url} alt="" className="col-thumb" />
                ) : (
                  <span className="col-thumb col-thumb-empty" aria-hidden="true"><IconImage /></span>
                )}
                <span className="shd-chosen-name">{name}</span>
                {st !== "ok" && <span className="col-note is-warn" data-testid={`products-chosen-${i}-status`}>{t(`home.ref.${st}`)}</span>}
                <span className="col-arrows">
                  <button type="button" className="col-icon-btn" onClick={() => onChange(moved(ids, i, -1))} disabled={i === 0} aria-label={fill(t("home.move_up"), { name })}><IconArrowUp /></button>
                  <button type="button" className="col-icon-btn" onClick={() => onChange(moved(ids, i, 1))} disabled={i === ids.length - 1} aria-label={fill(t("home.move_down"), { name })}><IconArrowDown /></button>
                  <button type="button" className="col-icon-btn" onClick={() => onChange(ids.filter((x) => x !== id))} aria-label={fill(t("home.f.remove"), { name })}><IconTrash /></button>
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/**
 * «الشكل والمساحة» (2026-11-21): the block's width / height / spacing - closed
 * choices only (the API refuses anything else), only the ones its type takes;
 * the defaults are the look it had before. The live preview follows at once.
 */
function DisplayField({ block, keys, onChange }: { block: HomeBlock; keys: Record<string, DisplayKey[]>; onChange: (d: BlockDisplay) => void }) {
  const t = useT();
  const own = keys[block.type] ?? [];
  if (own.length === 0) return null;
  const d = displayOf(block.type, block.display, keys);
  return (
    <fieldset className="shd-field shd-display" data-testid="home-display">
      <legend className="shd-label">{t("home.d.title")}</legend>
      {own.map((key) => (
        <div key={key} className="shd-seg-row" role="radiogroup" aria-label={t(`home.d.${key}`)}>
          <span className="shd-sub">{t(`home.d.${key}`)}</span>
          <span className="shd-seg">
            {DISPLAY_VALUES[key].map((v) => (
              <label key={v} className={`shd-seg-opt${d[key] === v ? " is-on" : ""}`}>
                <input
                  type="radio"
                  name={`${block.id}-${key}`}
                  checked={d[key] === v}
                  onChange={() => onChange({ ...d, [key]: v })}
                  data-testid={`home-display-${key}-${v}`}
                />
                <span>{t(`home.d.${key}.${v}`)}</span>
              </label>
            ))}
          </span>
        </div>
      ))}
    </fieldset>
  );
}
