// The homepage "Discover" selection: the curated pieces, in display order.
// Images: apps/web/public/images/home-products/ (copies of the supplied
// photos, unchanged).
//
// CATALOG LINKS - checked against the catalog: none of these pieces is a
// VIA product yet (name-alike items there are different products), so each
// `canonicalProductId` is null and its card shows "not available yet", with
// no price, stores or cart. Set the real canonical product id once a piece
// is listed: the card then shows its actual product - photo, ₪ price, store
// offers, colours, sizes, rating, favourite and cart.

import type { Lang } from "@/lib/i18n";

/** Audience (store segment) and product-type tags, used by the filter bar. */
export type HomeAudience = "women" | "men" | "kids";
export type HomeCategory = "accessories" | "shoes" | "bags";

export interface CuratedPiece {
  id: string;
  image: { src: string; width: number; height: number };
  /** Sampled from the photo's corners: the card frame shows the whole photo
   *  (nothing cropped), letterboxed in its own background colour. */
  background: string;
  name: Record<Lang, string>;
  /** Editorial tags of what the photo shows, for filtering the selection. */
  audience: HomeAudience;
  category?: HomeCategory;
  canonicalProductId: string | null;
  /** VIA phase 6: an Editorial Product Pick (a real public offer) - its card links to it. */
  pick?: { vendorSlug: string; offerId: string };
}

const dir = "/images/home-products";

export const CURATED_PIECES: CuratedPiece[] = [
  { id: "heel-boots", image: { src: `${dir}/01-heel-boots.jpg`, width: 735, height: 981 }, background: "#ffffff", name: { ar: "بوت جلدي بكعب رفيع", en: "Leather Stiletto Ankle Boots" }, audience: "women", category: "shoes", canonicalProductId: null },
  // A frame of its own reel (REF/videoframe_7212.png) - see productReels.ts.
  { id: "mossdoom-blue-bag", image: { src: `${dir}/16-mossdoom-blue-bag.png`, width: 720, height: 1280 }, background: "#ecebe9", name: { ar: "حقيبة MOSSDOOM بمقبض علوي", en: "MOSSDOOM Top-Handle Bag" }, audience: "women", category: "bags", canonicalProductId: null },
  { id: "belted-trousers", image: { src: `${dir}/02-belted-trousers.jpg`, width: 736, height: 1308 }, background: "#c1c1c1", name: { ar: "بنطال واسع بحزام", en: "Belted Wide-Leg Trousers" }, audience: "women", canonicalProductId: null },
  { id: "casio-watch", image: { src: `${dir}/03-casio-watch.jpg`, width: 900, height: 1200 }, background: "#ffffff", name: { ar: "ساعة كاسيو بسوار جلدي", en: "Casio Leather-Strap Watch" }, audience: "men", category: "accessories", canonicalProductId: null },
  { id: "penny-loafers", image: { src: `${dir}/04-penny-loafers.jpg`, width: 1200, height: 1200 }, background: "#e9e9e7", name: { ar: "حذاء لوفر جلدي", en: "Leather Penny Loafers" }, audience: "men", category: "shoes", canonicalProductId: null },
  { id: "running-sneakers", image: { src: `${dir}/05-running-sneakers.jpg`, width: 1200, height: 1500 }, background: "#f5f5f5", name: { ar: "حذاء رياضي للجري", en: "Running Sneakers" }, audience: "women", category: "shoes", canonicalProductId: null },
  { id: "pearl-clutch", image: { src: `${dir}/06-pearl-clutch.jpg`, width: 1200, height: 1598 }, background: "#f4f1ec", name: { ar: "حقيبة كلاتش لؤلؤية", en: "Pearlescent Clutch" }, audience: "women", category: "bags", canonicalProductId: null },
  { id: "pearl-earrings", image: { src: `${dir}/07-pearl-earrings.jpg`, width: 700, height: 980 }, background: "#e7e7e7", name: { ar: "أقراط لؤلؤ بإطار ذهبي", en: "Gold-Framed Pearl Earrings" }, audience: "women", category: "accessories", canonicalProductId: null },
  { id: "ny-cap", image: { src: `${dir}/08-ny-cap.jpg`, width: 736, height: 996 }, background: "#eeeeee", name: { ar: "قبعة بيسبول NY", en: "NY Baseball Cap" }, audience: "men", category: "accessories", canonicalProductId: null },
  { id: "zip-jacket", image: { src: `${dir}/09-zip-jacket.jpg`, width: 736, height: 981 }, background: "#dcdcdd", name: { ar: "جاكيت بسحّاب بلون العاج", en: "Ivory Zip Jacket" }, audience: "men", canonicalProductId: null },
  { id: "metal-sunglasses", image: { src: `${dir}/10-metal-sunglasses.jpg`, width: 720, height: 720 }, background: "#ededed", name: { ar: "نظارة شمسية بإطار معدني", en: "Metal-Frame Sunglasses" }, audience: "men", category: "accessories", canonicalProductId: null },
  { id: "rimless-sunglasses", image: { src: `${dir}/11-rimless-sunglasses.jpg`, width: 736, height: 736 }, background: "#ffffff", name: { ar: "نظارة شمسية بلا إطار", en: "Rimless Oval Sunglasses" }, audience: "women", category: "accessories", canonicalProductId: null },
  { id: "cropped-trench", image: { src: `${dir}/12-cropped-trench.png`, width: 1152, height: 2048 }, background: "#ffffff", name: { ar: "ترنش قصير بحزام", en: "Belted Cropped Trench" }, audience: "women", canonicalProductId: null },
  { id: "gold-sunglasses", image: { src: `${dir}/13-gold-sunglasses.jpg`, width: 720, height: 1080 }, background: "#eeeeee", name: { ar: "نظارة شمسية ذهبية", en: "Gold Cat-Eye Sunglasses" }, audience: "women", category: "accessories", canonicalProductId: null },
  { id: "serpenti-watch", image: { src: `${dir}/14-serpenti-watch.jpg`, width: 736, height: 736 }, background: "#f6f5f3", name: { ar: "ساعة ذهبية بسوار ملفوف", en: "Gold Wrap Watch" }, audience: "women", category: "accessories", canonicalProductId: null },
  { id: "top-handle-bag", image: { src: `${dir}/15-top-handle-bag.jpg`, width: 1200, height: 1600 }, background: "#ececec", name: { ar: "حقيبة يد بمقبض علوي", en: "Top-Handle Bag" }, audience: "women", category: "bags", canonicalProductId: null },
];
