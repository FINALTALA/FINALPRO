import {
  type BannerCard,
  type HomeBlock,
  type HomeLayout,
  type HomeTarget,
  type LocalText,
  type OwnerHome,
  type ResolvedBlock,
  type ShownCard,
  displayOf,
  promoLayoutFor,
} from "./storeHome";

/**
 * The designer's LIVE preview (2026-11-21): the owner's local draft drawn at
 * once - text, images, order, show/hide and display choices change the
 * preview on the next render, before the autosave answers. What only the
 * server can know (which products / collections shoppers can buy now) comes
 * from the last saved preview (`data.preview`, the shoppers' own rules),
 * re-ordered and filtered by the local choices; a list block not saved yet
 * appears once the autosave returns. Nothing here decides what shoppers
 * see - the published page is always resolved by the API.
 */

/** Arabic is the shopper's fallback: text typed only in English shows in both (the API's own rule). */
function lt(t: LocalText): LocalText {
  return t.ar ? t : { ar: t.en, en: t.en };
}

function targetLeads(t: HomeTarget | null, data: OwnerHome, known: Map<string, { status: string }>): HomeTarget | null {
  if (!t) return null;
  switch (t.kind) {
    case "products":
      return t;
    case "new":
      return data.options.new_count > 0 ? t : null;
    case "sale":
      return data.options.sale_count > 0 ? t : null;
    case "collection":
      return data.options.collections.some((c) => c.id === t.id && c.visible && c.count > 0) ? t : null;
    case "category":
      return data.options.categories.some((c) => c.audience === t.audience && c.category === t.category) ? t : null;
    case "audience":
      return (data.options.audiences ?? []).some((a) => a.audience === t.audience) ? t : null;
    case "product": {
      const s = data.refs.offers[t.id]?.status ?? known.get(t.id)?.status;
      return s === "ok" ? t : null;
    }
  }
}

export function livePreview(layout: HomeLayout, data: OwnerHome, known: Map<string, { status: string }>): ResolvedBlock[] {
  const saved = new Map(data.preview.blocks.map((b) => [b.id, b]));
  const min = data.min_shown_items;
  const keys = data.display?.keys;
  const imageOk = (url: string) => data.refs.images[url] !== "missing";
  const shown = (i: { url: string; width: number | null; height: number | null } | null) => (i && imageOk(i.url) ? { url: i.url, width: i.width, height: i.height } : null);
  // the API's banner-card rule: a double banner's card shows only complete
  const card = (c: BannerCard | null | undefined, complete: boolean): ShownCard | null => {
    const image = c ? shown(c.image) : null;
    if (!c || !image) return null;
    const out: ShownCard = { image, image_mobile: shown(c.image_mobile), title: lt(c.title), text: lt(c.text), target: targetLeads(c.target, data, known), alt: lt(c.alt), focus: c.focus ?? "center" };
    return complete && (!out.target || !(out.title.ar || out.text.ar)) ? null : out;
  };
  const out: ResolvedBlock[] = [];
  for (const b of layout.blocks as HomeBlock[]) {
    if (!b.visible) continue;
    const display = displayOf(b.type, b.display, keys);
    const server = saved.get(b.id);
    switch (b.type) {
      case "hero": {
        const slides = b.slides.flatMap((s) => {
          const image = shown(s.image);
          if (!image) return [];
          const button = lt(s.button);
          const target = button.ar ? targetLeads(s.target, data, known) : null;
          return [
            {
              image,
              image_mobile: shown(s.image_mobile),
              title: lt(s.title),
              text: lt(s.text),
              button: target ? button : { ar: "", en: "" },
              target,
              align: s.align,
              alt: lt(s.alt),
              focus: s.focus ?? "center",
            },
          ];
        });
        if (slides.length) out.push({ id: b.id, type: "hero", variant: b.variant ?? "overlay", slides, display });
        break;
      }
      case "banner": {
        const double = b.variant === "double";
        const cards = (double ? [card(b, true), card(b.second, true)] : [card(b, false)]).filter((c): c is ShownCard => !!c);
        if (cards.length) out.push({ id: b.id, type: "banner", ...cards[0], variant: cards.length === 2 ? "double" : "single", second: cards[1] ?? null, display });
        break;
      }
      case "text": {
        const title = lt(b.title);
        const text = lt(b.text);
        if (b.style === "divider" || title.ar || text.ar) out.push({ id: b.id, type: "text", style: b.style, title, text, display });
        break;
      }
      case "products":
        if (server?.type === "products") {
          const byId = new Map(server.items.map((i) => [i.id, i]));
          const items = b.offer_ids.map((id) => byId.get(id)).filter((i): i is NonNullable<typeof i> => !!i);
          if (items.length >= min) out.push({ ...server, variant: b.variant ?? "standard", title: lt(b.title), text: lt(b.text ?? { ar: "", en: "" }), items, display });
        }
        break;
      case "collections":
        if (server?.type === "collections") {
          const byId = new Map(server.items.map((i) => [i.id, i]));
          const items = b.collection_ids.map((id) => byId.get(id)).filter((i): i is NonNullable<typeof i> => !!i);
          if (items.length >= min) out.push({ ...server, title: lt(b.title), items, display });
        }
        break;
      case "auto_products":
        if (server?.type === "auto_products" && server.source === b.source) {
          const items = server.items.slice(0, b.count);
          if (items.length >= min) out.push({ ...server, variant: b.variant ?? "standard", title: lt(b.title), text: lt(b.text ?? { ar: "", en: "" }), items, display });
        }
        break;
      case "categories":
        // retired: never shown (the categories are in «استكشفي التصنيفات»)
        break;
      case "promo_grid": {
        // the API's rule: complete tiles only (image, Arabic title, a button and its destination together or neither)
        const tiles = b.tiles.flatMap((tile) => {
          const image = shown(tile.image);
          const hasButton = !!(tile.button.ar || tile.button.en);
          if (!image || !tile.title.ar || hasButton !== !!tile.target) return [];
          const target = targetLeads(tile.target, data, known);
          return [{ image, title: { ar: tile.title.ar, en: tile.title.en || tile.title.ar }, text: lt(tile.text), button: target ? lt(tile.button) : { ar: "", en: "" }, target, alt: lt(tile.alt), focus: tile.focus ?? "center" }];
        });
        if (tiles.length >= min) out.push({ id: b.id, type: "promo_grid", layout: promoLayoutFor(b.layout, tiles.length), share: b.share, divider: b.divider, tiles, display });
        break;
      }
      case "category_cards": {
        // the API's rule: image, an Arabic title and a destination with products now; at least two
        const items = b.items.flatMap((c) => {
          const image = shown(c.image);
          const target = targetLeads(c.category ? { kind: "category", audience: c.audience, category: c.category } : { kind: "audience", audience: c.audience }, data, known);
          if (!image || !c.title.ar || !target || (target.kind !== "audience" && target.kind !== "category")) return [];
          return [{ target, image, title: { ar: c.title.ar, en: c.title.en || c.title.ar }, text: lt(c.text), alt: lt(c.alt), focus: c.focus ?? "center" }];
        });
        if (items.length >= min) out.push({ id: b.id, type: "category_cards", shape: b.shape, title: lt(b.title), items, display });
        break;
      }
    }
  }
  return out;
}
