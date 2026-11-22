import {
  EMPTY_CARD,
  type HomeBlock,
  type HomeLayout,
  type HomeStyle,
  type HomeTarget,
  type HomeTemplate,
  type LocalText,
  NO_TEXT,
  type OwnerHome,
  type PickerProduct,
  displayOf,
  newBlockId,
} from "./storeHome";

/**
 * «القوالب الجاهزة» (2026-11-21): four starting structures built from the
 * blocks that already exist, filled with the store's REAL things only - its
 * collections, categories, new arrivals, sale and buyable products. Nothing
 * invented is ever publishable: an image is left as an empty place
 * («أضيفي صورة», never shown and reported by «فحص قبل النشر»), a list the
 * store cannot fill (fewer than two collections or products) is left out,
 * and the texts are plain section labels the owner edits.
 *
 * A template decides the STRUCTURE only; the page's style is kept as it is
 * (the two are independent). It replaces the DRAFT (after the owner's
 * explicit confirmation when the draft has blocks) - never what is published.
 */

const T = (ar: string, en: string): LocalText => ({ ar, en });

type Ctx = { data: OwnerHome; products: PickerProduct[] };

function hero(variant: "overlay" | "split", title: LocalText, button: LocalText, target: HomeTarget, height: "medium" | "wide" = "medium"): HomeBlock {
  return {
    id: newBlockId(),
    type: "hero",
    visible: true,
    variant,
    display: { ...displayOf("hero", undefined), height },
    slides: [{ image: null, image_mobile: null, title, text: NO_TEXT, button, target, align: "start", alt: NO_TEXT, focus: "center" }],
  };
}
function banner(target: HomeTarget, title: LocalText = NO_TEXT): HomeBlock {
  return { id: newBlockId(), type: "banner", visible: true, variant: "single", display: displayOf("banner", undefined), ...EMPTY_CARD, title, target, second: null };
}
function doubleBanner(a: { title: LocalText; target: HomeTarget }, b: { title: LocalText; target: HomeTarget }): HomeBlock {
  return {
    id: newBlockId(),
    type: "banner",
    visible: true,
    variant: "double",
    display: displayOf("banner", undefined),
    ...EMPTY_CARD,
    title: a.title,
    target: a.target,
    second: { ...EMPTY_CARD, title: b.title, target: b.target },
  };
}
function auto(source: "new" | "sale", ctx: Ctx, variant: "standard" | "side" = "standard", text: LocalText = NO_TEXT, count = 8): HomeBlock | null {
  const n = source === "new" ? ctx.data.options.new_count : ctx.data.options.sale_count;
  if (n < ctx.data.min_shown_items) return null;
  return { id: newBlockId(), type: "auto_products", visible: true, variant, display: displayOf("auto_products", undefined), title: NO_TEXT, text, source, count };
}
function collections(ctx: Ctx): HomeBlock | null {
  const ids = ctx.data.options.collections.filter((c) => c.visible && c.count > 0).slice(0, ctx.data.limits.collections).map((c) => c.id);
  if (ids.length < ctx.data.min_shown_items) return null;
  return { id: newBlockId(), type: "collections", visible: true, display: displayOf("collections", undefined), title: NO_TEXT, collection_ids: ids };
}
function picked(ctx: Ctx, variant: "standard" | "side", text: LocalText): HomeBlock | null {
  const ids = ctx.products.filter((p) => p.status === "ok").slice(0, 8).map((p) => p.id);
  if (ids.length < ctx.data.min_shown_items) return null;
  return { id: newBlockId(), type: "products", visible: true, variant, display: displayOf("products", undefined), title: NO_TEXT, text, offer_ids: ids };
}
function text(title: LocalText): HomeBlock {
  return { id: newBlockId(), type: "text", visible: true, style: "text", display: displayOf("text", undefined), title, text: NO_TEXT };
}
function divider(): HomeBlock {
  return { id: newBlockId(), type: "text", visible: true, style: "divider", display: displayOf("text", undefined), title: NO_TEXT, text: NO_TEXT };
}

/** A destination that leads somewhere in THIS store now, else all products. */
function lead(ctx: Ctx, want: HomeTarget): HomeTarget {
  const o = ctx.data.options;
  if (want.kind === "new" && o.new_count === 0) return { kind: "products" };
  if (want.kind === "sale" && o.sale_count === 0) return { kind: "products" };
  return want;
}
function kidsTarget(ctx: Ctx): HomeTarget {
  const c = ctx.data.options.categories.find((x) => x.audience === "KIDS");
  return c ? { kind: "category", audience: c.audience, category: c.category } : { kind: "products" };
}

const BUILD: Record<HomeTemplate, (ctx: Ctx) => (HomeBlock | null)[]> = {
  // أزياء راقٍ: a split hero, the collections, a strip of chosen pieces, a banner, new arrivals
  luxe: (ctx) => [
    hero("split", T("تشكيلة مختارة", "A curated edit"), T("اكتشفي الجديد", "Discover what's new"), lead(ctx, { kind: "new" }), "wide"),
    collections(ctx),
    picked(ctx, "side", T("قطع مختارة من المتجر.", "Pieces chosen from the store.")),
    banner({ kind: "products" }),
    auto("new", ctx),
  ],
  // تخفيضات وعروض: a hero to the sale, the sale, two promo cards, new arrivals, the collections
  sale: (ctx) => [
    hero("overlay", T("تخفيضات المتجر", "Store sale"), T("تسوّقي التخفيضات", "Shop the sale"), lead(ctx, { kind: "sale" })),
    auto("sale", ctx, "standard", NO_TEXT, 12),
    doubleBanner({ title: T("العروض", "Offers"), target: lead(ctx, { kind: "sale" }) }, { title: T("وصل حديثاً", "New in"), target: lead(ctx, { kind: "new" }) }),
    auto("new", ctx, "side", T("آخر ما وصل إلى المتجر.", "The latest arrivals in the store.")),
    collections(ctx),
  ],
  // أطفال: a hero to the kids' department, the collections, new arrivals, a banner
  kids: (ctx) => [
    hero("overlay", T("للأطفال", "For kids"), T("تسوّقي الآن", "Shop now"), kidsTarget(ctx)),
    collections(ctx),
    auto("new", ctx),
    banner(kidsTarget(ctx)),
  ],
  // بسيط وهادئ: a welcome line, new arrivals, a divider, chosen pieces or the collections
  minimal: (ctx) => [
    text(T("أهلاً بكِ", "Welcome")),
    auto("new", ctx),
    divider(),
    picked(ctx, "standard", NO_TEXT) ?? collections(ctx),
  ],
};

/** The template's draft: its blocks, the page's current style kept (independent). */
export function buildTemplate(template: HomeTemplate, ctx: Ctx, style: HomeStyle | undefined): HomeLayout {
  const blocks = BUILD[template](ctx).filter((b): b is HomeBlock => !!b);
  return { style: style ?? "default", template, blocks };
}

/** What a template holds, for its card (block types in order, before the store's data trims it). */
export const TEMPLATE_OUTLINE: Record<HomeTemplate, string[]> = {
  luxe: ["hero-split", "collections", "products-side", "banner", "auto_products"],
  sale: ["hero", "auto_products", "banner-double", "auto_products-side", "collections"],
  kids: ["hero", "collections", "auto_products", "banner"],
  minimal: ["text", "auto_products", "divider", "products"],
};
