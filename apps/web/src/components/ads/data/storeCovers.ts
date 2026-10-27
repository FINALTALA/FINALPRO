// Dedicated cover images for Discover Stores, one per store.
//
// Waiting on the six store images from the design team. When they arrive,
// put each in public/advertising/stores/ and add one entry here, keyed by
// the store's card id: `via-<slug>` for a real Via store, or the demo store
// id from adsDemo.ts (e.g. "store-latelier-noir"). Only map an image to the store
// it was made for. Stores without an entry keep the cover they show today
// (the storefront cover for real stores, the design image for demo ones);
// name, logo and link never come from this file.

export type StoreCover = { src: string; objectPosition?: string; alt?: { ar: string; en: string } };

export const STORE_COVER_OVERRIDES: Record<string, StoreCover> = {
  // "via-<slug>": { src: "/advertising/stores/<file>.webp", objectPosition: "center 30%" },
};
