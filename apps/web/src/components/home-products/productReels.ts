// PRODUCT-LINKED REEL - UI prototype for the homepage Discover and Following
// tabs (the same association in both), before
// any store integration (no upload, publishing or limits yet).
//
// The product is the content; a reel is only another way to see THAT
// product. So a reel is attached only when its video actually shows the
// piece. ONE product at most for now: `DISCOVER_PRODUCT_REEL` is a single
// entry, and every other card stays as it is.
//
// To move it to another piece: copy that piece's video into
// public/images/home-products/reels/ and change the entry below
// (`pieceId` is an id from curatedPieces.ts; null turns it off).

export interface ProductReel {
  /** The Discover piece it shows (CuratedPiece.id). */
  pieceId: string;
  /** Public path of the video. */
  video: string;
  /** The video's own pixel size - the viewer keeps its proportions. */
  width: number;
  height: number;
  /** Optional still shown before the video plays. */
  poster?: string;
}

// The owner's video (REF/video_6206b9650f08.mp4, 720x1280, 8 s), copied
// unchanged, on its own product: the light-blue MOSSDOOM top-handle bag,
// whose card photo is a frame of this same video (REF/videoframe_7212.png).
export const DISCOVER_PRODUCT_REEL: ProductReel | null = {
  pieceId: "mossdoom-blue-bag",
  video: "/images/home-products/reels/mossdoom-blue-bag.mp4",
  width: 720,
  height: 1280,
};

/** The reel attached to a Discover piece, if any. */
export const reelForPiece = (pieceId: string): ProductReel | null =>
  DISCOVER_PRODUCT_REEL?.pieceId === pieceId ? DISCOVER_PRODUCT_REEL : null;
