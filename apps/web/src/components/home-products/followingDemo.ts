// FOLLOWING TAB - DEMO FEED (prototype before store integration), shown only
// in the demo preview (/?yourvia=demo). NOT real follows or account
// activity: the real tab (signed in) reads GET /customers/me/following/feed.
//
// Each entry is a product from a demo "followed store", with the date it was
// added; the tab lists them newest first. Products are the homepage's
// existing demo pieces (curatedPieces.ts) - shown with the same ProductCard
// as Discover, without prices, ratings or store details (none exist).
//
// Store attribution: only MOSSDOOM is a real brand of a piece (its bag and
// its reel are the owner's MOSSDOOM files). The other pieces have no known
// store, so they belong to one generic demo store - no store is invented.
// The cards show no store either way.
//
// Reels: none are listed here. A product's reel comes from productReels.ts,
// the same association Discover uses - so the MOSSDOOM bag has its
// "watch it in a reel" action in both tabs, and nothing else does.

import { CURATED_PIECES, type CuratedPiece } from "./curatedPieces";

export interface DemoFollowedStore {
  id: string;
  name: string;
}

export const DEMO_FOLLOWED_STORES = {
  mossdoom: { id: "demo-mossdoom", name: "MOSSDOOM" },
  demo: { id: "demo-store", name: "Demo store" },
} satisfies Record<string, DemoFollowedStore>;

export interface FollowingDemoEntry {
  /** A piece from curatedPieces.ts. */
  pieceId: string;
  store: DemoFollowedStore;
  /** When the store added it (demo date - orders the feed). */
  addedAt: string;
}

const { mossdoom, demo } = DEMO_FOLLOWED_STORES;

/** Listed in no particular order: the feed sorts by `addedAt`. */
export const FOLLOWING_DEMO: FollowingDemoEntry[] = [
  { pieceId: "pearl-earrings", store: demo, addedAt: "2026-11-21T18:20:00Z" },
  { pieceId: "mossdoom-blue-bag", store: mossdoom, addedAt: "2026-11-21T09:05:00Z" },
  { pieceId: "cropped-trench", store: demo, addedAt: "2026-11-20T16:40:00Z" },
  { pieceId: "top-handle-bag", store: demo, addedAt: "2026-11-20T11:10:00Z" },
  { pieceId: "gold-sunglasses", store: demo, addedAt: "2026-11-19T20:30:00Z" },
  { pieceId: "belted-trousers", store: demo, addedAt: "2026-11-19T08:15:00Z" },
  { pieceId: "serpenti-watch", store: demo, addedAt: "2026-11-18T14:00:00Z" },
  { pieceId: "pearl-clutch", store: demo, addedAt: "2026-11-17T17:45:00Z" },
  { pieceId: "heel-boots", store: demo, addedAt: "2026-11-16T10:30:00Z" },
  { pieceId: "zip-jacket", store: demo, addedAt: "2026-11-15T12:00:00Z" },
  { pieceId: "penny-loafers", store: demo, addedAt: "2026-11-14T09:20:00Z" },
  { pieceId: "rimless-sunglasses", store: demo, addedAt: "2026-11-13T15:50:00Z" },
  { pieceId: "ny-cap", store: demo, addedAt: "2026-11-12T19:10:00Z" },
  { pieceId: "casio-watch", store: demo, addedAt: "2026-11-11T08:40:00Z" },
];

/** The demo feed's pieces, newest first (unknown ids are skipped). */
export const FOLLOWING_DEMO_PIECES: CuratedPiece[] = [...FOLLOWING_DEMO]
  .sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt))
  .flatMap((e) => CURATED_PIECES.filter((p) => p.id === e.pieceId));
