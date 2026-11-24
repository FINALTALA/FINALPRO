// "Browse Stores" on the homepage - the owner's storefront photos (sent
// 22 Nov 2026). Each store's name is the one written on its own photo;
// its categories describe what that photo shows (owner's choice, to be
// reviewed). Two photos with no store name on them are left out until they
// have one.
//
// None of these stores has a VIA store page yet, so `slug` is null and the
// card's "Browse store" link stays inactive. When a store gets its page,
// set its slug here and the link opens /store/<slug>.

export interface HomeStore {
  id: string;
  slug: string | null;
  name: string;
  image: { src: string; width: number; height: number };
  /** object-position for the 4:5 cover. */
  focus: string;
  categories: { ar: string[]; en: string[] };
}

const dir = "/images/home-stores";

export const HOME_STORES: HomeStore[] = [
  {
    id: "boss",
    slug: null,
    name: "BOSS",
    image: { src: `${dir}/boss.jpg`, width: 750, height: 1143 },
    focus: "50% 12%",
    categories: { ar: ["رجال", "بدلات رسمية", "حقائب وأحذية"], en: ["Men", "Tailoring", "Bags & Shoes"] },
  },
  {
    id: "zara",
    slug: null,
    name: "ZARA",
    image: { src: `${dir}/zara.jpg`, width: 1014, height: 1200 },
    focus: "50% 40%",
    categories: { ar: ["نساء", "فساتين", "أحذية"], en: ["Women", "Dresses", "Shoes"] },
  },
  {
    id: "luxee-vogue",
    slug: null,
    name: "LUXÉE VOGUE",
    image: { src: `${dir}/luxee-vogue.jpg`, width: 1122, height: 1402 },
    focus: "45% 50%",
    categories: { ar: ["نساء", "حقائب فاخرة"], en: ["Women", "Luxury Bags"] },
  },
  {
    id: "armani-collezioni",
    slug: null,
    name: "ARMANI COLLEZIONI",
    image: { src: `${dir}/armani-collezioni.jpg`, width: 1200, height: 1800 },
    focus: "50% 50%",
    categories: { ar: ["رجال", "بدلات", "قمصان"], en: ["Men", "Suits", "Shirts"] },
  },
  {
    id: "bonpoint",
    slug: null,
    name: "Bonpoint",
    image: { src: `${dir}/bonpoint.jpg`, width: 750, height: 937 },
    focus: "50% 50%",
    categories: { ar: ["أطفال", "ملابس وأحذية"], en: ["Kids", "Clothing & Shoes"] },
  },
  {
    id: "salvatore-ferragamo",
    slug: null,
    name: "Salvatore Ferragamo",
    image: { src: `${dir}/salvatore-ferragamo.jpg`, width: 1199, height: 1637 },
    focus: "50% 14%",
    categories: { ar: ["رجال", "أحذية", "إكسسوارات جلدية"], en: ["Men", "Shoes", "Leather Goods"] },
  },
  {
    id: "stevel",
    slug: null,
    name: "STEVEL",
    image: { src: `${dir}/stevel.jpg`, width: 736, height: 974 },
    focus: "50% 55%",
    categories: { ar: ["نساء", "أزياء", "معاطف"], en: ["Women", "Fashion", "Coats"] },
  },
  {
    id: "remy",
    slug: null,
    name: "RÈMY",
    image: { src: `${dir}/remy.jpg`, width: 1080, height: 1080 },
    focus: "50% 45%",
    categories: { ar: ["رجال", "بدلات"], en: ["Men", "Suits"] },
  },
];
