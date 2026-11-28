"use client";

import { useMemo } from "react";
import {
  linkOf,
  mediaOf,
  mediaUrl,
  overlayItems,
  pickText,
  refOf,
  useManagedSection,
  type ManagedRef,
  type ManagedValue,
  type SectionMode,
} from "@/lib/contentStudio";
import {
  DEMO_FEATURED_STORES,
  FEATURED_ADS,
  HERO_SLIDES,
  REELS,
  STORY_GROUPS,
  type AdsStore,
  type FeaturedAd,
  type FeaturedStore,
  type HeroSlide,
  type Reel,
  type StoryGroup,
} from "./data/adsDemo";

// VIA phase 6 - the editorial Ads page under the Content Studio. Each
// section keeps its own renderer and design; these hooks lay the managed
// items over the built-in ones (see overlayItems): an item with a built-in
// id keeps that item's layout (text box, crop, tone, row/span) and takes
// the managed copy, media, links and store; a new item uses the section's
// first built-in item as its layout template. A bundled default image keeps
// its responsive srcSet; any other image is served as one URL.
// Paid campaigns are out of scope here (deferred): these are editorial
// placements only, and the Offers block stays the live catalogue.

const bi = (v: ManagedValue | undefined, base: { ar: string; en: string }) => ({
  ar: pickText(v, "ar", base.ar),
  en: pickText(v, "en", base.en),
});
const altOf = (v: ManagedValue | undefined, base: { ar: string; en: string }) => {
  const m = mediaOf(v);
  return m ? { ar: m.alt.ar || m.alt.en, en: m.alt.en || m.alt.ar } : base;
};
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "V";

/** A referenced Via store as the ads sections show it (real: links, follow). */
export function storeFromRef(r: ManagedRef | null, fallback: AdsStore): AdsStore {
  if (!r || r.refType !== "store" || !r.slug) return fallback;
  const name = r.name ?? r.slug;
  return { id: `via-${r.slug}`, slug: r.slug, name: { ar: name, en: name }, monogram: initials(name), logo: r.logo_url ?? null, demo: false };
}

/** Section heading: the ads design shows its display titles in Latin capitals in both languages. */
export function useAdsHeading(mode: SectionMode, builtIn: string): { text: string; managed: boolean } {
  if (mode.mode !== "managed") return { text: builtIn, managed: false };
  const text = pickText(mode.section.fields.heading, "en", builtIn);
  return { text, managed: text !== builtIn };
}

export type ManagedHeroSlide = HeroSlide & { ctaHref?: string | null };
export function useAdsHero() {
  const mode = useManagedSection("ads.hero");
  const slides = useMemo(
    () =>
      overlayItems<ManagedHeroSlide>(mode, HERO_SLIDES, (s) => s.id, (base, it) => {
        const src = mediaUrl(it.fields.image, null);
        if (!src) return null; // structural: the service already fell back to a bundled image when it could
        const store = storeFromRef(refOf(it.fields.store), base.store);
        return {
          ...base,
          id: it.id as HeroSlide["id"],
          image: src === base.image.src ? base.image : { ...base.image, src, srcSet: "" },
          alt: altOf(it.fields.image, base.alt),
          title: bi(it.fields.title, base.title),
          subtitle: bi(it.fields.text, { ar: "", en: "" }),
          store: { ...base.store, ...store, subline: base.store.subline, logoBg: base.store.logoBg },
          ctaHref: linkOf(it.fields.link, null),
        };
      }),
    [mode],
  );
  return { mode, slides };
}

export function useAdsStories() {
  const mode = useManagedSection("ads.stories");
  const groups = useMemo(
    () =>
      overlayItems<StoryGroup>(mode, STORY_GROUPS, (g) => g.store.id, (base, it, isNew) => {
        const m = mediaOf(it.fields.image);
        const src = mediaUrl(it.fields.image, null);
        if (!m || !src) return null;
        const store = storeFromRef(refOf(it.fields.store), isNew ? { ...base.store, id: it.id } : base.store);
        const caption = bi(it.fields.title, base.stories[0]?.caption ?? { ar: "", en: "" });
        // Same cover as built in: the store keeps its whole story sequence.
        if (!isNew && src === base.cover)
          return { ...base, store, stories: base.stories.map((s, i) => (i === 0 ? { ...s, caption } : s)) };
        const video = m.kind === "VIDEO";
        return {
          ...base,
          store,
          cover: video ? base.cover : src,
          followingDemo: isNew ? false : base.followingDemo,
          sponsored: false,
          stories: [{ id: it.id, type: video ? "video" : "image", src, cover: video ? base.cover : src, durationSeconds: video ? undefined : 3.5, caption }],
        };
      }),
    [mode],
  );
  return { mode, groups };
}

export function useAdsReels() {
  const mode = useManagedSection("ads.reels");
  const reels = useMemo(
    () =>
      overlayItems<Reel>(mode, REELS, (r) => r.id, (base, it, isNew) => {
        const m = mediaOf(it.fields.video);
        if (!m || m.kind !== "VIDEO") return null; // a reel needs its video
        return {
          ...base,
          id: it.id,
          video: mediaUrl(it.fields.video)!,
          title: bi(it.fields.title, base.title),
          caption: isNew ? { ar: "", en: "" } : base.caption,
          store: storeFromRef(refOf(it.fields.store), base.store),
          followingDemo: isNew ? false : base.followingDemo,
          sponsored: isNew ? false : base.sponsored,
          products: isNew ? [] : base.products,
        };
      }),
    [mode],
  );
  return { mode, reels };
}

export function useAdsFeatured() {
  const mode = useManagedSection("ads.featured");
  const ads = useMemo(
    () =>
      overlayItems<FeaturedAd>(mode, FEATURED_ADS, (a) => a.id, (base, it, isNew) => {
        const src = mediaUrl(it.fields.image, null);
        if (!src) return null;
        return {
          ...base,
          id: it.id,
          image: src === base.image.src ? base.image : { src, srcSet: "" },
          alt: altOf(it.fields.image, base.alt),
          title: bi(it.fields.title, base.title),
          subtitle: bi(it.fields.text, { ar: "", en: "" }),
          store: storeFromRef(refOf(it.fields.store), base.store),
          sponsored: isNew ? false : base.sponsored,
          href: linkOf(it.fields.link, null),
        };
      }),
    [mode],
  );
  return { mode, ads };
}

export function useAdsStores() {
  const mode = useManagedSection("ads.stores");
  const stores = useMemo(
    () =>
      overlayItems<FeaturedStore>(mode, DEMO_FEATURED_STORES, (s) => s.store.id, (base, it, isNew) => {
        const ref = refOf(it.fields.store);
        const store = storeFromRef(ref, base.store);
        if (isNew && store === base.store) return null; // a new card needs a real store
        const src = mediaUrl(it.fields.image, null);
        return {
          ...base,
          store,
          cover: src ?? (isNew ? ref?.logo_url ?? base.cover : base.cover),
          coverAlt: altOf(it.fields.image, isNew ? { ar: store.name.ar, en: store.name.en } : base.coverAlt),
          categories: isNew ? [] : base.categories,
          categoryLabels: isNew ? { ar: [], en: [] } : base.categoryLabels,
          sponsored: isNew ? false : base.sponsored,
        };
      }),
    [mode],
  );
  return { mode, stores };
}
