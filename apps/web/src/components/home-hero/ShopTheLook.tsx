"use client";

import { getImageProps } from "next/image";
import Link from "next/link";
import type { CSSProperties, PointerEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiFetch } from "@/lib/api";
import type { ComparisonCardDto } from "@/lib/types";
import type { ShopCategory, ShopItem, ShopTheLook as ShopConfig } from "./heroScenes";
import styles from "./home-hero.module.css";

// Auto-advance between garments while nobody is interacting; a touch, drag,
// hover or focus holds it for IDLE_MS.
const AUTO_MS = 3200;
const IDLE_MS = 6000;
const SWIPE_PX = 40;

const CATEGORIES: ShopCategory[] = ["full", "top", "pants", "foot", "accessories"];

const CATEGORY_ICON: Record<ShopCategory, string> = {
  full: "M12 5.5a1.75 1.75 0 1 1 1.75 1.75c-.97 0-1.75.78-1.75 1.75v.5M12 9.5 3.5 15.2c-.7.47-.37 1.55.47 1.55h16.06c.84 0 1.17-1.08.47-1.55L12 9.5Z",
  top: "M9 4.5 4.5 6.8 3 10.5l3 1.2V19.5h12v-7.8l3-1.2-1.5-3.7L15 4.5c-.6 1.2-1.7 1.8-3 1.8s-2.4-.6-3-1.8Z",
  pants: "M7 4.5h10l1.2 15H14l-2-9.5-2 9.5H5.8L7 4.5ZM7 7.5h10",
  foot: "M3.5 14.5V9.8c1.6.4 3 .1 4.2-1l1.3 2.2c1.7 2.8 5.2 2.2 8.4 3 1.6.4 3.1 1.4 3.1 3v.5H3.5v-3Z",
  accessories: "M3 10.5h5.5l.6 2.4a2.6 2.6 0 0 1-5 1.4L3 10.5Zm18 0h-5.5l-.6 2.4a2.6 2.6 0 0 0 5 1.4l1.1-3.8ZM8.5 10.5c1.2-.7 5.8-.7 7 0",
};

/** The exact catalog product behind a piece, from its canonical product id. */
type ProductState =
  | { status: "unmapped" }
  | { status: "loading" }
  | { status: "ok"; card: ComparisonCardDto }
  /** Mapped, but not (or no longer) offered by any store. */
  | { status: "unavailable" };

interface Props {
  shop: ShopConfig;
  /** "leaving": the whole interface fades out as one layer. */
  state: "active" | "leaving" | "hidden";
  /** The hero sequence is paused: garments hold still too. */
  paused: boolean;
  reduced: boolean;
  t: (key: string) => string;
  quality: number;
  /** Any touch, drag, hover, focus or selection: the hero holds the scene. */
  onInteract: () => void;
  /** Phones: where the category toolbar and the selected piece's label go
   *  (below the photo, outside the frame). */
  mobileSlot: HTMLElement | null;
}

export default function ShopTheLook({ shop, state, paused, reduced, t, quality, onInteract, mobileSlot }: Props) {
  const active = state === "active";
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [products, setProducts] = useState<Record<string, ProductState>>({});
  // null = the full look (nothing singled out).
  const [selected, setSelected] = useState<number | null>(null);
  // Bumped by every interaction; the next auto step then waits IDLE_MS.
  const [holds, setHolds] = useState(0);
  const seenHolds = useRef(0);
  const dragX = useRef<number | null>(null);
  const items = shop.items.filter((item) => !failed[item.id]);

  // The exact product behind each mapped piece: its canonical product and
  // only its eligible offers (the same card the catalog shows).
  useEffect(() => {
    let cancelled = false;
    for (const item of shop.items) {
      const id = item.canonicalProductId;
      if (!id) continue;
      apiFetch<ComparisonCardDto>(`/canonical-products/${encodeURIComponent(id)}/comparison-card`, { auth: false })
        .then((card) => !cancelled && setProducts((p) => ({ ...p, [item.id]: { status: "ok", card } })))
        // Any failure (no offers, unknown id, network) shows "not available",
        // never a guess.
        .catch(() => !cancelled && setProducts((p) => ({ ...p, [item.id]: { status: "unavailable" } })));
    }
    return () => {
      cancelled = true;
    };
  }, [shop.items]);

  function productOf(item: ShopItem): ProductState {
    if (!item.canonicalProductId) return { status: "unmapped" };
    return products[item.id] ?? { status: "loading" };
  }

  const auto = active && !paused && !reduced;
  useEffect(() => {
    if (!auto) return;
    const wait = holds !== seenHolds.current ? IDLE_MS : AUTO_MS;
    seenHolds.current = holds;
    const id = window.setTimeout(() => {
      setSelected((s) => (s === null ? 0 : (s + 1) % items.length));
    }, wait);
    return () => window.clearTimeout(id);
  }, [auto, selected, holds, items.length]);

  function hold() {
    setHolds((h) => h + 1);
    onInteract();
  }

  function select(index: number | null) {
    hold();
    setSelected(index);
  }

  function step(delta: number) {
    hold();
    setSelected((s) => ((s ?? (delta > 0 ? -1 : 0)) + delta + items.length) % items.length);
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    hold();
    dragX.current = e.clientX;
  }
  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    if (dragX.current === null) return;
    const dx = e.clientX - dragX.current;
    dragX.current = null;
    // Physical: dragging the garments left brings the next one (to the right) forward.
    if (Math.abs(dx) >= SWIPE_PX) step(dx < 0 ? 1 : -1);
  }

  /** A piece's label: its name, then its real price and exact product link,
   *  or a quiet "not available" - never a search. */
  function renderCapsule(item: ShopItem, extraClass = "") {
    const name = t(item.nameKey);
    const product = productOf(item);
    const card = product.status === "ok" ? product.card : null;
    const multi = card ? card.store_count > 1 : false;
    const href = card
      ? multi
        ? `/compare/${card.canonical_product_id}`
        : `/store/${card.cheapest_offer.vendor_slug}/products/${card.cheapest_offer.offer_id}`
      : null;
    const price = card && card.lowest_price_availability !== "sold_out" ? `₪ ${Number.parseFloat(card.lowest_price) || card.lowest_price}` : null;
    const unavailable = product.status === "unmapped" || product.status === "unavailable" || (card !== null && !price);
    return (
      <span className={`${styles.capsule} ${extraClass}`} data-unavailable={unavailable || undefined}>
        <span className={styles.capsuleText}>
          <span className={styles.capsuleName}>{name}</span>
          {price && <span className={styles.capsuleMeta}>{price}</span>}
          {unavailable && <span className={styles.capsuleMeta}>{t("hero.s03.unavailable")}</span>}
        </span>
        {href && (
          <Link
            href={href}
            className={styles.capsuleAction}
            aria-label={t(multi ? "hero.s03.compare" : "hero.s03.view").replace("{name}", name)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </Link>
        )}
      </span>
    );
  }

  const selectedCategory: ShopCategory = selected === null ? "full" : items[selected]?.categoryKey ?? "full";
  function renderToolbar(extraClass: string) {
    return (
      <div className={`${styles.toolbar} ${extraClass}`} role="toolbar" aria-label={t("hero.s03.categories")}>
        {CATEGORIES.map((category) => {
          const index = category === "full" ? null : items.findIndex((item) => item.categoryKey === category);
          if (index === -1) return null;
          return (
            <button
              key={category}
              type="button"
              className={styles.toolbarItem}
              aria-pressed={selectedCategory === category}
              onClick={() => select(index)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d={CATEGORY_ICON[category]} /></svg>
              <span>{t(`hero.s03.cat.${category}`)}</span>
            </button>
          );
        })}
      </div>
    );
  }

  const model = getImageProps({
    src: shop.model.src,
    width: shop.model.width,
    height: shop.model.height,
    alt: t("hero.s03.alt"),
    sizes: "(max-width: 899px) 45vw, 400px",
    quality,
  });
  const selectedItem = selected === null ? null : items[selected] ?? null;

  return (
    <div
      className={styles.shop}
      data-on={state !== "hidden" || undefined}
      data-leaving={state === "leaving" || undefined}
      data-focused={selected !== null || undefined}
      aria-hidden={!active || undefined}
      inert={!active}
    >
      {/* The set behind it is the hero's own layer (shared with the closing
          scene); leaving, this whole interface fades out at once. */}
      <div className={styles.shopUi}>
      <div className={styles.shopFrame} aria-hidden="true" />

      <div
        className={styles.shopStage}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (dragX.current = null)}
        onPointerEnter={hold}
        onFocus={hold}
      >
        {shop.items.map((item, i) => {
          if (failed[item.id]) return null;
          const index = items.indexOf(item);
          const isSelected = selected === index;
          const shift = selected === null || isSelected ? 0 : Math.sign(index - selected) * 14;
          const img = getImageProps({
            src: item.image.src,
            width: item.image.width,
            height: item.image.height,
            alt: "",
            sizes: `(max-width: 899px) 96px, ${item.width}px`,
            quality,
          });
          return (
            <div
              key={item.id}
              className={styles.garment}
              data-slot={i}
              data-selected={isSelected || undefined}
              style={{
                "--w": `${item.width}px`,
                // The same width relative to a 1440px-wide screen.
                "--w-vw": `${(item.width / 14.4).toFixed(2)}vw`,
                "--cw": `${item.content.width * 100}%`,
                "--lift": `${item.content.bottomGap * 100}%`,
                "--i": i,
                "--shift": `${shift}px`,
              } as CSSProperties}
            >
              <button
                type="button"
                className={styles.garmentPick}
                aria-label={t(item.nameKey)}
                aria-pressed={isSelected}
                onClick={() => select(index)}
              >
                <span className={styles.garmentFloat}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- optimised via getImageProps */}
                  <img
                    {...img.props}
                    alt=""
                    className={styles.garmentImage}
                    draggable={false}
                    onError={() => setFailed((f) => ({ ...f, [item.id]: true }))}
                  />
                </span>
                <span className={styles.garmentRing} aria-hidden="true" />
              </button>
              {renderCapsule(item, styles.capsuleDesktop)}
            </div>
          );
        })}

        {/* eslint-disable-next-line @next/next/no-img-element -- optimised via getImageProps */}
        <img {...model.props} alt={t("hero.s03.alt")} className={styles.shopModel} draggable={false} fetchPriority="low" loading="eager" />
      </div>

      <button type="button" className={`${styles.shopArrow} ${styles.shopArrowLeft}`} onClick={() => step(-1)} aria-label={t("hero.s03.prev")}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 6-6 6 6 6" /></svg>
      </button>
      <button type="button" className={`${styles.shopArrow} ${styles.shopArrowRight}`} onClick={() => step(1)} aria-label={t("hero.s03.next")}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 6 6 6-6 6" /></svg>
      </button>

      {renderToolbar(styles.toolbarDesktop)}
      </div>

      {/* Phones: below the photo - the selected piece's label, then the
          categories (scrolling sideways inside the bar if needed). */}
      {mobileSlot &&
        createPortal(
          <div className={styles.shopMobileBar}>
            {/* Fixed-height row, so selecting a piece never moves the layout. */}
            <div className={styles.shopMobileCapsuleRow}>
              <button type="button" className={styles.shopMobileArrow} onClick={() => step(-1)} aria-label={t("hero.s03.prev")}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 6-6 6 6 6" /></svg>
              </button>
              {selectedItem && renderCapsule(selectedItem, styles.capsuleMobile)}
              <button type="button" className={styles.shopMobileArrow} onClick={() => step(1)} aria-label={t("hero.s03.next")}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 6 6 6-6 6" /></svg>
              </button>
            </div>
            {renderToolbar(styles.toolbarMobile)}
          </div>,
          mobileSlot,
        )}
    </div>
  );
}
