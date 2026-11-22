import type { StoreCatalogEntry } from '../taxonomy/store-catalog.service';
import { AUDIENCES, type TaxonomySnapshot } from '../taxonomy/taxonomy.service';
import {
  type BannerCard,
  type BlockDisplay,
  type CategoryCard,
  type FocusPoint,
  type HomeBlock,
  type HomeImage,
  type HomeLayout,
  type HomeTarget,
  type LocalText,
  MIN_SHOWN_ITEMS,
  promoLayoutFor,
  type PromoLayout,
  type PromoTile,
} from './store-home.layout';

/**
 * «الصفحة الرئيسية المرنة للمتجر»: a stored layout as shoppers see it NOW.
 * Every reference is re-checked on each read - a product must be published
 * and in stock in a sellable branch, a collection visible with such a
 * product, a category must have one, an image must still be one of this
 * store's uploads. Whatever fails is simply left out (a list block with
 * fewer than MIN_SHOWN_ITEMS left disappears; a button whose destination
 * is gone disappears, its slide stays), so the page never shows a gap.
 * The owner's screen gets the same result plus why each block shows or not.
 */

export interface ResolveContext {
  catalog: StoreCatalogEntry[];
  sections: {
    id: string;
    name: string;
    nameEn: string | null;
    coverUrl: string | null;
    isVisible: boolean;
  }[];
  taxonomy: TaxonomySnapshot;
  /** The departments the store offers (its fixed chips «نساء / رجال / أطفال»), in their order. */
  departments: string[];
  /** Whether an image URL is still usable for this store (its own upload). */
  imageUsable: (url: string) => boolean;
}

export type ProductCard = {
  id: string;
  title_ar: string;
  title_en: string;
  min_price: string | null;
  original_price: string | null;
  discount_percent: number | null;
  availability: string;
  image_url: string | null;
  favorite_variant_id: string | null;
  created_at: string;
};

type Img = { url: string; width: number | null; height: number | null };

type ResolvedCard = {
  image: Img;
  image_mobile: Img | null;
  title: LocalText;
  text: LocalText;
  target: HomeTarget | null;
  alt: LocalText;
  focus: FocusPoint;
};

type ResolvedBlockBody =
  | {
      id: string;
      type: 'hero';
      variant: 'overlay' | 'split';
      slides: {
        image: Img;
        image_mobile: Img | null;
        title: LocalText;
        text: LocalText;
        button: LocalText;
        target: HomeTarget | null;
        align: 'start' | 'center' | 'end';
        alt: LocalText;
        focus: FocusPoint;
      }[];
    }
  | (ResolvedCard & {
      id: string;
      type: 'banner';
      /** 'double' only when both cards can be shown; one complete card shows alone */
      variant: 'single' | 'double';
      second: ResolvedCard | null;
    })
  | {
      id: string;
      type: 'collections';
      title: LocalText;
      items: {
        id: string;
        name_ar: string;
        name_en: string | null;
        image_url: string | null;
        count: number;
      }[];
    }
  | {
      id: string;
      type: 'products';
      variant: 'standard' | 'side';
      title: LocalText;
      text: LocalText;
      items: ProductCard[];
    }
  | {
      id: string;
      type: 'auto_products';
      variant: 'standard' | 'side';
      title: LocalText;
      text: LocalText;
      source: 'new' | 'sale';
      items: ProductCard[];
    }
  | {
      id: string;
      type: 'categories';
      title: LocalText;
      items: {
        audience: string;
        category: string;
        name_ar: string;
        name_en: string;
        audience_ar: string;
        audience_en: string;
        image_url: string | null;
        count: number;
      }[];
    }
  | {
      id: string;
      type: 'text';
      style: 'text' | 'divider';
      title: LocalText;
      text: LocalText;
    };

/** Where a category card leads: a department, or a category in it. */
export type CardTarget =
  | { kind: 'audience'; audience: string }
  | { kind: 'category'; audience: string; category: string };

export type ResolvedCategoryCards = {
  id: string;
  type: 'category_cards';
  shape: 'circle' | 'square' | 'portrait';
  title: LocalText;
  items: {
    target: CardTarget;
    image: Img;
    title: LocalText;
    text: LocalText;
    alt: LocalText;
    focus: FocusPoint;
  }[];
};

export type ResolvedPromoGrid = {
  id: string;
  type: 'promo_grid';
  /** the layout for the tiles shown (the stored one when it suits their count) */
  layout: PromoLayout;
  share: number;
  divider: 'gap' | 'straight' | 'slant' | 'wave';
  tiles: {
    image: Img;
    title: LocalText;
    text: LocalText;
    button: LocalText;
    target: HomeTarget | null;
    alt: LocalText;
    focus: FocusPoint;
  }[];
};

export type ResolvedBlock = (
  ResolvedBlockBody | ResolvedCategoryCards | ResolvedPromoGrid
) & {
  display?: BlockDisplay;
};

/** Why a block is (not) shown to shoppers - for the owner's screen only. */
export type BlockReview = {
  shown: boolean;
  /** incomplete: a double banner with no card that has its image, text and destination */
  reason: null | 'hidden' | 'too_few' | 'no_image' | 'retired' | 'incomplete';
  /** items shoppers can see now (list blocks), slides (hero) */
  shown_items: number;
};

/** Block types kept readable for saved layouts but no longer shown or offered. */
export const RETIRED_BLOCKS: ReadonlySet<string> = new Set(['categories']);

/** Arabic is the shopper's fallback: a text typed only in English shows in both. */
function lt(t: LocalText): LocalText {
  return t.ar ? t : { ar: t.en, en: t.en };
}

function card(e: StoreCatalogEntry): ProductCard {
  const c = e.card;
  return {
    id: c.id,
    title_ar: c.title_ar,
    title_en: c.title_en,
    min_price: c.min_price,
    original_price: c.original_price,
    discount_percent: c.discount_percent,
    availability: c.availability,
    image_url: c.image_url,
    favorite_variant_id: c.favorite_variant_id,
    created_at: c.created_at,
  };
}

export class HomeResolver {
  private readonly buyable: StoreCatalogEntry[];
  private readonly byId: Map<string, StoreCatalogEntry>;
  private readonly sectionById: Map<string, ResolveContext['sections'][number]>;

  constructor(private readonly ctx: ResolveContext) {
    // the catalogue is newest first already
    this.buyable = ctx.catalog.filter((e) => e.available > 0);
    this.byId = new Map(this.buyable.map((e) => [e.catalog.id, e]));
    this.sectionById = new Map(ctx.sections.map((s) => [s.id, s]));
  }

  /** A product shoppers can buy now. */
  product(id: string): StoreCatalogEntry | null {
    return this.byId.get(id) ?? null;
  }

  /** A visible collection's buyable products, in the owner's order inside it. */
  collectionProducts(id: string): StoreCatalogEntry[] {
    const s = this.sectionById.get(id);
    if (!s || !s.isVisible) return [];
    return this.buyable
      .filter((e) => e.sectionIds.has(id))
      .sort(
        (a, b) =>
          (a.sectionOrder.get(id) ?? Number.MAX_SAFE_INTEGER) -
          (b.sectionOrder.get(id) ?? Number.MAX_SAFE_INTEGER),
      );
  }

  /** A category is valid for the department in the fixed taxonomy. */
  categoryKnown(audience: string, category: string): boolean {
    return (
      this.ctx.taxonomy.categoryAudiences
        .get(category)
        ?.has(audience as never) ?? false
    );
  }

  /** The store's departments (its fixed chips), in their order. */
  departments(): string[] {
    return this.ctx.departments;
  }

  /**
   * A promo tile as shoppers see it, or null: COMPLETE only - its image
   * (this store's own, still there), an Arabic title, and a button label and
   * a destination together or neither. A destination that does not lead
   * anywhere now hides the button only (the tile stays).
   */
  promoTile(tile: PromoTile) {
    const image = this.img(tile.image);
    if (!image || !tile.title.ar) return null;
    const hasButton = !!(tile.button.ar || tile.button.en);
    if (hasButton !== !!tile.target) return null;
    const target = this.target(tile.target);
    const button = lt(tile.button);
    return {
      image,
      title: { ar: tile.title.ar, en: tile.title.en || tile.title.ar },
      text: lt(tile.text),
      button: target ? button : { ar: '', en: '' },
      target,
      alt: lt(tile.alt),
      focus: tile.focus,
    };
  }

  /** A department's products shoppers can buy now. */
  audienceProducts(audience: string): StoreCatalogEntry[] {
    return this.buyable.filter((e) =>
      e.catalog.audiences.includes(audience as never),
    );
  }

  /** The departments with products shoppers can buy now (a card's choices). */
  audienceOptions() {
    return AUDIENCES.map((a) => ({
      audience: a.code as string,
      name_ar: a.nameAr,
      name_en: a.nameEn,
      count: this.audienceProducts(a.code).length,
    })).filter((a) => a.count > 0);
  }

  /**
   * A category card as shoppers see it, or null: its image (this store's
   * own, still there), its Arabic title, and a destination that leads to
   * products shoppers can buy now. Never a card that leads nowhere.
   */
  categoryCard(c: CategoryCard) {
    const image = this.img(c.image);
    const title = c.title.ar
      ? { ar: c.title.ar, en: c.title.en || c.title.ar }
      : null;
    if (!image || !title) return null;
    const target: CardTarget | null = c.category
      ? this.categoryProducts(c.audience, c.category).length > 0
        ? { kind: 'category', audience: c.audience, category: c.category }
        : null
      : this.audienceProducts(c.audience).length > 0
        ? { kind: 'audience', audience: c.audience }
        : null;
    if (!target) return null;
    return {
      target,
      image,
      title,
      text: lt(c.text),
      alt: lt(c.alt),
      focus: c.focus,
    };
  }

  categoryProducts(audience: string, category: string): StoreCatalogEntry[] {
    if (!this.categoryKnown(audience, category)) return [];
    return this.buyable.filter(
      (e) =>
        e.catalog.audiences.includes(audience as never) &&
        e.catalog.categories.includes(category),
    );
  }

  autoProducts(source: 'new' | 'sale'): StoreCatalogEntry[] {
    return this.buyable.filter((e) => (source === 'new' ? e.isNew : e.isSale));
  }

  /** The store's categories with products shoppers can buy now (the owner's choices). */
  categoryOptions() {
    const count = new Map<string, number>();
    for (const e of this.buyable) {
      for (const a of e.catalog.audiences) {
        for (const c of e.catalog.categories) {
          if (!this.categoryKnown(a, c)) continue;
          const k = `${a}/${c}`;
          count.set(k, (count.get(k) ?? 0) + 1);
        }
      }
    }
    const audienceOrder = AUDIENCES.map((a) => a.code as string);
    const categoryOrder = this.ctx.taxonomy.categories.map((c) => c.code);
    return [...count.entries()]
      .map(([k, n]) => {
        const [audience, category] = k.split('/');
        return { ...this.categoryNames(audience, category), count: n };
      })
      .sort(
        (a, b) =>
          audienceOrder.indexOf(a.audience) -
            audienceOrder.indexOf(b.audience) ||
          categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category),
      );
  }

  categoryNames(audience: string, category: string) {
    const c = this.ctx.taxonomy.categories.find((x) => x.code === category);
    const a = AUDIENCES.find((x) => x.code === audience);
    return {
      audience,
      category,
      name_ar: c?.nameAr ?? category,
      name_en: c?.nameEn ?? category,
      audience_ar: a?.nameAr ?? audience,
      audience_en: a?.nameEn ?? audience,
    };
  }

  /** A destination that still leads somewhere, else null. */
  target(t: HomeTarget | null): HomeTarget | null {
    if (!t) return null;
    switch (t.kind) {
      case 'products':
        return t;
      case 'new':
      case 'sale':
        return this.autoProducts(t.kind).length > 0 ? t : null;
      case 'collection':
        return this.collectionProducts(t.id).length > 0 ? t : null;
      case 'product':
        return this.product(t.id) ? t : null;
      case 'category':
        return this.categoryProducts(t.audience, t.category).length > 0
          ? t
          : null;
    }
  }

  private img(i: HomeImage | null): Img | null {
    if (!i || !this.ctx.imageUsable(i.url)) return null;
    return { url: i.url, width: i.width, height: i.height };
  }

  /**
   * A banner card as shoppers see it, or null. A single banner needs only
   * its image (its text and destination are optional, as before); a card of
   * the double banner is shown only COMPLETE - image, a title or text, and a
   * destination that still leads somewhere.
   */
  private card(c: BannerCard, complete: boolean): ResolvedCard | null {
    const image = this.img(c.image);
    if (!image) return null;
    const out: ResolvedCard = {
      image,
      image_mobile: this.img(c.image_mobile),
      title: lt(c.title),
      text: lt(c.text),
      target: this.target(c.target),
      alt: lt(c.alt),
      focus: c.focus,
    };
    if (complete && (!out.target || !(out.title.ar || out.text.ar))) {
      return null;
    }
    return out;
  }

  /** One block as shoppers see it (null: not shown) and why - hidden by the owner first. */
  block(b: HomeBlock): { out: ResolvedBlock | null; review: BlockReview } {
    const computed = this.compute(b);
    // its display choices travel with it (normalised by the validator)
    const r = computed.out
      ? { ...computed, out: { ...computed.out, display: b.display } }
      : computed;
    if (!b.visible) {
      return {
        out: null,
        review: {
          shown: false,
          reason: 'hidden',
          shown_items: r.review.shown_items,
        },
      };
    }
    return r;
  }

  private compute(b: HomeBlock): {
    out: ResolvedBlock | null;
    review: BlockReview;
  } {
    const few = (n: number) => ({
      out: null,
      review: { shown: false, reason: 'too_few' as const, shown_items: n },
    });
    let out: ResolvedBlock | null = null;
    let items = 0;
    switch (b.type) {
      case 'hero': {
        const slides = b.slides.flatMap((s) => {
          const image = this.img(s.image);
          if (!image) return [];
          // the button shows only with a label AND a destination that still leads somewhere
          const button = lt(s.button);
          const target = button.ar ? this.target(s.target) : null;
          return [
            {
              image,
              image_mobile: this.img(s.image_mobile),
              title: lt(s.title),
              text: lt(s.text),
              button: target ? button : { ar: '', en: '' },
              target,
              align: s.align,
              alt: lt(s.alt),
              focus: s.focus,
            },
          ];
        });
        if (slides.length === 0) {
          return {
            out: null,
            review: { shown: false, reason: 'no_image', shown_items: 0 },
          };
        }
        out = { id: b.id, type: 'hero', variant: b.variant, slides };
        items = slides.length;
        break;
      }
      case 'banner': {
        if (b.variant === 'double') {
          const cards = [b, b.second]
            .map((c) => (c ? this.card(c, true) : null))
            .filter((c): c is ResolvedCard => !!c);
          if (cards.length === 0) {
            const anyImage = [b, b.second].some((c) => c && this.img(c.image));
            return {
              out: null,
              review: {
                shown: false,
                reason: anyImage ? 'incomplete' : 'no_image',
                shown_items: 0,
              },
            };
          }
          out = {
            id: b.id,
            type: 'banner',
            ...cards[0],
            variant: cards.length === 2 ? 'double' : 'single',
            second: cards[1] ?? null,
          };
          items = cards.length;
          break;
        }
        const first = this.card(b, false);
        if (!first) {
          return {
            out: null,
            review: { shown: false, reason: 'no_image', shown_items: 0 },
          };
        }
        out = {
          id: b.id,
          type: 'banner',
          ...first,
          variant: 'single',
          second: null,
        };
        items = 1;
        break;
      }
      case 'collections': {
        const list = b.collection_ids.flatMap((id) => {
          const products = this.collectionProducts(id);
          if (products.length === 0) return [];
          const s = this.sectionById.get(id)!;
          const cover =
            s.coverUrl && this.ctx.imageUsable(s.coverUrl) ? s.coverUrl : null;
          return [
            {
              id,
              name_ar: s.name,
              name_en: s.nameEn,
              image_url:
                cover ??
                products.map((p) => p.card.image_url).find((u) => u) ??
                null,
              count: products.length,
            },
          ];
        });
        if (list.length < MIN_SHOWN_ITEMS) return few(list.length);
        out = {
          id: b.id,
          type: 'collections',
          title: lt(b.title),
          items: list,
        };
        items = list.length;
        break;
      }
      case 'products': {
        const list = b.offer_ids
          .map((id) => this.product(id))
          .filter((e): e is StoreCatalogEntry => !!e)
          .map(card);
        if (list.length < MIN_SHOWN_ITEMS) return few(list.length);
        out = {
          id: b.id,
          type: 'products',
          variant: b.variant,
          title: lt(b.title),
          text: lt(b.text),
          items: list,
        };
        items = list.length;
        break;
      }
      case 'auto_products': {
        const list = this.autoProducts(b.source).slice(0, b.count).map(card);
        if (list.length < MIN_SHOWN_ITEMS) return few(list.length);
        out = {
          id: b.id,
          type: 'auto_products',
          variant: b.variant,
          title: lt(b.title),
          text: lt(b.text),
          source: b.source,
          items: list,
        };
        items = list.length;
        break;
      }
      case 'categories': {
        // Retired (2026-11-20): «استكشفي التصنيفات» under the store's
        // identity shows the categories on every store page - a saved block
        // is kept (the owner may delete it) but never shown, so the fixed
        // categories never appear twice.
        if (RETIRED_BLOCKS.has(b.type)) {
          return {
            out: null,
            review: { shown: false, reason: 'retired', shown_items: 0 },
          };
        }
        const list = b.items.flatMap((x) => {
          const products = this.categoryProducts(x.audience, x.category);
          if (products.length === 0) return [];
          return [
            {
              ...this.categoryNames(x.audience, x.category),
              image_url:
                products.map((p) => p.card.image_url).find((u) => u) ?? null,
              count: products.length,
            },
          ];
        });
        if (list.length < MIN_SHOWN_ITEMS) return few(list.length);
        out = { id: b.id, type: 'categories', title: lt(b.title), items: list };
        items = list.length;
        break;
      }
      case 'promo_grid': {
        // «لوحة ترويجية»: complete tiles only, at least two, in a layout that suits their count
        const tiles = b.tiles
          .map((tile) => this.promoTile(tile))
          .filter((tile): tile is NonNullable<typeof tile> => !!tile);
        if (tiles.length < MIN_SHOWN_ITEMS) return few(tiles.length);
        out = {
          id: b.id,
          type: 'promo_grid',
          layout: promoLayoutFor(b.layout, tiles.length),
          share: b.share,
          divider: b.divider,
          tiles,
        };
        items = tiles.length;
        break;
      }
      case 'category_cards': {
        // «بطاقات التصنيفات»: complete cards only, at least two
        const list = b.items
          .map((c) => this.categoryCard(c))
          .filter((c): c is NonNullable<typeof c> => !!c);
        if (list.length < MIN_SHOWN_ITEMS) return few(list.length);
        out = {
          id: b.id,
          type: 'category_cards',
          shape: b.shape,
          title: lt(b.title),
          items: list,
        };
        items = list.length;
        break;
      }
      case 'text': {
        const title = lt(b.title);
        const text = lt(b.text);
        // an empty text block is unfinished: not shown
        if (b.style === 'text' && !title.ar && !text.ar) return few(0);
        out = { id: b.id, type: 'text', style: b.style, title, text };
        items = 1;
        break;
      }
    }
    return { out, review: { shown: true, reason: null, shown_items: items } };
  }

  layout(layout: Pick<HomeLayout, 'blocks'>) {
    const blocks: ResolvedBlock[] = [];
    const review: Record<string, BlockReview> = {};
    for (const b of layout.blocks) {
      const r = this.block(b);
      review[b.id] = r.review;
      if (r.out) blocks.push(r.out);
    }
    return { blocks, review };
  }
}
