// The homepage hero's editorial scenes, played in order (HomeHero.tsx) over
// one photograph: only the text changes from scene to scene.
// Scenes 03-04 are added as further entries here.
// The image's `width`/`height` must match the file exactly.

export interface HeroFocus {
  /** 0..1 across the image - the point the crop keeps in view. */
  x: number;
  y: number;
}

export interface HeroImage {
  src: string;
  width: number;
  height: number;
}

export interface HeroPhotograph {
  image: HeroImage & {
    /** Crop focus for the wide (desktop) frame and the compact phone frame. */
    focus: { desktop: HeroFocus; mobile: HeroFocus };
    altKey: string;
  };
  /** A separately composed phone image, when one exists. */
  mobileImage?: HeroImage & { focus: HeroFocus };
  /** A tone taken from the photograph's lower edge: the phone text area,
   *  so it reads as part of the picture. */
  backdrop: string;
  /** Text colour, chosen for the photo's tone. */
  ink: string;
}

/**
 * The one photograph every scene plays over. Moving the woman on her own
 * (a subtle shift right between scenes) needs two prepared layers - the
 * woman cut out, and the background with her removed; it is not attempted
 * on the flattened photograph.
 */
export const HERO_PHOTOGRAPH: HeroPhotograph = {
  image: {
    src: "/images/Golden Drapery Fashion Editorial - Copy.png",
    width: 1828,
    height: 860,
    // The model stands at ~46-65% across, head from ~24% down: the plain
    // wall above her takes the transparent header. The left ~40% (wall over
    // cream silk) is the negative space for the text.
    focus: { desktop: { x: 0.56, y: 0.35 }, mobile: { x: 0.56, y: 0.3 } },
    altKey: "hero.s01.alt",
  },
  // Lighter than the photo's lower edge (#d5b291), which fades into it.
  backdrop: "#ead8c0",
  ink: "#2a2420",
};

/** A garment floating around the model in "Shop the look". */
export interface ShopItem {
  id: string;
  /** Transparent cutout of the supplied product photo. */
  image: HeroImage;
  nameKey: string;
  categoryKey: ShopCategory;
  /**
   * The EXACT VIA catalog product this piece is (its canonical product id -
   * the verified identity shared by every store's offer of it). With an id,
   * the label shows its real ₪ price and opens that product: the store
   * comparison when several stores sell it, else its one offer. null = not
   * in the catalog: shown as not available, with no link - never a search
   * or a lookalike.
   */
  canonicalProductId: string | null;
  /** Rendered width on wide screens at 1440px, in px (height follows the
   *  image; narrower screens scale it down). */
  width: number;
  /** The visible garment inside its transparent canvas, measured from the
   *  cutout's alpha: its width and the empty band below it, as fractions -
   *  so every piece's lower edge, ring and label line up on one baseline. */
  content: { width: number; bottomGap: number };
}

export type ShopCategory = "full" | "top" | "pants" | "foot" | "accessories";

export interface ShopTheLook {
  /** The model, a transparent PNG, centred and still. */
  model: HeroImage;
  /** Left of the model first (outer, inner), then right (inner, outer). */
  items: ShopItem[];
}

export interface HeroScene {
  id: string;
  /** Scene name for the pagination dots (and their accessible labels). */
  nameKey: string;
  /** Editorial label, Latin in both languages; the closing scene has none. */
  label?: string;
  /** How long the scene holds before the story moves on, in ms (default 4000). */
  dwell?: number;
  /** Plays over HERO_SET_BACKGROUND (the woman-free set) instead of the
   *  Scene 01 photograph; consecutive set scenes share that one layer. */
  set?: boolean;
  /** The photo's negative space, in physical terms (it does not mirror
   *  with the reading direction): which side - or centred - and how far
   *  from that side as a fraction of the hero width. `zoneBottom` (0..1 of
   *  the hero height) ends the text area above lower details. `compact`
   *  tightens the vertical rhythm (label, headline, description, index). */
  text: { side: "left" | "right" | "center"; inset: number; zoneBottom?: number; compact?: boolean };
  copy: {
    titleKeys: string[];
    descriptionKey: string;
    ctaKey?: string;
    /** Closing line + scene index ("02 / 04"); without it the label
     *  carries the opening line instead. */
    index?: string;
  };
  /** An existing section id on the homepage the CTA scrolls to. */
  ctaTarget?: string;
  /** "Shop the look" layers. */
  shop?: ShopTheLook;
  /** The closing shot: the official logo above the closing line. */
  closing?: { logo: HeroImage };
}

// SCENE 03 ASSETS - apps/web/public/images/hero/scene-03/
//   background.png (1828x860, the woman-free golden-silk set), model.png,
//   polo.png, trousers.png, sneakers.png, sunglasses.png (transparent PNGs).
// Without background.png the hero stops on scene 02; a missing garment
// image is simply left out.
// PRODUCT LINKS - checked against the catalog: none of the four pieces is
// listed (its sneakers, sunglasses and trousers are different products),
// so every canonicalProductId below is null until the real one exists.
const SCENE_03 = "/images/hero/scene-03";

/** The Scene 01 photograph with the woman removed - same size, same framing,
 *  so the change reads as her leaving the set. Scenes 03 and 04 play over it;
 *  they join the story only once it has loaded. */
export const HERO_SET_BACKGROUND: HeroImage = { src: `${SCENE_03}/background.png`, width: 1828, height: 860 };

export const HERO_SCENES: HeroScene[] = [
  {
    id: "01",
    nameKey: "hero.dots.s01",
    label: "THE VIA EDITORIAL — 01",
    text: { side: "left", inset: 0.06 },
    copy: {
      titleKeys: ["hero.s01.title.l1", "hero.s01.title.l2"],
      descriptionKey: "hero.s01.description",
      ctaKey: "hero.s01.cta",
    },
    ctaTarget: "shop-by-category",
  },
  {
    id: "02",
    nameKey: "hero.dots.s02",
    label: "WELCOME TO VIA",
    // Same negative space as scene 01, the photograph does not change.
    text: { side: "left", inset: 0.06, compact: true },
    copy: {
      titleKeys: ["hero.s02.title.l1", "hero.s02.title.l2"],
      descriptionKey: "hero.s02.description",
      index: "02 / 03",
    },
  },
  {
    // The final shot: the set (the woman gone) and the logo. The former
    // "shop the look" scene 03 was removed; the id stays "04" so its copy
    // keys keep their names.
    id: "04",
    nameKey: "hero.dots.s04",
    set: true,
    text: { side: "center", inset: 0 },
    copy: {
      titleKeys: ["hero.s04.title"],
      descriptionKey: "hero.s04.description",
      ctaKey: "hero.s04.cta",
    },
    ctaTarget: "shop-by-category",
    // The official logo, as the site header uses it.
    closing: { logo: { src: "/images/via-logo.svg", width: 1492, height: 1054 } },
  },
];
