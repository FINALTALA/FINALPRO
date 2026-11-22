"use client";

import { type CSSProperties, Fragment, type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import SafeImage from "@/components/SafeImage";
import StoreOfferCard from "@/components/StoreOfferCard";
import { fmt } from "@/lib/shopText";
import { type FocusPoint, type HomeStyle, type HomeTarget, type LocalText, type PublicHome, type ResolvedBlock, type ShownCard, displayClass, fineLayout, focusClass, pick, storeHomeApi } from "@/lib/storeHome";
import "@/lib/storeHomeText";
import { useLang, useT } from "@/lib/useLang";
import "./storeHome.css";

/** «فئات المتجر» is retired (2026-11-20): never rendered, even from an older response. */
const RETIRED = true;

/**
 * «الصفحة الرئيسية المرنة للمتجر» (2026-11-20): the store's published
 * blocks as shoppers see them - and, with `device`, the owner's preview of
 * her draft: the SAME component, so the preview is what shoppers get.
 * Every block comes resolved from the API (nothing gone, hidden or sold out
 * reaches here). Text is always rendered as text. Destinations are internal
 * choices handled by `onTarget` (the store page applies the filter and
 * scrolls to «تصفّحي المنتجات», or opens the product).
 */
export default function StoreHomeBlocks({
  blocks,
  slug,
  onTarget,
  device,
  preview = false,
  look,
  afterFirst,
}: {
  /** shown right after the first block (the store page's jump link when the first block is a full-width Hero) */
  afterFirst?: ReactNode;
  blocks: ResolvedBlock[];
  slug: string;
  onTarget: (target: HomeTarget) => void;
  /** The owner's preview: which images and layout to show, whatever the window is. */
  device?: "desktop" | "phone";
  /** The owner's preview: links do not navigate. */
  preview?: boolean;
  /** The page's style (closed values; absent / "default" = the look before styles). */
  look?: HomeStyle;
}) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const anyFull = blocks.some((b) => b.display?.width === "full");
  // «كامل العرض»: how far the root is from the edges of its frame (the page's
  // visible width - never the scrollbar - or the owner's preview box), so a
  // full-width block reaches them without making anything scroll sideways.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !anyFull) return;
    const measure = () => {
      const frame = root.closest<HTMLElement>("[data-sh-frame]");
      const r = root.getBoundingClientRect();
      let left = 0;
      let right = document.documentElement.clientWidth;
      if (frame) {
        const f = frame.getBoundingClientRect();
        left = f.left + frame.clientLeft;
        right = left + frame.clientWidth;
      }
      root.style.setProperty("--sh-bleed-l", `${Math.max(0, Math.round(r.left - left))}px`);
      root.style.setProperty("--sh-bleed-r", `${Math.max(0, Math.round(right - r.right))}px`);
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(root);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [anyFull]);
  if (blocks.length === 0) return null;
  const firstHero = blocks.findIndex((b) => b.type === "hero" || b.type === "banner");
  function stopLinks(e: MouseEvent) {
    if (preview && (e.target as Element).closest("a")) e.preventDefault();
  }
  return (
    <div
      ref={rootRef}
      className="sh-root"
      data-style={look && look !== "default" ? look : undefined}
      data-device={device ?? "auto"}
      data-preview={preview ? "true" : undefined}
      role="region"
      aria-label={t("home.region")}
      onClickCapture={stopLinks}
      data-testid="store-home"
    >
      {blocks.map((b, i) => (
        <Fragment key={b.id}>
          {/* its display choices (closed values from the API) and P2's fine sizes (whole steps -> px / % variables, clamped by the CSS) */}
          <div className={`sh-slot ${displayClass(b.display)} ${fineLayout(b.display).className}`.trim()} style={fineLayout(b.display).style as CSSProperties} data-block-id={b.id}>
            <HomeBlockView block={b} slug={slug} onTarget={onTarget} device={device} eager={i === firstHero} />
          </div>
          {i === 0 && afterFirst}
        </Fragment>
      ))}
    </div>
  );
}

function HomeBlockView({ block, slug, onTarget, device, eager }: { block: ResolvedBlock; slug: string; onTarget: (t: HomeTarget) => void; device?: "desktop" | "phone"; eager: boolean }) {
  const t = useT();
  const lang = useLang();
  const title = (own: LocalText, fallback: string) => pick(lang, own) || t(fallback);
  switch (block.type) {
    case "hero":
      return <HeroView block={block} onTarget={onTarget} device={device} eager={eager} />;
    case "banner": {
      if (block.variant === "double" && block.second) {
        // two promotional cards side by side (stacked on a phone) - each one complete
        return (
          <section className="sh-block sh-banner is-double" data-block="banner" data-variant="double" data-testid={`home-block-${block.id}`}>
            <div className="sh-banner-pair">
              <BannerFrame card={block} onTarget={onTarget} device={device} eager={eager} testid="home-banner-card-1" />
              <BannerFrame card={block.second} onTarget={onTarget} device={device} eager={false} testid="home-banner-card-2" />
            </div>
          </section>
        );
      }
      return (
        <section className="sh-block sh-banner" data-block="banner" data-testid={`home-block-${block.id}`}>
          <BannerFrame card={block} onTarget={onTarget} device={device} eager={eager} />
        </section>
      );
    }
    case "collections":
      return (
        <section className="sh-block" data-block="collections" data-testid={`home-block-${block.id}`} aria-labelledby={`sh-${block.id}`}>
          <Rail label={title(block.title, "home.default.collections")} header={<h2 className="sh-heading" id={`sh-${block.id}`}>{title(block.title, "home.default.collections")}</h2>}>
            {block.items.map((c) => {
              const name = lang === "en" && c.name_en ? c.name_en : c.name_ar;
              return (
                <li key={c.id} className="sh-rail-item sh-tile-item">
                  <button type="button" className="sh-tile" onClick={() => onTarget({ kind: "collection", id: c.id })}>
                    <span className="sh-tile-media">{c.image_url ? <SafeImage src={c.image_url} alt="" loading="lazy" /> : <span className="sh-tile-empty" aria-hidden="true" />}</span>
                    <span className="sh-tile-name">{name}</span>
                    <span className="sh-tile-meta">{fmt(t("home.n_products"), { n: c.count })}</span>
                  </button>
                </li>
              );
            })}
          </Rail>
        </section>
      );
    case "categories":
      // retired: the categories are in «استكشفي التصنيفات» (the API no longer sends this block)
      if (RETIRED) return null;
      return (
        <section className="sh-block" data-block="categories" data-testid={`home-block-${block.id}`} aria-labelledby={`sh-${block.id}`}>
          <h2 className="sh-heading" id={`sh-${block.id}`}>{title(block.title, "home.default.categories")}</h2>
          <ul className="sh-categories">
            {block.items.map((c) => {
              const name = lang === "en" ? c.name_en : c.name_ar;
              const audience = lang === "en" ? c.audience_en : c.audience_ar;
              return (
                <li key={`${c.audience}/${c.category}`}>
                  <button type="button" className="sh-category" onClick={() => onTarget({ kind: "category", audience: c.audience, category: c.category })} data-testid={`home-category-${c.audience}-${c.category}`}>
                    <span className="sh-category-media">{c.image_url ? <SafeImage src={c.image_url} alt="" loading="lazy" /> : <span className="sh-tile-empty" aria-hidden="true" />}</span>
                    <span className="sh-category-text">
                      <span className="sh-category-name">{name}</span>
                      <span className="sh-category-meta">{audience} · {fmt(t("home.n_products"), { n: c.count })}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      );
    case "products":
    case "auto_products": {
      const heading =
        block.type === "auto_products"
          ? title(block.title, block.source === "new" ? "home.default.new" : "home.default.sale")
          : title(block.title, "home.default.products");
      const viewAll: HomeTarget | null = block.type === "auto_products" ? { kind: block.source } : null;
      if (block.variant === "side") {
        // «شريط منتجات»: the title and a short description beside a horizontal strip
        const lead = pick(lang, block.text);
        return (
          <section className="sh-block sh-side" data-block={block.type} data-variant="side" data-testid={`home-block-${block.id}`} aria-labelledby={`sh-${block.id}`}>
            <div className="sh-side-grid">
              <div className="sh-side-text">
                <h2 className="sh-heading" id={`sh-${block.id}`}>{heading}</h2>
                {lead && <p className="sh-side-lead">{lead}</p>}
                {viewAll && (
                  <button type="button" className="sh-view-all" onClick={() => onTarget(viewAll)}>
                    {t("home.view_all")} <span aria-hidden="true" className="sh-chevron">‹</span>
                  </button>
                )}
              </div>
              <Rail label={heading} className="store-product-grid">
                {block.items.map((o) => (
                  <li key={o.id} className="sh-rail-item sh-card-item">
                    <StoreOfferCard slug={slug} offer={o} />
                  </li>
                ))}
              </Rail>
            </div>
          </section>
        );
      }
      return (
        <section className="sh-block" data-block={block.type} data-testid={`home-block-${block.id}`} aria-labelledby={`sh-${block.id}`}>
          {/* the store grid's own card look; the strip's title row carries its arrows on a phone */}
          <Rail
            label={heading}
            className="store-product-grid"
            header={
              <>
                <h2 className="sh-heading" id={`sh-${block.id}`}>{heading}</h2>
                {viewAll && (
                  <button type="button" className="sh-view-all" onClick={() => onTarget(viewAll)}>
                    {t("home.view_all")} <span aria-hidden="true" className="sh-chevron">‹</span>
                  </button>
                )}
              </>
            }
          >
            {block.items.map((o) => (
              <li key={o.id} className="sh-rail-item sh-card-item">
                <StoreOfferCard slug={slug} offer={o} />
              </li>
            ))}
          </Rail>
        </section>
      );
    }
    case "promo_grid":
      return <PromoGridView block={block} onTarget={onTarget} device={device} eager={eager} />;
    case "category_cards": {
      // «بطاقات التصنيفات» (P1): pictures that lead to a real department or category -
      // a visual, optional block; the fixed chips of «استكشفي التصنيفات» stay the navigation
      const heading = pick(lang, block.title);
      const label = heading || t("home.cards.region");
      return (
        <section
          className={`sh-block sh-cards is-${block.shape}`}
          data-block="category_cards"
          data-shape={block.shape}
          data-testid={`home-block-${block.id}`}
          aria-labelledby={heading ? `sh-${block.id}` : undefined}
          aria-label={heading ? undefined : label}
        >
          <Rail label={label} className="sh-cards-rail" header={heading ? <h2 className="sh-heading" id={`sh-${block.id}`}>{heading}</h2> : null}>
            {block.items.map((c) => {
              const name = pick(lang, c.title);
              const line = pick(lang, c.text);
              const key = c.target.kind === "category" ? `${c.target.audience}-${c.target.category}` : c.target.audience;
              return (
                <li key={key} className="sh-rail-item sh-cardc-item">
                  <button type="button" className="sh-cardc" onClick={() => onTarget(c.target)} data-testid={`home-card-${key}`}>
                    <span className="sh-cardc-media">
                      <SafeImage src={c.image.url} alt={pick(lang, c.alt)} loading="lazy" className={`sh-img ${focusClass(c.focus)}`} />
                    </span>
                    <span className="sh-cardc-name">{name}</span>
                    {line && <span className="sh-cardc-line">{line}</span>}
                  </button>
                </li>
              );
            })}
          </Rail>
        </section>
      );
    }
    case "text": {
      if (block.style === "divider") {
        return (
          <section className="sh-block sh-divider-block" data-block="divider" data-testid={`home-block-${block.id}`}>
            {pick(lang, block.title) ? <h2 className="sh-divider-title">{pick(lang, block.title)}</h2> : <hr className="sh-divider" />}
          </section>
        );
      }
      const heading = pick(lang, block.title);
      const body = pick(lang, block.text);
      return (
        <section className="sh-block sh-text-block" data-block="text" data-testid={`home-block-${block.id}`}>
          {heading && <h2 className="sh-heading">{heading}</h2>}
          {body && <p className="sh-text">{body}</p>}
        </section>
      );
    }
  }
}

/** Where the columns of a promo panel meet (% from the start of the line) - for the slanted / wave cut. */
function promoCuts(layout: string, n: number, share: number): number[] {
  if (n === 2) return [layout === "start_wide" ? 60 : layout === "end_wide" ? 40 : 50];
  if (layout === "big_start") return [share];
  if (layout === "big_end") return [100 - share];
  if (n === 3) return [100 / 3, 200 / 3];
  return [50];
}

/**
 * The slanted / wave divider as a mask of the whole panel (a computer only):
 * a thin transparent band where the columns meet, continuous across rows -
 * drawn from the closed choices only, mirrored for right-to-left (the images
 * themselves are never mirrored).
 */
function promoMask(divider: string, cuts: number[], rtl: boolean): string | null {
  if (divider !== "slant" && divider !== "wave") return null;
  const w = 1.3;
  const f = (v: number) => v.toFixed(2);
  let d = "M0 0H100V100H0Z";
  for (const raw of cuts) {
    const x = rtl ? 100 - raw : raw;
    if (divider === "slant") {
      const off = rtl ? -2.4 : 2.4;
      d += `M${f(x + off - w / 2)} 0L${f(x + off + w / 2)} 0L${f(x - off + w / 2)} 100L${f(x - off - w / 2)} 100Z`;
    } else {
      const pts = Array.from({ length: 21 }, (_, i) => i * 5);
      const xc = (y: number) => x + 0.9 * Math.sin((2 * Math.PI * y) / 50);
      d += `M${f(xc(0) - w / 2)} 0` + pts.slice(1).map((y) => `L${f(xc(y) - w / 2)} ${y}`).join("");
      d += [...pts].reverse().map((y) => `L${f(xc(y) + w / 2)} ${y}`).join("") + "Z";
    }
  }
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' preserveAspectRatio='none'><path fill='#000' fill-rule='evenodd' d='${d}'/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/**
 * «لوحة ترويجية» (P3): 2-4 tiles in a ready layout - on a computer side by
 * side (one wide tile beside a stack, or a 2x2 grid), on a phone stacked
 * (the wide tile first). Each tile: its image, title, description and an
 * optional button to an internal destination. The tile grows with its text
 * (never cut); only the tile's button acts.
 */
function PromoGridView({ block, onTarget, device, eager }: { block: Extract<ResolvedBlock, { type: "promo_grid" }>; onTarget: (t: HomeTarget) => void; device?: "desktop" | "phone"; eager: boolean }) {
  const lang = useLang();
  const n = block.tiles.length;
  const mask = promoMask(block.divider, promoCuts(block.layout, n, block.share), lang !== "en");
  return (
    <section
      className={`sh-block sh-promo is-n${n} is-${block.layout} is-div-${block.divider} is-share-${block.share}`}
      data-block="promo_grid"
      data-layout={block.layout}
      data-divider={block.divider}
      data-testid={`home-block-${block.id}`}
    >
      <div className="sh-promo-grid" style={mask ? ({ ["--pg-mask" as string]: mask } as CSSProperties) : undefined}>
        {block.tiles.map((tile, i) => {
          const title = pick(lang, tile.title);
          const body = pick(lang, tile.text);
          const button = pick(lang, tile.button);
          return (
            <div key={i} className={`sh-pg-tile t${i + 1}`} data-testid={`home-tile-${i + 1}`}>
              <Picture image={tile.image} mobile={null} alt={pick(lang, tile.alt)} device={device} eager={eager && i === 0} focus={tile.focus} />
              <div className="sh-pg-text">
                <h2 className="sh-pg-title">{title}</h2>
                {body && <p className="sh-pg-body">{body}</p>}
                {button && tile.target && (
                  <button type="button" className="sh-pg-button" onClick={() => onTarget(tile.target!)} data-testid={`home-tile-${i + 1}-button`}>
                    {button}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** One banner card: the image (cropped at its focus point), its text, and its destination when it has one. */
function BannerFrame({ card, onTarget, device, eager, testid }: { card: ShownCard; onTarget: (t: HomeTarget) => void; device?: "desktop" | "phone"; eager: boolean; testid?: string }) {
  const lang = useLang();
  const heading = pick(lang, card.title);
  const body = pick(lang, card.text);
  const label = heading || pick(lang, card.alt);
  const inner = (
    <>
      <Picture image={card.image} mobile={card.image_mobile} alt={pick(lang, card.alt) || heading} device={device} eager={eager} focus={card.focus} />
      {(heading || body) && (
        <span className="sh-banner-text">
          {heading && <strong className="sh-banner-title">{heading}</strong>}
          {body && <span className="sh-banner-body">{body}</span>}
        </span>
      )}
    </>
  );
  return card.target ? (
    <button type="button" className="sh-banner-frame sh-banner-link" onClick={() => onTarget(card.target!)} aria-label={label || undefined} data-testid={testid}>
      {inner}
    </button>
  ) : (
    <div className="sh-banner-frame" data-testid={testid}>{inner}</div>
  );
}

/** The desktop image, and the phone image below 640px (or forced by the owner's preview) - cropped at its focus point. */
function Picture({ image, mobile, alt, device, eager, focus }: { image: { url: string }; mobile: { url: string } | null; alt: string; device?: "desktop" | "phone"; eager: boolean; focus?: FocusPoint }) {
  const loading = eager ? "eager" : "lazy";
  const priority = eager ? { fetchPriority: "high" as const } : {};
  const className = `sh-img ${focusClass(focus)}`;
  if (device) {
    const src = device === "phone" && mobile ? mobile.url : image.url;
    return <SafeImage src={src} alt={alt} loading={loading} className={className} {...priority} />;
  }
  return (
    <picture>
      {mobile && <source media="(max-width: 640px)" srcSet={mobile.url} />}
      <SafeImage src={image.url} alt={alt} loading={loading} className={className} {...priority} />
    </picture>
  );
}

function HeroView({ block, onTarget, device, eager }: { block: Extract<ResolvedBlock, { type: "hero" }>; onTarget: (t: HomeTarget) => void; device?: "desktop" | "phone"; eager: boolean }) {
  const t = useT();
  const lang = useLang();
  const [index, setIndex] = useState(0);
  const total = block.slides.length;
  const current = Math.min(index, total - 1);
  const rootRef = useRef<HTMLElement>(null);
  function go(next: number) {
    setIndex((next + total) % total);
  }
  function onKey(e: KeyboardEvent) {
    if (total < 2) return;
    const rtl = rootRef.current ? getComputedStyle(rootRef.current).direction === "rtl" : false;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(current + (rtl ? 1 : -1));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      go(current + (rtl ? -1 : 1));
    }
  }
  const split = block.variant === "split";
  return (
    <section
      ref={rootRef}
      className={`sh-block sh-hero${split ? " is-split" : ""}`}
      data-block="hero"
      data-variant={split ? "split" : undefined}
      data-testid={`home-block-${block.id}`}
      aria-roledescription="carousel"
      aria-label={t("home.slides")}
      onKeyDown={onKey}
    >
      <div className="sh-hero-viewport">
        <div className="sh-hero-track" style={{ ["--i" as string]: current }}>
          {block.slides.map((s, i) => {
            const heading = pick(lang, s.title);
            const body = pick(lang, s.text);
            const button = pick(lang, s.button);
            const active = i === current;
            return (
              <div
                key={i}
                className={`sh-hero-slide is-${s.align}`}
                role="group"
                aria-roledescription="slide"
                aria-label={fmt(t("home.slide_n"), { n: i + 1, total })}
                aria-hidden={!active}
                inert={!active ? true : undefined}
                data-active={active ? "true" : undefined}
              >
                {split ? (
                  // «Hero منقسم»: the image on one side, the text on the other (image above, text below on a phone)
                  <div className="sh-hero-media">
                    <Picture image={s.image} mobile={s.image_mobile} alt={pick(lang, s.alt) || heading} device={device} eager={eager && i === 0} focus={s.focus} />
                  </div>
                ) : (
                  <Picture image={s.image} mobile={s.image_mobile} alt={pick(lang, s.alt) || heading} device={device} eager={eager && i === 0} focus={s.focus} />
                )}
                {(heading || body || (button && s.target)) && (
                  <div className="sh-hero-text">
                    {heading && <h2 className="sh-hero-title">{heading}</h2>}
                    {body && <p className="sh-hero-body">{body}</p>}
                    {button && s.target && (
                      <button type="button" className="sh-hero-button" onClick={() => onTarget(s.target!)} data-testid="home-hero-button">
                        {button}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {total > 1 && (
        <div className="sh-hero-controls">
          <button type="button" className="sh-hero-arrow" onClick={() => go(current - 1)} aria-label={t("home.prev_slide")} data-testid="home-hero-prev" data-preview-allow>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" className="icon-flip-rtl"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <div className="sh-hero-dots">
            {block.slides.map((_, i) => (
              <button
                key={i}
                type="button"
                className="sh-hero-dot"
                aria-label={fmt(t("home.slide_go"), { n: i + 1 })}
                aria-current={i === current ? "true" : undefined}
                onClick={() => go(i)}
                data-preview-allow
              />
            ))}
          </div>
          <button type="button" className="sh-hero-arrow" onClick={() => go(current + 1)} aria-label={t("home.next_slide")} data-testid="home-hero-next" data-preview-allow>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" className="icon-flip-rtl"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <span className="visually-hidden" aria-live="polite">{fmt(t("home.slide_n"), { n: current + 1, total })}</span>
        </div>
      )}
    </section>
  );
}

/**
 * A horizontal strip (P1): it scrolls by touch, drag and trackpad, with no
 * browser scrollbar; clear previous/next buttons when something is out of
 * view - beside the strip on a wide screen, in its title row on a phone
 * (never over the cards); the button at an end is disabled (still shown).
 * The next item peeks in on a phone. The buttons move the strip locally
 * only, so they work inside the owner's preview too.
 */
function Rail({ label, className, header, children }: { label: string; className?: string; header?: ReactNode; children: ReactNode }) {
  const t = useT();
  const id = useId();
  const ref = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      const pos = Math.abs(el.scrollLeft);
      setEdges({ start: pos <= 2, end: pos >= max - 2 });
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, []);
  function scroll(forward: boolean) {
    const el = ref.current;
    if (!el) return;
    const rtl = getComputedStyle(el).direction === "rtl";
    const step = el.clientWidth * 0.85 * (forward ? 1 : -1) * (rtl ? -1 : 1);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ left: step, behavior: reduce ? "auto" : "smooth" });
  }
  const overflow = !(edges.start && edges.end);
  const button = (forward: boolean, place: "side" | "head") => (
    <button
      type="button"
      className={`sh-rail-btn ${forward ? "is-next" : "is-prev"} is-${place}`}
      onClick={() => scroll(forward)}
      disabled={forward ? edges.end : edges.start}
      aria-label={t(forward ? "home.rail_next" : "home.rail_prev")}
      aria-controls={id}
      data-preview-allow
      data-testid={`home-rail-${forward ? "next" : "prev"}-${place}`}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" className="icon-flip-rtl">
        <path d={forward ? "M9 6l6 6-6 6" : "M15 6l-6 6 6 6"} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
  return (
    <>
      {(header || overflow) && (
        <div className={`sh-heading-row${header ? "" : " is-nav-only"}`}>
          {header}
          {overflow && (
            <span className="sh-rail-headnav">
              {button(false, "head")}
              {button(true, "head")}
            </span>
          )}
        </div>
      )}
      <div className="sh-rail-wrap">
        <ul id={id} className={className ? `sh-rail ${className}` : "sh-rail"} ref={ref} aria-label={label}>
          {children}
        </ul>
        {overflow && (
          <>
            {button(false, "side")}
            {button(true, "side")}
          </>
        )}
      </div>
    </>
  );
}

/**
 * The owner's unpublished draft as shoppers would see it («معاينة كاملة»):
 * the API resolves it with the shoppers' own rules (GET .../storefront/home,
 * owner only). null when not asked, while loading, or on any error - the
 * page then shows the published blocks.
 */
export function useDraftHome(vendorId: string | null): PublicHome | null {
  const [draft, setDraft] = useState<{ vendorId: string; data: PublicHome } | null>(null);
  useEffect(() => {
    if (!vendorId) return;
    let cancelled = false;
    storeHomeApi
      .get(vendorId)
      .then((r) => {
        if (!cancelled) setDraft({ vendorId, data: { enabled: true, blocks: r.preview.blocks, style: r.preview.style } });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [vendorId]);
  return vendorId && draft?.vendorId === vendorId ? draft.data : null;
}

/** The store page's published blocks (null while loading; no blocks on any error - the page stays as before). */
export function useStoreHome(slug: string, version: number): PublicHome | null {
  const [home, setHome] = useState<{ key: string; data: PublicHome } | null>(null);
  const key = `${slug}:${version}`;
  useEffect(() => {
    let cancelled = false;
    storeHomeApi
      .public(slug)
      .then((data) => {
        if (!cancelled) setHome({ key, data });
      })
      .catch(() => {
        if (!cancelled) setHome({ key, data: { enabled: false, blocks: [] } });
      });
    return () => {
      cancelled = true;
    };
  }, [slug, key]);
  return home?.data ?? null;
}
