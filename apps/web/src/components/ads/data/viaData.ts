"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { ComparisonCardDto } from "@/lib/types";
import type { AdsCategory, AdsStore, FeaturedStore } from "./adsDemo";

// Live Via data for the Advertising page, from existing public endpoints
// only (no new API):
//  - GET /discovery/stores[?segment=]     published + active stores
//  - GET /storefronts/:slug               store identity (cover, logo)
//  - GET /discovery/all?filter=discounts  products discounted right now
//  - GET /storefronts/:slug/offers/:id    the offer's base vs sale price

type StoreRow = { slug: string; display_name: string; logo_url: string | null; bio: string | null };
type Storefront = { slug: string; display_name: string; logo_url: string | null; cover_image_url: string | null; is_available: boolean };

const SEGMENT_OF: Partial<Record<AdsCategory, string>> = { Women: "women", Men: "men", Kids: "kids", Accessories: "accessories" };
const SEGMENT_LABEL: Record<string, { ar: string; en: string }> = {
  women: { ar: "نساء", en: "Women" },
  men: { ar: "رجال", en: "Men" },
  kids: { ar: "أطفال", en: "Kids" },
  accessories: { ar: "إكسسوارات", en: "Accessories" },
};

const monogramOf = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "V";

/** Real Via stores with a storefront cover, shaped as Featured Stores. A
 *  store's categories are the segments the discovery API lists it under. */
export function useViaFeaturedStores(): { stores: FeaturedStore[]; ready: boolean } {
  const [state, setState] = useState<{ stores: FeaturedStore[]; ready: boolean }>({ stores: [], ready: false });
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // Store list and segment lists in parallel, then the storefronts.
        const [all, segs] = await Promise.all([
          apiFetch<{ items: StoreRow[] }>("/discovery/stores?limit=24", { auth: false }),
          Promise.all(
            Object.values(SEGMENT_OF).map(async (seg) => [seg!, (await apiFetch<{ items: StoreRow[] }>(`/discovery/stores?segment=${seg}&limit=50`, { auth: false })).items.map((s) => s.slug)] as const),
          ),
        ]);
        const fronts = await Promise.all(all.items.map((s) => apiFetch<Storefront>(`/storefronts/${s.slug}`, { auth: false }).catch(() => null)));
        const stores: FeaturedStore[] = [];
        all.items.forEach((s, k) => {
          const f = fronts[k];
          if (!f || !f.cover_image_url || !f.is_available) return;
          const mine = segs.filter(([, slugs]) => slugs.includes(s.slug)).map(([seg]) => seg);
          const cats = (Object.keys(SEGMENT_OF) as AdsCategory[]).filter((c) => mine.includes(SEGMENT_OF[c]!));
          const name = f.display_name || s.display_name;
          const store: AdsStore = { id: `via-${s.slug}`, slug: s.slug, demo: false, monogram: monogramOf(name), logo: f.logo_url, name: { ar: name, en: name } };
          stores.push({
            store,
            cover: f.cover_image_url,
            coverAlt: { ar: `غلاف متجر ${name}`, en: `${name} storefront cover` },
            categories: cats,
            categoryLabels: { ar: mine.map((m) => SEGMENT_LABEL[m].ar), en: mine.map((m) => SEGMENT_LABEL[m].en) },
            sponsored: false, // no paid store placements exist yet
          });
        });
        if (alive) setState({ stores, ready: true });
      } catch {
        if (alive) setState({ stores: [], ready: true });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

// ---------------------------------------------------------------- offers
export type ViaOffer = {
  id: string;
  name: { ar: string; en: string };
  image: string | null;
  category: string | null;
  store: AdsStore;
  percent: number;      // highest real discount on the offer's variants
  now: number;          // effective price (₪)
  was: number;          // base price (₪)
  href: string;         // the product page on Via
};

type OfferDetail = { variants: { base_price: string; sale_price: string | null }[] };

/** Products discounted right now (optionally in one segment), with the real
 *  discount of each, highest first, alternating stores. Up to `limit`. */
export async function loadViaOffers(segment: string | null, limit: number): Promise<ViaOffer[]> {
  const q = new URLSearchParams({ filter: "discounts", page_size: "40" });
  if (segment) q.set("segment", segment);
  const page = await apiFetch<{ items: ComparisonCardDto[] }>(`/discovery/all?${q}`, { auth: false });
  // The discounted offer may not be the product's cheapest one: take the
  // store entry the API flags as discounted.
  const rows = page.items
    .filter((c) => c.has_discount)
    .flatMap((c) => c.store_logos.filter((l) => l.is_discounted).map((l) => ({ c, l })));
  // Interleave candidates by store, then read offer details in small
  // batches until the board is full (the API is rate limited per visitor).
  const queues = new Map<string, typeof rows>();
  for (const r of rows) queues.set(r.l.vendor_slug, [...(queues.get(r.l.vendor_slug) ?? []), r]);
  const order: typeof rows = [];
  while ([...queues.values()].some((q) => q.length)) for (const q of queues.values()) { const r = q.shift(); if (r) order.push(r); }

  const toOffer = async ({ c, l }: (typeof rows)[number]): Promise<ViaOffer | null> => {
    const { vendor_slug: slug, offer_id: offerId } = l;
    const d = await apiFetch<OfferDetail>(`/storefronts/${slug}/offers/${offerId}`, { auth: false }).catch(() => null);
    const best = (d?.variants ?? [])
      .filter((v) => v.sale_price != null)
      .map((v) => ({ was: Number(v.base_price), now: Number(v.sale_price) }))
      .filter((v) => v.was > 0 && v.now < v.was)
      .sort((x, y) => y.was - y.now - (x.was - x.now))[0];
    if (!best) return null;
    const storeName = l.display_name || slug;
    return {
      id: `${c.canonical_product_id}-${slug}`,
      name: { ar: c.canonical_name_ar, en: c.canonical_name_en || c.canonical_name_ar },
      image: c.image_url,
      category: c.category_name,
      store: { id: `via-${slug}`, slug, demo: false, monogram: monogramOf(storeName), logo: l.logo_url, name: { ar: storeName, en: storeName } },
      percent: Math.round((1 - best.now / best.was) * 100),
      now: best.now,
      was: best.was,
      href: `/store/${slug}/products/${offerId}`,
    };
  };

  const found: ViaOffer[] = [];
  const BATCH = limit + 2;
  for (let i = 0; i < order.length && found.length < limit && i < limit * 4; i += BATCH) {
    const got = await Promise.all(order.slice(i, i + BATCH).map(toOffer));
    found.push(...got.filter((o): o is ViaOffer => !!o));
  }
  // Highest discount first, keeping stores alternating where possible.
  return found.sort((x, y) => y.percent - x.percent).slice(0, limit);
}

export { SEGMENT_OF };
