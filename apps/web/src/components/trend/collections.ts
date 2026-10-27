// Content of the /trending "new collections" block: the featured film reel
// and the "discover the collections" gallery. Editorial assets supplied for
// the page (REF/), not store uploads: no store is named and nothing claims to
// be a store's official collection. Names are provisional editorial titles
// chosen from what each asset shows.
//
// This is the one place to edit titles, order and destinations (and the
// shape a future admin dashboard can return). href: an existing Via route
// that fits the asset, or null - a card or film with no destination is shown
// without a link or call to action.

export type CollectionLink = string | null;

export type FeaturedFilm = {
  key: string;
  title: string;      // editorial name (Latin display line)
  titleAr: string;
  store: string | null; // shown only when the real store is known
  href: CollectionLink;
  video: string;      // trimmed, web-encoded clip (H.264, no audio)
  poster: string;     // its first frame
  focus?: string;     // object-position on narrow screens
};

export type GalleryItem = {
  key: string;
  title: string;
  titleAr: string;
  store: string | null;
  href: CollectionLink;
  src: string;
  w: number;          // native pixels of src
  h: number;
  half?: boolean;     // a -half.webp exists
  alt: string;
  tile: "tall" | "portrait" | "slim" | "wide-xl" | "still" | "landscape";
  fit?: "cover" | "native"; // native: never shown above its own pixel size
  tone?: "light";     // dark text on a light picture
  focus?: string;
};

const DIR = "/trend/collections";

export const FEATURED_FILMS: FeaturedFilm[] = [
  {
    key: "city-leather", title: "City Leather", titleAr: "جلد المدينة", store: null, href: "/women",
    video: `${DIR}/film-leather.mp4`, poster: `${DIR}/film-leather-poster.webp`, focus: "50% 50%",
  },
  {
    key: "noir-hour", title: "Noir Hour", titleAr: "ساعة الأسود", store: null, href: "/women",
    video: `${DIR}/film-noir.mp4`, poster: `${DIR}/film-noir-poster.webp`, focus: "56% 50%",
  },
  {
    key: "riviera-linen", title: "Riviera Linen", titleAr: "كتّان الريفييرا", store: null, href: "/discovery?segment=men",
    video: `${DIR}/film-linen.mp4`, poster: `${DIR}/film-linen-poster.webp`, focus: "38% 50%",
  },
];

export const GALLERY: GalleryItem[] = [
  {
    key: "sand-linen", title: "Sand & Linen", titleAr: "رمل وكتّان", store: null, href: "/women",
    src: `${DIR}/sand-linen`, w: 1173, h: 2133, half: true, tile: "tall", focus: "50% 30%",
    alt: "عارضة بقميص كتّان بلون الرمل وبنطال واسع بلون العاج",
  },
  {
    key: "quiet-tailoring", title: "Quiet Tailoring", titleAr: "أناقة هادئة", store: null, href: "/discovery?segment=men",
    src: `${DIR}/quiet-tailoring`, w: 843, h: 1124, half: true, tile: "portrait", focus: "50% 20%",
    alt: "رجل بقميص بولو محبوك بلون العاج وبنطال أسود ونظارة شمسية",
  },
  {
    key: "mini-neutrals", title: "Mini Neutrals", titleAr: "الصغار بألوان هادئة", store: null, href: "/discovery?segment=kids",
    src: `${DIR}/mini-neutrals`, w: 1200, h: 1799, half: true, tile: "slim", focus: "50% 40%",
    alt: "طفل بكنزة محبوكة بضفائر بلون الكريم وبنطال كتّان",
  },
  {
    key: "liquid-gold", title: "Liquid Gold", titleAr: "ذهب سائل", store: null, href: null,
    src: `${DIR}/liquid-gold`, w: 800, h: 1200, half: true, tile: "wide-xl", focus: "50% 45%",
    alt: "خواتم وسلاسل ذهبية على سطح عاكس داكن",
  },
  {
    key: "cocoa-cream", title: "Cocoa & Cream", titleAr: "كاكاو وكريمة", store: null, href: null,
    src: `${DIR}/cocoa-cream`, w: 235, h: 294, tile: "still", fit: "native",
    alt: "ثلاث حقائب جلد ناعمة بالعنّابي والبني والكريمي مكدّسة فوق بعضها",
  },
  {
    key: "off-duty-cream", title: "Off-Duty Cream", titleAr: "كريمي للأيام العادية", store: null, href: null,
    src: `${DIR}/off-duty-cream`, w: 736, h: 791, half: true, tile: "landscape", tone: "light", focus: "50% 45%",
    alt: "حذاء رياضي من الشامواه بلون الكريم بنعل عسلي",
  },
];
