"use client";

import { type BlockType, type HomeBlock, type OwnerHome, pick } from "@/lib/storeHome";
import "@/lib/storeHomeText";
import { useLang, useT } from "@/lib/useLang";
import type { KnownProduct } from "./HomeBlockEditor";

/**
 * The designer's small pictures (2026-11-21): each block's card shows a
 * miniature of what it holds (its image and title, its products, its
 * collections, its text) instead of dry fields, and «إضافة بلوك» draws each
 * type. Decorative only (aria-hidden): every fact is in the card's text too.
 */

function Img({ src }: { src: string | null | undefined }) {
  // eslint-disable-next-line @next/next/no-img-element
  return src ? <img src={src} alt="" loading="lazy" /> : <span className="shd-mini-ph" />;
}

export function BlockThumb({ block, data, known }: { block: HomeBlock; data: OwnerHome; known: Map<string, KnownProduct> }) {
  const t = useT();
  const lang = useLang();
  const saved = data.preview.blocks.find((x) => x.id === block.id);
  const empty = <span className="shd-mini-empty">{t("home.card.empty")}</span>;
  let body;
  switch (block.type) {
    case "hero":
    case "banner": {
      const image = block.type === "hero" ? block.slides[0]?.image?.url : block.image?.url;
      const title = block.type === "hero" ? pick(lang, block.slides[0]?.title) : pick(lang, block.title);
      const shape = block.type === "hero" ? block.variant ?? "overlay" : block.variant ?? "single";
      body = (
        <span className={`shd-mini shd-mini-image is-${block.type} is-${shape}`}>
          {/* an image place left by a template: clearly empty («أضيفي صورة») */}
          {image ? <Img src={image} /> : <span className="shd-mini-ph is-needed">{t("home.f.add_image")}</span>}
          {block.type === "banner" && shape === "double" && <span className="shd-mini-ph is-second">{block.second?.image ? <Img src={block.second.image.url} /> : null}</span>}
          {title && <span className="shd-mini-title">{title}</span>}
          {block.type === "hero" && block.slides.length > 1 && (
            <span className="shd-mini-dots">{block.slides.map((_, i) => <i key={i} />)}</span>
          )}
        </span>
      );
      break;
    }
    case "products":
    case "auto_products": {
      const images =
        block.type === "products"
          ? block.offer_ids.slice(0, 4).map((id) => known.get(id)?.image_url ?? null)
          : saved?.type === "auto_products"
            ? saved.items.slice(0, 4).map((i) => i.image_url)
            : [];
      body = images.length ? (
        <span className={`shd-mini shd-mini-grid${block.variant === "side" ? " is-side" : ""}`}>
          {images.map((src, i) => <span key={i} className="shd-mini-cell"><Img src={src} /></span>)}
          {block.type === "auto_products" && <span className="shd-mini-badge">{t("home.card.auto")}</span>}
        </span>
      ) : (
        <span className="shd-mini">{empty}</span>
      );
      break;
    }
    case "collections": {
      const names = block.collection_ids
        .map((id) => data.options.collections.find((c) => c.id === id))
        .filter((c): c is NonNullable<typeof c> => !!c)
        .slice(0, 3);
      const images = saved?.type === "collections" ? new Map(saved.items.map((c) => [c.id, c.image_url])) : new Map<string, string | null>();
      body = names.length ? (
        <span className="shd-mini shd-mini-tiles">
          {names.map((c) => (
            <span key={c.id} className="shd-mini-tile">
              <Img src={images.get(c.id)} />
              <span>{lang === "en" && c.name_en ? c.name_en : c.name_ar}</span>
            </span>
          ))}
        </span>
      ) : (
        <span className="shd-mini">{empty}</span>
      );
      break;
    }
    case "promo_grid":
      // the panel's own layout, with its tiles' images («أضيفي صورة» where one is missing)
      body = (
        <span className={`shd-mini shd-mini-promo shd-pg-draw is-n${block.tiles.length} is-${block.layout}`}>
          {block.tiles.map((tile, i) => (
            <i key={i}>{tile.image ? <Img src={tile.image.url} /> : <span className="shd-mini-ph is-needed">{t("home.f.add_image")}</span>}</i>
          ))}
        </span>
      );
      break;
    case "category_cards":
      body = block.items.length ? (
        <span className={`shd-mini shd-mini-cards is-${block.shape}`}>
          {block.items.slice(0, 4).map((c, i) => (
            <span key={i} className="shd-mini-card">
              {c.image ? <Img src={c.image.url} /> : <span className="shd-mini-ph is-needed" />}
              <span>{pick(lang, c.title)}</span>
            </span>
          ))}
        </span>
      ) : (
        <span className="shd-mini">{empty}</span>
      );
      break;
    case "text":
      body =
        block.style === "divider" ? (
          <span className="shd-mini shd-mini-divider"><i />{pick(lang, block.title) && <span>{pick(lang, block.title)}</span>}<i /></span>
        ) : (
          <span className="shd-mini shd-mini-text">
            <strong>{pick(lang, block.title)}</strong>
            <span>{pick(lang, block.text)}</span>
          </span>
        );
      break;
    default:
      body = <span className="shd-mini shd-mini-retired" />;
  }
  return <span className="shd-thumb-frame" aria-hidden="true">{body}</span>;
}

/** A drawing of each type for «إضافة بلوك». */
export function AddThumb({ type }: { type: BlockType }) {
  const cells = (n: number) => Array.from({ length: n }, (_, i) => <i key={i} />);
  return (
    <span className={`shd-draw is-${type}`} aria-hidden="true">
      {type === "hero" && (
        <span className="shd-draw-hero">
          <b />
          <b className="is-short" />
          <em />
        </span>
      )}
      {type === "banner" && <span className="shd-draw-banner"><b /></span>}
      {type === "collections" && <span className="shd-draw-tiles">{cells(3)}</span>}
      {(type === "products" || type === "auto_products") && (
        <span className="shd-draw-cards">
          {cells(4)}
          {type === "auto_products" && <span className="shd-draw-spark">✦</span>}
        </span>
      )}
      {type === "text" && (
        <span className="shd-draw-text">
          <b />
          <i />
          <i className="is-short" />
        </span>
      )}
      {type === "categories" && <span className="shd-draw-text"><i /></span>}
      {type === "category_cards" && <span className="shd-draw-circles">{cells(4)}</span>}
      {type === "promo_grid" && <span className="shd-pg-draw is-n3 is-big_start">{cells(3)}</span>}
    </span>
  );
}

/**
 * «مقطع مميّز»: how a featured clip will look - a large image with a video
 * look, a title and an optional button. A picture only: no upload, no
 * playback, no link, never added to the page or shown to shoppers.
 */
export function SoonPreview() {
  const t = useT();
  return (
    <span className="shd-soon" aria-hidden="true">
      <span className="shd-soon-play">
        <svg viewBox="0 0 24 24" width="22" height="22"><path d="M8 5.5v13l11-6.5z" fill="currentColor" /></svg>
      </span>
      <span className="shd-soon-text">
        <strong>{t("home.soon.sample_title")}</strong>
        <em>{t("home.soon.sample_button")}</em>
      </span>
      <span className="shd-soon-time">0:24</span>
    </span>
  );
}
