import { type Lang, registerTranslations, translate } from "./i18n";
import type { Availability } from "./types";

// TB-25: the words shared by the shopper's pages (product cards, store
// cards, availability, counts). The Arabic is the wording these pages
// already used, unchanged; English is added beside it.

registerTranslations({
  ar: {
    "shop.no_image": "لا توجد صورة",
    "shop.compare_prices": "قارني الأسعار",
    "shop.compare_title": "مقارنة الأسعار",
    "shop.compare_between": "قارني الأسعار بين {stores}",
    "shop.one_store": "متجر واحد",
    "shop.n_stores": "{n} متاجر",
    "shop.style_look": "تنسيق الإطلالة",
    "shop.fav_add": "إضافة إلى المفضلة",
    "shop.fav_remove": "إزالة من المفضلة",
    "shop.discount": "خصم",
    "shop.discount_at": "خصم لدى {n} {stores}",
    "shop.store_word_one": "متجر",
    "shop.store_word_many": "متاجر",
    "shop.colors_available": "الألوان المتاحة",
    "shop.sizes_available": "المقاسات المتاحة",
    "shop.colors_and_sizes": "الألوان والمقاسات",
    "shop.colors_and_sizes_available": "الألوان والمقاسات المتاحة",
    "shop.color_of": "لون {color}",
    "shop.more_colors": "+{n} ألوان",
    "shop.more_sizes": "+{n} مقاسات",
    "shop.no_rating": "لا يوجد تقييم بعد",
    "shop.rating_of": "التقييم {r} من 5",
    "shop.pick_size_add": "اختاري المقاس وأضيفي إلى السلة",
    "shop.starts_from": "يبدأ من ",
    "shop.availability.available": "متوفر",
    "shop.availability.low_stock": "كمية محدودة",
    "shop.availability.sold_out": "غير متوفر",
    "shop.was": "بدلاً من {price} شيكل",
    "seg.all": "الكل",
    "seg.women": "نساء",
    "seg.men": "رجال",
    "seg.kids": "أطفال",
    "seg.accessories": "إكسسوارات",
    "seg.watches": "ساعات",
    "seg.shoes": "أحذية",
    "shop.prev": "السابق",
    "shop.next": "التالي",
    "shop.page_of": "صفحة {page} من {total}",
    "shop.loading": "جارٍ التحميل…",
  },
  en: {
    "shop.no_image": "No image",
    "shop.compare_prices": "Compare prices",
    "shop.compare_title": "Price comparison",
    "shop.compare_between": "Compare prices across {stores}",
    "shop.one_store": "1 store",
    "shop.n_stores": "{n} stores",
    "shop.style_look": "Style the look",
    "shop.fav_add": "Add to favourites",
    "shop.fav_remove": "Remove from favourites",
    "shop.discount": "Sale",
    "shop.discount_at": "On sale at {n} {stores}",
    "shop.store_word_one": "store",
    "shop.store_word_many": "stores",
    "shop.colors_available": "Available colours",
    "shop.sizes_available": "Available sizes",
    "shop.colors_and_sizes": "Colours and sizes",
    "shop.colors_and_sizes_available": "Available colours and sizes",
    "shop.color_of": "Colour {color}",
    "shop.more_colors": "+{n} colours",
    "shop.more_sizes": "+{n} sizes",
    "shop.no_rating": "No rating yet",
    "shop.rating_of": "Rated {r} out of 5",
    "shop.pick_size_add": "Choose a size and add to cart",
    "shop.starts_from": "From ",
    "shop.availability.available": "In stock",
    "shop.availability.low_stock": "Limited stock",
    "shop.availability.sold_out": "Out of stock",
    "shop.was": "Was {price} ILS",
    "seg.all": "All",
    "seg.women": "Women",
    "seg.men": "Men",
    "seg.kids": "Kids",
    "seg.accessories": "Accessories",
    "seg.watches": "Watches",
    "seg.shoes": "Shoes",
    "shop.prev": "Previous",
    "shop.next": "Next",
    "shop.page_of": "Page {page} of {total}",
    "shop.loading": "Loading…",
  },
});

/** `fmt("{n} stores", { n: 3 })` - fills named placeholders. */
export function fmt(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (all, name: string) => (name in values ? String(values[name]) : all));
}

export function availabilityLabel(lang: Lang, availability: Availability): string {
  return translate(lang, `shop.availability.${availability}`);
}

/** A discovery segment's name (الكل / نساء / … ), by its key. */
export function segmentLabel(lang: Lang, key: string, fallback: string): string {
  const text = translate(lang, `seg.${key}`);
  return text === `seg.${key}` ? fallback : text;
}

export function storeCountLabel(lang: Lang, count: number): string {
  return count === 1 ? translate(lang, "shop.one_store") : fmt(translate(lang, "shop.n_stores"), { n: count });
}
