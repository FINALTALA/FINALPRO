"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import BackToOrigin from "@/components/BackToOrigin";
import Reveal from "@/components/Reveal";
import SafeImage from "@/components/SafeImage";
import StoreCircle from "@/components/StoreCircle";
import { BagIcon, ClipboardIcon, HeartIcon, ManagementTileIcon, StarIcon, StoreManageIcon } from "@/components/Icons";
import { EmptyState, ErrorBanner, SkeletonGrid } from "@/components/States";
import { apiFetch, ApiError } from "@/lib/api";
import { Availability } from "@/lib/types";
import { useProductFavorites } from "@/lib/useProductFavorites";
import { useSessionToken } from "@/lib/useSession";
import { EarliestSlot, formatSlotDay, slotHours } from "@/lib/deliveryPromise";
import { registerTranslations, translate } from "@/lib/i18n";
import { useLang } from "@/lib/useLang";
import { useTaxonomy } from "@/lib/taxonomy";
import { colorName, pickText, sizeName } from "@/lib/localized";
import { availabilityLabel, fmt, storeCountLabel } from "@/lib/shopText";
import "@/lib/pdpText";
import "@/lib/listText";

// TB-25: the comparison page's own words (Arabic unchanged). Zone names are
// zone.* (registered by lib/pdpText), store names and branch names are
// data and are shown as written.
registerTranslations({
  ar: {
    "cmp.ret.REFUND_ONLY": "استرجاع",
    "cmp.ret.EXCHANGE_ONLY": "استبدال",
    "cmp.ret.BOTH": "استرجاع واستبدال",
    "cmp.ret.available": "متاح",
    "cmp.err.load": "تعذّر تحميل صفحة المقارنة",
    "cmp.no_offers": "لا توجد عروض مؤهلة لهذا المنتج حالياً",
    "cmp.back_to_discovery": "العودة للاكتشاف",
    "cmp.n_ratings": " ({n} تقييم)",
    "cmp.compare_between": "مقارنة الأسعار بين {stores}",
    "cmp.lowest": " - الأقل: {price} ₪",
    "cmp.actions": "إجراءات المقارنة",
    "cmp.added_to_set": "أُضيف إلى مجموعة مقارنة جديدة",
    "cmp.add_to_set": "إضافة لمجموعة مقارنة جديدة",
    "cmp.my_sets": "مجموعاتي المحفوظة",
    "cmp.stores_selling": "المتاجر التي تبيع هذا المنتج",
    "cmp.prev_stores": "المتاجر السابقة",
    "cmp.next_stores": "المتاجر التالية",
    "cmp.delivery_to": "التوصيل إلى: {zone}{suffix}",
    "cmp.default_address_suffix": " (عنوانك الافتراضي)",
    "cmp.all_zones": "كل مناطق التوصيل",
    "cmp.no_match": "لا توجد متاجر تطابق اللون والمقاس والمنطقة المختارة.",
    "cmp.clear_filters": "مسح الفلاتر",
    "cmp.cheapest": "الأرخص",
    "cmp.open_store": "فتح متجر {name}",
    "cmp.verified": "متجر موثّق",
    "cmp.sizes": "المقاسات:",
    "cmp.prev_sizes": "المقاسات السابقة",
    "cmp.next_sizes": "المقاسات التالية",
    "cmp.color": "اللون:",
    "cmp.prev_colors": "الألوان السابقة",
    "cmp.next_colors": "الألوان التالية",
    "cmp.delivers_to": "يوصل إلى:",
    "cmp.free": "مجاني",
    "cmp.fee": "{fee} ₪",
    "cmp.no_delivery": "لا توصيل",
    "cmp.earliest": "أقرب موعد توصيل: {day}، ",
    "cmp.estimate": "(تقديري)",
    "cmp.not_in_zone": "لا يوصل إلى المنطقة المختارة",
    "cmp.no_slots": "لا مواعيد توصيل متاحة خلال الأيام الثلاثة القادمة",
    "cmp.no_delivery_stock": "غير متوفر للتوصيل حالياً",
    "cmp.not_purchasable": "المتجر لا يستقبل طلبات حالياً",
    "cmp.pickup": "استلام من المحل:",
    "cmp.unavailable": "غير متوفر",
    "cmp.warranty": "الضمان:",
    "cmp.returns": "الإرجاع:",
    "cmp.within_days": " خلال {n} يومًا",
    "cmp.stale": "⚠ بيانات السعر قديمة",
    "cmp.condition": "الحالة: {c}",
    "cmp.open_in_store": "افتحي في المتجر",
    "cmp.close_filter": "إغلاق الفلتر",
    "cmp.filter_stores": "فلترة المتاجر التي تبيع هذا المنتج",
    "cmp.compare_stores": "قارني بين المتاجر",
    "cmp.price": "السعر",
    "cmp.price_range": "من {min} ₪ — حتى {max} ₪",
    "cmp.price_min": "أقل سعر",
    "cmp.price_max": "أعلى سعر",
    "cmp.size": "المقاس",
    "cmp.color_legend": "اللون",
    "cmp.zone": "منطقة التوصيل",
    "cmp.my_default_address": "عنواني الافتراضي ({zone})",
    "cmp.no_limit": "دون تقييد",
    "cmp.all_areas": "كل المناطق",
    "cmp.fulfilment": "طريقة الاستلام",
    "cmp.ful.ALL": "الكل",
    "cmp.ful.DELIVERY": "توصيل",
    "cmp.ful.PICKUP": "استلام من المحل",
    "cmp.store_and_offer": "المتجر والعرض",
    "cmp.available_only": "متوفر الآن فقط",
    "cmp.discounted_only": "عروض مخفّضة فقط",
    "cmp.free_delivery_only": "توصيل مجاني فقط",
    "cmp.verified_only": "متجر موثّق فقط",
    "cmp.returns_only": "يدعم الإرجاع",
    "cmp.clear_all": "مسح الكل",
    "cmp.show_results": "عرض النتائج",
    "cmp.list_sep": "، ",
  },
  en: {
    "cmp.ret.REFUND_ONLY": "Returns",
    "cmp.ret.EXCHANGE_ONLY": "Exchanges",
    "cmp.ret.BOTH": "Returns and exchanges",
    "cmp.ret.available": "Available",
    "cmp.err.load": "Couldn't load the comparison page",
    "cmp.no_offers": "No eligible offers for this product right now",
    "cmp.back_to_discovery": "Back to discovery",
    "cmp.n_ratings": " ({n} ratings)",
    "cmp.compare_between": "Price comparison across {stores}",
    "cmp.lowest": " - lowest: ₪{price}",
    "cmp.actions": "Comparison actions",
    "cmp.added_to_set": "Added to a new comparison set",
    "cmp.add_to_set": "Add to a new comparison set",
    "cmp.my_sets": "My saved sets",
    "cmp.stores_selling": "Stores selling this product",
    "cmp.prev_stores": "Previous stores",
    "cmp.next_stores": "Next stores",
    "cmp.delivery_to": "Delivery to: {zone}{suffix}",
    "cmp.default_address_suffix": " (your default address)",
    "cmp.all_zones": "All delivery areas",
    "cmp.no_match": "No stores match the chosen colour, size and area.",
    "cmp.clear_filters": "Clear filters",
    "cmp.cheapest": "Cheapest",
    "cmp.open_store": "Open {name}",
    "cmp.verified": "Verified store",
    "cmp.sizes": "Sizes:",
    "cmp.prev_sizes": "Previous sizes",
    "cmp.next_sizes": "Next sizes",
    "cmp.color": "Colour:",
    "cmp.prev_colors": "Previous colours",
    "cmp.next_colors": "Next colours",
    "cmp.delivers_to": "Delivers to:",
    "cmp.free": "free",
    "cmp.fee": "₪{fee}",
    "cmp.no_delivery": "No delivery",
    "cmp.earliest": "Earliest delivery: {day}, ",
    "cmp.estimate": "(estimate)",
    "cmp.not_in_zone": "Doesn't deliver to the chosen area",
    "cmp.no_slots": "No delivery times available in the next three days",
    "cmp.no_delivery_stock": "Not available for delivery right now",
    "cmp.not_purchasable": "The store isn't taking orders right now",
    "cmp.pickup": "Pickup from the shop:",
    "cmp.unavailable": "Not available",
    "cmp.warranty": "Warranty:",
    "cmp.returns": "Returns:",
    "cmp.within_days": " within {n} days",
    "cmp.stale": "⚠ Price data is out of date",
    "cmp.condition": "Condition: {c}",
    "cmp.open_in_store": "Open in the store",
    "cmp.close_filter": "Close filter",
    "cmp.filter_stores": "Filter the stores selling this product",
    "cmp.compare_stores": "Compare stores",
    "cmp.price": "Price",
    "cmp.price_range": "From ₪{min} — up to ₪{max}",
    "cmp.price_min": "Minimum price",
    "cmp.price_max": "Maximum price",
    "cmp.size": "Size",
    "cmp.color_legend": "Colour",
    "cmp.zone": "Delivery area",
    "cmp.my_default_address": "My default address ({zone})",
    "cmp.no_limit": "No limit",
    "cmp.all_areas": "All areas",
    "cmp.fulfilment": "How you receive it",
    "cmp.ful.ALL": "All",
    "cmp.ful.DELIVERY": "Delivery",
    "cmp.ful.PICKUP": "Pickup from the shop",
    "cmp.store_and_offer": "Store and offer",
    "cmp.available_only": "In stock now only",
    "cmp.discounted_only": "Discounted offers only",
    "cmp.free_delivery_only": "Free delivery only",
    "cmp.verified_only": "Verified stores only",
    "cmp.returns_only": "Accepts returns",
    "cmp.clear_all": "Clear all",
    "cmp.show_results": "Show results",
    "cmp.list_sep": ", ",
  },
});

type Zone = "WEST_BANK" | "JERUSALEM" | "INSIDE";
type Fulfilment = "ALL" | "DELIVERY" | "PICKUP";


interface StoreRowDto {
  vendor_id: string;
  vendor_slug: string;
  display_name: string;
  logo_url: string | null;
  is_verified: boolean;
  offer_id: string;
  offer_variant_id: string;
  color: string | null;
  size: string | null;
  price: string;
  original_price: string | null;
  is_discounted: boolean;
  availability: Availability;
  image_url: string | null;
  condition: string;
  delivery: {
    zones: { region: Zone; fee: number }[];
    zone: Zone | null;
    fee: number | null;
    // PD-2: decided by the server (the same source checkout uses).
    status: "NO_ZONE_SELECTED" | "AVAILABLE" | "NOT_AVAILABLE_IN_ZONE" | "NO_UPCOMING_SLOTS" | "NO_ELIGIBLE_STOCK" | "NOT_OFFERED" | "NOT_PURCHASABLE";
    earliest_slot_date?: string | null;
    // PD-5.1: the store's earliest bookable window (checkout's slots).
    earliest_slot?: EarliestSlot | null;
  };
  pickup: { available: boolean; branches: string[] };
  returns: { mode: string; window_days: number | null } | null;
  warranty_period: string | null;
  warranty_type: string | null;
  rating: number | null;
  rating_count: number;
  is_price_stale: boolean;
  is_cheapest: boolean;
  colors: string[];
  sizes: string[];
}

interface StoreComparisonDto {
  canonical_product_id: string;
  canonical_name_ar: string;
  canonical_name_en: string;
  store_count: number;
  total_store_count: number;
  lowest_price: string | null;
  applied: {
    zone: Zone | null;
    zone_source: "REQUEST" | "DEFAULT_ADDRESS" | "NONE";
    default_zone: Zone | null;
  };
  filter_options: {
    colors: { code: string; label: string; hex: string | null }[];
    sizes: { code: string; label: string }[];
    price: { min: number; max: number };
    zones: Zone[];
    has_discount: boolean;
    has_free_delivery: boolean;
    has_verified: boolean;
    has_returns: boolean;
    has_pickup: boolean;
  };
  stores: StoreRowDto[];
}

/** The comparison's filters. `zone` undefined = the server's default
 * (the signed-in customer's default address zone); "ALL" = no zone. */
interface Filters {
  colors: string[];
  sizes: string[];
  minPrice: number | null;
  maxPrice: number | null;
  zone: Zone | "ALL" | undefined;
  fulfilment: Fulfilment;
  availableOnly: boolean;
  discountedOnly: boolean;
  freeDeliveryOnly: boolean;
  verifiedOnly: boolean;
  returnsOnly: boolean;
}

const DEFAULT_FILTERS: Filters = {
  colors: [],
  sizes: [],
  minPrice: null,
  maxPrice: null,
  zone: undefined,
  fulfilment: "ALL",
  availableOnly: true,
  discountedOnly: false,
  freeDeliveryOnly: false,
  verifiedOnly: false,
  returnsOnly: false,
};
/** «مسح الكل»: no restriction at all - every zone, sold-out stores too. */
const NO_FILTERS: Filters = { ...DEFAULT_FILTERS, zone: "ALL", availableOnly: false };

function queryFor(f: Filters): string {
  const p = new URLSearchParams();
  if (f.colors.length) p.set("color", f.colors.join(","));
  if (f.sizes.length) p.set("size", f.sizes.join(","));
  if (f.minPrice !== null) p.set("min_price", String(f.minPrice));
  if (f.maxPrice !== null) p.set("max_price", String(f.maxPrice));
  if (f.zone) p.set("zone", f.zone);
  if (f.fulfilment !== "ALL") p.set("fulfilment", f.fulfilment);
  if (f.availableOnly) p.set("available_only", "true");
  if (f.discountedOnly) p.set("discounted_only", "true");
  if (f.freeDeliveryOnly) p.set("free_delivery_only", "true");
  if (f.verifiedOnly) p.set("verified_only", "true");
  if (f.returnsOnly) p.set("returns_only", "true");
  return p.toString();
}

function filterCount(f: Filters): number {
  return (
    f.colors.length +
    f.sizes.length +
    Number(f.minPrice !== null || f.maxPrice !== null) +
    Number(f.zone !== undefined && f.zone !== "ALL") +
    Number(f.fulfilment !== "ALL") +
    Number(f.discountedOnly) +
    Number(f.freeDeliveryOnly) +
    Number(f.verifiedOnly) +
    Number(f.returnsOnly)
  );
}

const toggle = (list: string[], value: string) =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

// Sprint 8 (PDR-016), rebuilt: this product compared BETWEEN STORES - one
// card and one logo per store (never one per colour/size), each showing
// that store's best offer for the filters; colour and size must be one
// variant together. The delivery zone starts from the customer's own
// default address (decided by the API). Never "add to cart" here: the
// card opens the chosen offer's page inside that store.
export default function ComparisonPage() {
  const params = useParams<{ canonicalProductId: string }>();
  const token = useSessionToken();
  const lang = useLang();
  const t = (key: string) => translate(lang, key);
  const taxonomy = useTaxonomy().data;
  const zoneName = (z: Zone) => t(`zone.${z}`);
  const { favoriteIds, favoritePendingIds, favoritesLoading, favoriteError, onToggleFavorite } =
    useProductFavorites(`/compare/${params.canonicalProductId}`);
  const favorited = favoriteIds.has(params.canonicalProductId);
  const favoriteBusy = favoritesLoading || favoritePendingIds.has(params.canonicalProductId);
  const [addedToSet, setAddedToSet] = useState(false);

  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [draft, setDraft] = useState<Filters | null>(null);
  const [sizeOffsets, setSizeOffsets] = useState<Record<string, number>>({});
  const [colorOffsets, setColorOffsets] = useState<Record<string, number>>({});
  const [storeStripState, setStoreStripState] = useState({ overflow: false, atStart: true, atEnd: true });
  const [result, setResult] = useState<{ key: string; data: StoreComparisonDto } | null>(null);
  const [error, setError] = useState<{ key: string; status: number; message: string } | null>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const storeStripRef = useRef<HTMLDivElement>(null);

  const query = queryFor(filters);
  // The token is part of the key: signing in brings the default zone.
  const key = `${token ?? ""}|${params.canonicalProductId}|${query}`;

  useEffect(() => {
    let cancelled = false;
    apiFetch<StoreComparisonDto>(`/canonical-products/${params.canonicalProductId}/store-comparison${query ? `?${query}` : ""}`)
      .then((data) => {
        if (!cancelled) setResult({ key, data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError({
          key,
          status: err instanceof ApiError ? err.status : 0,
          message: "cmp.err.load",
        });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` covers token, product and query
  }, [key]);

  // The drawer: Escape closes it, focus moves in and back out.
  useEffect(() => {
    if (!draft) return;
    const drawer = drawerRef.current;
    drawer?.querySelector<HTMLElement>("button, input, select")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDrawer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft !== null]);

  useEffect(() => {
    const strip = storeStripRef.current;
    if (!strip) return;
    const update = () => {
      const remaining = strip.scrollWidth - strip.clientWidth - strip.scrollLeft;
      setStoreStripState({
        overflow: strip.scrollWidth > strip.clientWidth + 2,
        atStart: strip.scrollLeft <= 2,
        atEnd: remaining <= 2,
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(strip);
    strip.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      observer.disconnect();
      strip.removeEventListener("scroll", update);
    };
  }, [result?.data.stores.length, key]);

  function closeDrawer() {
    setDraft(null);
    toggleRef.current?.focus();
  }

  function scrollStoreStrip(direction: 1 | -1) {
    storeStripRef.current?.scrollBy({ left: direction * 190, behavior: "smooth" });
  }

  async function addToNewSet() {
    if (!token) return;
    try {
      await apiFetch("/customers/me/comparison-sets", {
        method: "POST",
        body: { canonical_product_ids: [params.canonicalProductId] },
      });
      setAddedToSet(true);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
    }
  }

  const current = result?.key === key ? result.data : null;
  const shownError = error?.key === key ? error : null;
  // Keep the last result on screen (dimmed) while a new filter loads.
  const data = current ?? result?.data ?? null;

  if (shownError && !data) {
    return (
      <div className="compare-page page-shell">
        <BackToOrigin focusProductId={params.canonicalProductId} />
        <div className="wide-shell">
          {shownError.status === 404 ? (
            <EmptyState title={t("cmp.no_offers")} actionHref="/discovery" actionLabel={t("cmp.back_to_discovery")} />
          ) : (
            <ErrorBanner message={t("cmp.err.load")} />
          )}
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="compare-page page-shell">
        <BackToOrigin focusProductId={params.canonicalProductId} />
        <div className="wide-shell"><SkeletonGrid count={4} /></div>
      </div>
    );
  }

  const options = data.filter_options;
  // TB-25: colour and size names by code, in the interface language (the API's label as the fallback).
  const colorLabel = new Map(options.colors.map((c) => [c.code, colorName(taxonomy, c.code, lang, c.label) ?? c.label]));
  const sizeLabel = new Map(options.sizes.map((s) => [s.code, sizeName(s.code, s.label, lang) ?? s.label]));
  const image = data.stores.find((s) => s.image_url)?.image_url ?? null;
  const activeZone = data.applied.zone;
  const count = filterCount(filters);
  const conditions = new Set(data.stores.map((s) => s.condition));
  const ratedStores = data.stores.filter((s) => typeof s.rating === "number");
  const ratingCount = ratedStores.reduce((total, s) => total + s.rating_count, 0);
  const rating = ratedStores.length
    ? ratedStores.reduce((total, s) => total + (s.rating ?? 0) * Math.max(s.rating_count, 1), 0) /
      ratedStores.reduce((total, s) => total + Math.max(s.rating_count, 1), 0)
    : null;

  return (
    <div className="compare-page page-shell">
        <BackToOrigin focusProductId={params.canonicalProductId} />
      <div className="wide-shell">
        <div className="compare-product-layout">
          <section className="compare-product-content">
        <div className="compare-header">
          {image && <SafeImage src={image} alt="" className="compare-thumb" />}
          <div>
            <h1 className="page-title">{pickText(lang, data.canonical_name_en, data.canonical_name_ar)}</h1>
            <p className="page-subtitle compare-summary" style={{ margin: 0 }}>
              {rating !== null && <span className="compare-rating"><StarIcon /> {rating.toFixed(1)}{ratingCount > 0 ? fmt(t("cmp.n_ratings"), { n: ratingCount }) : ""}</span>}
              <span>{fmt(t("cmp.compare_between"), { stores: storeCountLabel(lang, data.store_count) })}</span>
              {data.lowest_price ? fmt(t("cmp.lowest"), { price: data.lowest_price }) : ""}
            </p>
          </div>
        </div>

        {token && (
          <div className="compare-quick-actions" aria-label={t("cmp.actions")}>
            <button
              className={`compare-quick-action${favorited ? " is-active" : ""}`}
              disabled={favoriteBusy}
              aria-pressed={favorited}
              aria-label={favorited ? t("shop.fav_remove") : t("shop.fav_add")}
              title={favorited ? t("shop.fav_remove") : t("shop.fav_add")}
              onClick={() => onToggleFavorite({ canonical_product_id: params.canonicalProductId })}
            >
              <span className="compare-quick-action-icon"><HeartIcon /></span>
            </button>
            <button
              className={`compare-quick-action${addedToSet ? " is-active" : ""}`}
              disabled={addedToSet}
              aria-label={addedToSet ? t("cmp.added_to_set") : t("cmp.add_to_set")}
              title={addedToSet ? t("cmp.added_to_set") : t("cmp.add_to_set")}
              onClick={addToNewSet}
            >
              <span className="compare-quick-action-icon"><StoreManageIcon /></span>
            </button>
            <Link href="/compare/sets" className="compare-quick-action" aria-label={t("cmp.my_sets")} title={t("cmp.my_sets")}>
              <span className="compare-quick-action-icon"><ClipboardIcon /></span>
            </Link>
          </div>
        )}
        {token && favoriteError && <ErrorBanner message={favoriteError} />}

        {data.stores.length > 0 && (
          <div className="compare-store-strip-shell" aria-label={t("cmp.stores_selling")}>
            {storeStripState.overflow && <button type="button" className="compare-store-arrow" disabled={storeStripState.atStart} aria-label={t("cmp.prev_stores")} onClick={() => scrollStoreStrip(-1)}>›</button>}
            <div ref={storeStripRef} className="compare-store-strip" dir="ltr">
              {data.stores.map((s) => (
                <StoreCircle
                  key={s.vendor_id}
                  name={s.display_name}
                  logoUrl={s.logo_url}
                  href={`/store/${s.vendor_slug}/products/${s.offer_id}`}
                  size={76}
                />
              ))}
            </div>
            {storeStripState.overflow && <button type="button" className="compare-store-arrow" disabled={storeStripState.atEnd} aria-label={t("cmp.next_stores")} onClick={() => scrollStoreStrip(1)}>‹</button>}
          </div>
        )}

        <div className="compare-toolbar">
          <button
            ref={toggleRef}
            type="button"
            className="compare-filter-toggle"
            onClick={() => setDraft({ ...filters })}
            aria-expanded={draft !== null}
            aria-controls="compare-filter-drawer"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M5.5 10h9M8 15h4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
            {t("list.filter")}{count > 0 ? ` (${count})` : ""}
          </button>
          <span className="compare-zone-note">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 10.3c0 5-7 10.4-7 10.4S5 15.3 5 10.3a7 7 0 1 1 14 0Z" fill="none" stroke="currentColor" strokeWidth="1.8" /><circle cx="12" cy="10.3" r="2.3" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>
            {activeZone
              ? fmt(t("cmp.delivery_to"), { zone: zoneName(activeZone), suffix: data.applied.zone_source === "DEFAULT_ADDRESS" ? t("cmp.default_address_suffix") : "" })
              : t("cmp.all_zones")}
          </span>
        </div>

        {data.stores.length === 0 ? (
          <div className="compare-empty" role="status">
            <p>{t("cmp.no_match")}</p>
            <button type="button" className="button-link" onClick={() => setFilters(NO_FILTERS)}>{t("cmp.clear_filters")}</button>
          </div>
        ) : (
          <Reveal className={`compare-grid${current ? "" : " is-stale"}`} aria-busy={!current}>
            {data.stores.map((s) => {
              const href = `/store/${s.vendor_slug}/products/${s.offer_id}`;
              const storeSizes = s.sizes.map((size) => ({ code: size, label: sizeLabel.get(size) ?? size }));
              const storeColors = s.colors.map((color) => ({
                code: color,
                label: colorLabel.get(color) ?? color,
                hex: options.colors.find((option) => option.code === color)?.hex ?? "#d9d0c8",
              }));
              const sizeWindow = 4;
              const colorWindow = 5;
              const sizeOffset = Math.min(sizeOffsets[s.vendor_id] ?? 0, Math.max(0, storeSizes.length - sizeWindow));
              const colorOffset = Math.min(colorOffsets[s.vendor_id] ?? 0, Math.max(0, storeColors.length - colorWindow));
              const discountPercent = s.is_discounted && s.original_price
                ? Math.round((1 - Number(s.price) / Number(s.original_price)) * 100)
                : null;
              return (
                <div key={s.vendor_id} className={`compare-card${s.is_cheapest ? " best" : ""}`} data-vendor={s.vendor_slug}>
                  {s.is_cheapest && <span className="compare-rank">{t("cmp.cheapest")}</span>}
                  {discountPercent && discountPercent > 0 && <span className="compare-discount compare-discount-floating">-{discountPercent}%</span>}
                  <div className="compare-card-header">
                    <Link href={href} className="compare-card-store" aria-label={fmt(t("cmp.open_store"), { name: s.display_name })}>
                      <span className="store-circle">
                        {s.logo_url ? <SafeImage src={s.logo_url} alt={s.display_name} /> : s.display_name.slice(0, 1)}
                        {s.is_verified && <span className="compare-verified" aria-label={t("cmp.verified")}>{t("cmp.verified")}</span>}
                      </span>
                    </Link>
                  </div>
                  <div className="compare-card-pricing">
                    <div className="compare-card-price-row">
                      {s.original_price && <s className="compare-price-old" aria-label={fmt(t("shop.was"), { price: s.original_price })}>{s.original_price} ₪</s>}
                      <div className="product-card-price">{s.price} ₪</div>
                    </div>
                    <span className={`availability-badge availability-${s.availability}`}>{availabilityLabel(lang, s.availability)}</span>
                  </div>
                  <div className="compare-card-options compare-card-choices">
                    {storeSizes.length > 0 && <div className="compare-choice-row"><b>{t("cmp.sizes")}</b><span className="compare-choice-carousel">{storeSizes.length > sizeWindow && <button type="button" className="compare-choice-arrow" disabled={sizeOffset === 0} aria-label={t("cmp.prev_sizes")} onClick={() => setSizeOffsets((current) => ({ ...current, [s.vendor_id]: Math.max(0, sizeOffset - 1) }))}>›</button>}<span className="compare-size-chips">{storeSizes.slice(sizeOffset, sizeOffset + sizeWindow).map((size) => <i key={size.code} className={s.size === size.code ? "is-selected" : ""}>{size.label}</i>)}</span>{storeSizes.length > sizeWindow && <button type="button" className="compare-choice-arrow" disabled={sizeOffset >= storeSizes.length - sizeWindow} aria-label={t("cmp.next_sizes")} onClick={() => setSizeOffsets((current) => ({ ...current, [s.vendor_id]: Math.min(storeSizes.length - sizeWindow, sizeOffset + 1) }))}>‹</button>}</span></div>}
                    {storeColors.length > 0 && <div className="compare-choice-row compare-colors"><b>{t("cmp.color")}</b><span className="compare-choice-carousel">{storeColors.length > colorWindow && <button type="button" className="compare-choice-arrow" disabled={colorOffset === 0} aria-label={t("cmp.prev_colors")} onClick={() => setColorOffsets((current) => ({ ...current, [s.vendor_id]: Math.max(0, colorOffset - 1) }))}>›</button>}<span className="compare-color-dots">{storeColors.slice(colorOffset, colorOffset + colorWindow).map((color) => <i key={color.code} title={color.label} className={s.color === color.code ? "is-selected" : ""} style={{ background: color.hex }} />)}</span>{storeColors.length > colorWindow && <button type="button" className="compare-choice-arrow" disabled={colorOffset >= storeColors.length - colorWindow} aria-label={t("cmp.next_colors")} onClick={() => setColorOffsets((current) => ({ ...current, [s.vendor_id]: Math.min(storeColors.length - colorWindow, colorOffset + 1) }))}>‹</button>}</span></div>}
                  </div>
                  <div className="compare-card-details compare-card-service-list">
                    <div><span className="compare-service-icon"><ManagementTileIcon name="pin" /></span><p><b>{t("cmp.delivers_to")}</b> {s.delivery.zones.length ? s.delivery.zones.map((z) => `${zoneName(z.region)} (${z.fee === 0 ? t("cmp.free") : fmt(t("cmp.fee"), { fee: z.fee })})`).join(t("cmp.list_sep")) : t("cmp.no_delivery")}</p></div>
                    {s.delivery.earliest_slot && (s.delivery.status === "AVAILABLE" || s.delivery.status === "NO_ZONE_SELECTED") && <div className="compare-slot-line">{fmt(t("cmp.earliest"), { day: formatSlotDay(s.delivery.earliest_slot.date, lang) })}<bdi dir="ltr" className="slot-hours">{slotHours(s.delivery.earliest_slot)}</bdi> <small>{t("cmp.estimate")}</small></div>}
                    {s.delivery.status === "NOT_AVAILABLE_IN_ZONE" && <div className="compare-line-warning">{t("cmp.not_in_zone")}</div>}
                    {s.delivery.status === "NO_UPCOMING_SLOTS" && <div className="compare-line-warning">{t("cmp.no_slots")}</div>}
                    {s.delivery.status === "NO_ELIGIBLE_STOCK" && s.availability !== "sold_out" && <div className="compare-line-warning">{t("cmp.no_delivery_stock")}</div>}
                    {s.delivery.status === "NOT_PURCHASABLE" && <div className="compare-line-warning">{t("cmp.not_purchasable")}</div>}
                    <div><span className="compare-service-icon"><ManagementTileIcon name="store" /></span><p><b>{t("cmp.pickup")}</b> {s.pickup.available ? s.pickup.branches.join(t("cmp.list_sep")) : t("cmp.unavailable")}</p></div>
                    <div><span className="compare-service-icon"><ManagementTileIcon name="shield" /></span><p><b>{t("cmp.warranty")}</b> {s.warranty_period ?? t("cmp.unavailable")}</p></div>
                    {s.returns && <div><span className="compare-service-icon"><ManagementTileIcon name="return" /></span><p><b>{t("cmp.returns")}</b> {t(`cmp.ret.${s.returns.mode}`) === `cmp.ret.${s.returns.mode}` ? t("cmp.ret.available") : t(`cmp.ret.${s.returns.mode}`)}{s.returns.window_days ? fmt(t("cmp.within_days"), { n: s.returns.window_days }) : ""}</p></div>}
                  </div>
                  {s.is_price_stale && <span className="compare-card-stale">{t("cmp.stale")}</span>}
                  {conditions.size > 1 && <span className="compare-card-stale">{fmt(t("cmp.condition"), { c: s.condition })}</span>}
                  <Link href={href} className="button button-block compare-card-open" style={{ marginTop: "auto" }}><BagIcon />{t("cmp.open_in_store")}</Link>
                </div>
              );
            })}
          </Reveal>
        )}
          </section>
        </div>
      </div>

      {draft && (
        <>
          <button className="store-filter-scrim" type="button" aria-label={t("cmp.close_filter")} onClick={closeDrawer} />
          <aside
            ref={drawerRef}
            id="compare-filter-drawer"
            className="store-filter-drawer compare-filter-drawer"
            role="dialog"
            aria-modal="true"
            aria-label={t("cmp.filter_stores")}
          >
            <div className="store-filter-head">
              <div><span>{t("cmp.compare_stores")}</span><h2>{t("list.filter")}</h2></div>
              <button type="button" className="store-filter-close" aria-label={t("cmp.close_filter")} onClick={closeDrawer}>
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
              </button>
            </div>
            <div className="store-filter-scroll">
              <fieldset className="store-filter-group"><legend>{t("cmp.price")}</legend><div className="store-filter-price">
                <span>
                  {fmt(t("cmp.price_range"), { min: draft.minPrice ?? options.price.min, max: draft.maxPrice ?? options.price.max })}
                </span>
                <input type="range" aria-label={t("cmp.price_min")} min={options.price.min} max={options.price.max} step={1}
                  value={draft.minPrice ?? options.price.min}
                  onChange={(e) => { const v = Math.min(Number(e.target.value), draft.maxPrice ?? options.price.max); setDraft({ ...draft, minPrice: v <= options.price.min ? null : v }); }} />
                <input type="range" aria-label={t("cmp.price_max")} min={options.price.min} max={options.price.max} step={1}
                  value={draft.maxPrice ?? options.price.max}
                  onChange={(e) => { const v = Math.max(Number(e.target.value), draft.minPrice ?? options.price.min); setDraft({ ...draft, maxPrice: v >= options.price.max ? null : v }); }} />
              </div></fieldset>
              {options.sizes.length > 0 && (
                <fieldset className="store-filter-group"><legend>{t("cmp.size")}</legend><div className="store-filter-options store-filter-options-compact">
                  {options.sizes.map((s) => (
                    <button key={s.code} type="button" data-size={s.code} aria-pressed={draft.sizes.includes(s.code)} onClick={() => setDraft({ ...draft, sizes: toggle(draft.sizes, s.code) })}>{sizeLabel.get(s.code) ?? s.label}</button>
                  ))}
                </div></fieldset>
              )}
              {options.colors.length > 0 && (
                <fieldset className="store-filter-group"><legend>{t("cmp.color_legend")}</legend><div className="store-filter-colors">
                  {options.colors.map((c) => (
                    <label key={c.code} data-color={c.code}>
                      <input type="checkbox" checked={draft.colors.includes(c.code)} onChange={() => setDraft({ ...draft, colors: toggle(draft.colors, c.code) })} />
                      {c.hex && <i className="following-feed-swatch" style={{ background: c.hex }} aria-hidden="true" />}
                      <span>{colorLabel.get(c.code) ?? c.label}</span>
                    </label>
                  ))}
                </div></fieldset>
              )}
              <fieldset className="store-filter-group"><legend>{t("cmp.zone")}</legend>
                <select
                  className="compare-zone-select"
                  aria-label={t("cmp.zone")}
                  value={draft.zone ?? ""}
                  onChange={(e) => setDraft({ ...draft, zone: e.target.value === "" ? undefined : (e.target.value as Zone | "ALL") })}
                >
                  {data.applied.default_zone && <option value="">{fmt(t("cmp.my_default_address"), { zone: zoneName(data.applied.default_zone) })}</option>}
                  {!data.applied.default_zone && <option value="">{t("cmp.no_limit")}</option>}
                  <option value="ALL">{t("cmp.all_areas")}</option>
                  {options.zones.map((z) => <option key={z} value={z}>{zoneName(z)}</option>)}
                </select>
              </fieldset>
              <fieldset className="store-filter-group"><legend>{t("cmp.fulfilment")}</legend><div className="store-filter-options">
                {(["ALL", "DELIVERY", "PICKUP"] as const).map((value) => (
                  <button key={value} type="button" data-fulfilment={value} aria-pressed={draft.fulfilment === value}
                    disabled={value === "PICKUP" && !options.has_pickup}
                    onClick={() => setDraft({ ...draft, fulfilment: value })}>{t(`cmp.ful.${value}`)}</button>
                ))}
              </div></fieldset>
              <fieldset className="store-filter-group compare-filter-checks"><legend>{t("cmp.store_and_offer")}</legend>
                <label className="store-filter-availability"><input type="checkbox" checked={draft.availableOnly} onChange={(e) => setDraft({ ...draft, availableOnly: e.target.checked })} /><span>{t("cmp.available_only")}</span></label>
                {options.has_discount && <label className="store-filter-availability"><input type="checkbox" checked={draft.discountedOnly} onChange={(e) => setDraft({ ...draft, discountedOnly: e.target.checked })} /><span>{t("cmp.discounted_only")}</span></label>}
                {options.has_free_delivery && <label className="store-filter-availability"><input type="checkbox" checked={draft.freeDeliveryOnly} onChange={(e) => setDraft({ ...draft, freeDeliveryOnly: e.target.checked })} /><span>{t("cmp.free_delivery_only")}</span></label>}
                {options.has_verified && <label className="store-filter-availability"><input type="checkbox" checked={draft.verifiedOnly} onChange={(e) => setDraft({ ...draft, verifiedOnly: e.target.checked })} /><span>{t("cmp.verified_only")}</span></label>}
                {options.has_returns && <label className="store-filter-availability"><input type="checkbox" checked={draft.returnsOnly} onChange={(e) => setDraft({ ...draft, returnsOnly: e.target.checked })} /><span>{t("cmp.returns_only")}</span></label>}
              </fieldset>
            </div>
            <div className="store-filter-actions">
              <button type="button" onClick={() => setDraft({ ...NO_FILTERS })}>{t("cmp.clear_all")}</button>
              <button type="button" onClick={() => { setFilters(draft); closeDrawer(); }}>{t("cmp.show_results")}</button>
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
