"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, ReactNode, useEffect, useState } from "react";
import { ExpandIcon, HeartIcon, StarIcon, WhatsAppIcon } from "@/components/Icons";
import ProductCard from "@/components/ProductCard";
import ProductReviews from "@/components/ProductReviews";
import SizeGuideModal from "@/components/SizeGuideModal";
import OfferPairingsSection from "@/components/OfferPairingsSection";
import BestsellerBadge from "@/components/BestsellerBadge";
import type { BestsellerMark } from "@/lib/types";
import { EarliestSlot, estimateNote, formatSlotDay, hoursTodayText, laterSlotsText, slotHours } from "@/lib/deliveryPromise";
import { SIZE_GUIDE_TEXT, type SizeGuidePublicDto } from "@/lib/sizeGuides";
import { useLang } from "@/lib/useLang";
import SafeImage from "@/components/SafeImage";
import StoreCircle from "@/components/StoreCircle";
import { EmptyState, ErrorBanner, SkeletonGrid } from "@/components/States";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { Availability, type ComparisonCardDto } from "@/lib/types";
import { clearSession } from "@/lib/session";
import { useTaxonomy } from "@/lib/taxonomy";
import { useProductFavorites } from "@/lib/useProductFavorites";
import { useHydrated, useSessionToken } from "@/lib/useSession";
import { useFetch } from "@/lib/useFetch";
import { productWhatsappMessage, whatsappChatUrl } from "@/lib/whatsapp";
import ZonePicker, { type ZoneChoice } from "@/components/ZonePicker";
import { cartQuantityErrorMessage } from "@/lib/cart";
import { type Lang, translate } from "@/lib/i18n";
import { apiErrorMessage } from "@/lib/apiErrors";
import { audienceName, categoryName as taxonomyCategoryName, colorName as taxonomyColorName, pickText, seasonName, sizeName } from "@/lib/localized";
import { availabilityLabel, fmt, storeCountLabel } from "@/lib/shopText";
import { type UiMsg, uiMsgText } from "@/lib/storeText";
import { colorThumbnails } from "@/lib/colorThumbnails";
import { colorDisplayName, swatchBackground } from "@/lib/colorName";
import "@/lib/pdpText";
import { loginRedirectHref } from "@/lib/loginRedirect";
import { CompositionView } from "@/components/CompositionView";
import type { Composition } from "@/lib/composition";
import { specValueText } from "@/lib/specCodes";
import "@/lib/offerWizardText";

interface OfferVariantDto {
  id: string;
  condition: string;
  currency: "ILS";
  base_price: string;
  sale_price: string | null;
  specs_text_ar: string | null;
  specs_text_en: string | null;
  canonical_variant_id: string | null;
  // null for an unmatched variant - the signal for whether a "compare
  // prices" action can be shown at all.
  canonical_product_id: string | null;
  structural_attributes: Record<string, unknown> | null;
  availability: Availability;
  // PD-2: this variant's delivery/pickup facts, decided by the server
  // (the same source checkout uses) - the page only displays them.
  fulfilment?: VariantFulfilmentDto;
  // PD-1: this variant's own colour/size and its ordered media.
  color_code?: string | null;
  color_label?: string | null;
  /** Product colours: the version's own product colour (its id and names). */
  color_id?: string | null;
  color_name_en?: string | null;
  size_code?: string | null;
  size_label?: string | null;
  media?: {
    url: string;
    kind: "PRIMARY" | "ADDITIONAL";
    media_type: "IMAGE" | "VIDEO";
    alt_text_ar: string | null;
    alt_text_en: string | null;
    sort_order: number;
  }[];
}

interface OfferDetailDto {
  id: string;
  vendor_id: string;
  vendor_slug: string;
  vendor_display_name: string;
  title_ar: string;
  title_en: string;
  images: string[];
  variants: OfferVariantDto[];
  // PD-2: can the store take an order now; the zone used; its zones.
  purchasable?: boolean;
  fulfilment_context?: { zone: Zone | null; zone_source: "REQUEST" | "DEFAULT_ADDRESS" | "NONE"; default_zone: Zone | null };
  delivery_zones?: { region: Zone; fee: number }[];
  // PD-4: a published size guide applies (the only time a link shows).
  size_guide_available?: boolean;
  /** Phase A++ (item 4): the product's specifications (codes for fit/stretch/occasion/care). */
  template_attributes?: Record<string, string> | null;
  /** Fabric composition and country of origin (the same view for the published page and the preview). */
  composition?: Composition | null;
  country_of_origin?: string | null;
  /** Phase A+: OFFER = the product's own measurements table. */
  size_guide_kind?: "STANDARD" | "PRODUCT" | "OFFER" | null;
  /** Phase A++ (item 5): the model in the photos - one of the product's sizes. */
  model?: { height_cm: number; size_code: string; size_label: string } | null;
  /** Phase A++ (item 6): images every colour shares, after the colour's own. */
  shared_images?: string[];
  // PD-5.3: the scope this offer is a qualified bestseller in (flag-gated).
  bestseller?: BestsellerMark | null;
}

type DeliveryStatus = "AVAILABLE" | "NO_ZONE_SELECTED" | "NOT_IN_ZONE" | "NO_UPCOMING_SLOTS" | "NO_ELIGIBLE_STOCK" | "NOT_OFFERED" | "NOT_PURCHASABLE";

interface VariantFulfilmentDto {
  availability: Availability;
  delivery: {
    status: DeliveryStatus;
    fee: number | null;
    minimum_order_value: number | null;
    earliest_slot_date: string | null;
    // PD-5.1: the earliest bookable window and the last day with one.
    earliest_slot?: EarliestSlot | null;
    latest_slot_date?: string | null;
  };
  pickup: {
    status: "AVAILABLE" | "NO_PICKUP_BRANCH_WITH_STOCK" | "NOT_PURCHASABLE";
    branches: { name: string; minimum_order_value: number | null; hours_set?: boolean; hours_today?: { open: string; close: string } | null }[];
  };
}

/** GET /storefronts/:slug/offers/:offerId/options (S27 classified offers). */
interface OfferOptionsDto {
  classified: boolean;
  audiences: string[];
  categories: string[];
  season: string | null;
  /** Product colours: the product's own colours in the seller's order (`id`; older API: the family `code` only). */
  colors: {
    id?: string;
    code: string;
    family_code?: string;
    family_hex?: string | null;
    name_ar: string;
    name_en?: string | null;
    hex: string | null;
    swatch_url?: string | null;
  }[];
  sizes: { code: string; label: string; group: string }[];
  combinations: { variant_id: string; color_id?: string | null; color_code: string | null; size_code: string | null; availability: Availability }[];
}

interface AvailabilitySubscriptionDto {
  offer_variant_id: string;
}

interface StorefrontDto {
  slug: string;
  logo_url: string | null;
  display_name: string;
  bio: string | null;
  whatsapp_url: string | null;
  is_verified: boolean;
  follower_count: number;
}

interface StoreInfoDto {
  is_available: boolean;
  branches: { id: string; name: string; is_physical: boolean }[];
  returns: { mode: string; window_days: number | null; refund_fee_ils?: number | null } | null;
}

type Zone = "WEST_BANK" | "JERUSALEM" | "INSIDE";
// TB-25: zone, return-mode, season and audience names come from the
// translation table (zone.*, pdp.ret.*) and the taxonomy (by language).
const AUDIENCE_PAGE: Record<string, { href: string }> = {
  WOMEN: { href: "/women" },
  MEN: { href: "/men" },
  KIDS: { href: "/kids" },
};
function optionLabel(v: OfferVariantDto, index: number, lang: Lang): string {
  const values = Object.values(v.structural_attributes ?? {}).filter(
    (x) => typeof x === "string" && x !== "",
  );
  return values.length > 0 ? values.join(" / ") : fmt(translate(lang, "pdp.option_n"), { n: index + 1 });
}

/** Product colours: a colour's identity on this page - its product colour id (older API: its family code). */
function colorKey(c: { id?: string; code: string }): string {
  return c.id ?? c.code;
}
function comboColor(c: { color_id?: string | null; color_code: string | null }): string | null {
  return c.color_id ?? c.color_code;
}

function Stars({ value }: { value: number }) {
  return (
    <span className="pdp-stars" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={value >= i - 0.25 ? "on" : value >= i - 0.75 ? "half" : ""}><StarIcon /></span>
      ))}
    </span>
  );
}

/** One collapsible row of the details column (Description, Size & Fit...). */
function Section({ title, summary, defaultOpen = false, children }: { title: string; summary?: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`pdp-section${open ? " is-open" : ""}`}>
      <button type="button" className="pdp-section-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <strong>{title}</strong>
        {summary && !open && <span className="pdp-section-summary">{summary}</span>}
        <span className="pdp-section-sign" aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open && <div className="pdp-section-body">{children}</div>}
    </section>
  );
}

// The in-store product page (a store's own offer). Laid out like a large
// fashion store's product page: gallery with a thumbnail rail, then the
// title/price/colour/size/cart column with shipping, returns and the
// details accordions, reviews under the gallery and similar products
// below. Our own additions stay: the store the card came from, "يباع في
// N متاجر", compare prices, ask on WhatsApp and report a wrong match.
// "أضيفي للسلة" needs a signed-in customer (a guest signs in and returns).
//
// Phase A++ (item 3): this is the ONE product page - the live store page
// (app/store/[slug]/products/[offerId]) and the owner's «معاينة» of a
// draft (app/vendor/[vendorId]/offers/drafts/[draftId]/preview) both
// render it. In preview mode its data comes from one owner-only read in
// the same shapes (GET .../offer-drafts/:id/preview), every action is
// switched off (cart, favourite, follow, report, share, WhatsApp, zone)
// and nothing is sent; reviews and «نسّقي معه» belong to a published
// product and are not shown.
export type ProductDetailSource =
  | { mode: "live"; slug: string; offerId: string }
  | { mode: "preview"; vendorId: string; draftId: string };

interface DraftPreviewDto {
  draft_status: string;
  vendor_slug: string;
  offer: OfferDetailDto;
  options: OfferOptionsDto;
  size_guide: SizeGuidePublicDto;
}

export default function ProductDetailView({ source }: { source: ProductDetailSource }) {
  const live = source.mode === "live";
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const token = useSessionToken();
  // Until hydration the token reads as null - the buttons must not say
  // "sign in" to a signed-in shopper meanwhile.
  const hydrated = useHydrated();
  const taxonomy = useTaxonomy();
  // PD-2: "" = the server's default (the account's default address
  // zone); "ALL" or a zone = the shopper's own choice.
  const [zoneChoice, setZoneChoice] = useState<ZoneChoice>("");
  const offer = useFetch<OfferDetailDto>(
    source.mode === "live" ? `/storefronts/${source.slug}/offers/${source.offerId}${zoneChoice ? `?zone=${zoneChoice}` : ""}` : null,
    true,
  );
  // Phase A++ (item 3): the preview's one read - the same shapes as the three public ones.
  const preview = useFetch<DraftPreviewDto>(
    source.mode === "preview" ? `/vendors/${source.vendorId}/offer-drafts/${source.draftId}/preview` : null,
    true,
  );
  const slug = source.mode === "live" ? source.slug : (preview.data?.vendor_slug ?? null);
  const offerId = source.mode === "live" ? source.offerId : source.draftId;
  const options = useFetch<OfferOptionsDto>(source.mode === "live" ? `/storefronts/${source.slug}/offers/${source.offerId}/options` : null);
  const store = useFetch<StorefrontDto>(slug ? `/storefronts/${slug}` : null);
  const info = useFetch<StoreInfoDto>(slug ? `/storefronts/${slug}/info` : null);
  const followStatus = useFetch<{ following: boolean }>(token && live ? `/customers/me/following/${slug}` : null, true);

  const [selected, setSelected] = useState<string | null>(null);
  // Query values are only initial UI choices (the API still resolves the
  // exact version). This preserves colour/size through the sign-in return
  // without a synchronously state-setting effect.
  const [color, setColor] = useState<string | null>(() => searchParams.get("color"));
  const [size, setSize] = useState<string | null>(() => searchParams.get("size"));
  // The shown image of the current variant's gallery; every colour/size/
  // variant change starts again at its first image.
  const [gallery, setGallery] = useState<{ variantId: string | null; index: number }>({ variantId: null, index: 0 });
  const resetGallery = () => setGallery({ variantId: null, index: 0 });
  const [zoomOpen, setZoomOpen] = useState(false);
  // PD-3: the reviews section reports the aggregate for the title row.
  const [rating, setRating] = useState<{ average: number | null; count: number } | null>(null);
  // PD-4: the size-guide window; focusNotes = opened from "ليس مقاسك؟".
  const [sizeGuide, setSizeGuide] = useState<{ focusNotes: boolean } | null>(null);
  const lang = useLang();
  const t = (key: string) => translate(lang, key);
  const sgText = SIZE_GUIDE_TEXT[lang];
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);
  const [cartError, setCartError] = useState<UiMsg | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [availabilityBusy, setAvailabilityBusy] = useState(false);
  const [availabilityOverride, setAvailabilityOverride] = useState<boolean | null>(null);
  const [followOverride, setFollowOverride] = useState<{ token: string; following: boolean } | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  // Sprint 17b: lets a signed-in customer flag a wrong product match on
  // the variant they're actually looking at (the same variant id the
  // add-to-cart flow above already uses) - no note content or reporter
  // identity ever surfaces anywhere except here, by design.
  const [reportOpen, setReportOpen] = useState(false);
  const [reportNote, setReportNote] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const [reportDone, setReportDone] = useState(false);
  const [reportError, setReportError] = useState<UiMsg | null>(null);

  // A zone change refetches the detail: keep showing the last one meanwhile.
  const [shownOffer, setShownOffer] = useState<OfferDetailDto | null>(null);
  if (offer.data && offer.data !== shownOffer) setShownOffer(offer.data);
  const data = live ? (offer.data ?? shownOffer) : (preview.data?.offer ?? null);
  const optionsData = live ? options.data : (preview.data?.options ?? null);
  const opts = optionsData?.classified ? optionsData : null;
  const canonicalId = data?.variants.find((v) => v.canonical_product_id)?.canonical_product_id ?? null;
  const card = useFetch<{ store_count: number }>(canonicalId ? `/canonical-products/${canonicalId}/comparison-card` : null);
  const favorites = useProductFavorites(pathname);

  // Similar products: the same department + category, from every store.
  const audience = opts?.audiences[0] ?? null;
  const category = opts?.categories[0] ?? null;
  const similar = useFetch<{ items: ComparisonCardDto[] }>(
    live && audience ? `/discovery/all?audience=${audience}${category ? `&category=${category}` : ""}&sort=newest&page_size=11` : null,
  );

  useEffect(() => {
    if (!zoomOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setZoomOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomOpen]);

  // A classified offer is chosen by colour + size (one combination); a
  // legacy one by its variant chips.
  const combo = opts
    ? (opts.combinations.find((c) => (color === null || comboColor(c) === color) && (size === null || c.size_code === size)) ?? null)
    : null;
  const variant = data
    ? (data.variants.find((v) => v.id === (opts ? combo?.variant_id : selected)) ?? data.variants[0])
    : null;
  const availabilitySubscriptions = useFetch<AvailabilitySubscriptionDto[]>(
    token && live && variant
      ? `/customers/me/availability-subscriptions?offer_variant_id=${encodeURIComponent(variant.id)}`
      : null,
    true,
  );
  const activeColor = opts ? (color ?? (combo ? comboColor(combo) : null)) : null;

  const imageIndex = gallery.variantId === (variant?.id ?? null) ? gallery.index : 0;
  const setImageIndex = (index: number) => setGallery({ variantId: variant?.id ?? null, index });

  async function addToCart() {
    if (!live) return;
    if (!token) {
      router.push(loginRedirectHref());
      return;
    }
    if (!data || !variant) return;
    if (opts && opts.sizes.length > 0 && size === null) {
      setCartError({ key: "pdp.pick_size_first" });
      return;
    }
    setAdding(true);
    setCartError(null);
    try {
      await apiFetch("/cart/items", {
        method: "POST",
        body: { vendor_id: data.vendor_id, offer_variant_id: variant.id, quantity: 1 },
        idempotencyKey: newIdempotencyKey("cart-add"),
      });
      setAdded(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        router.push(loginRedirectHref());
        return;
      }
      setCartError({ api: err, key: "pdp.err.cart" });
    } finally {
      setAdding(false);
    }
  }

  async function toggleAvailabilitySubscription() {
    if (!live || !variant) return;
    if (!token) {
      router.push(loginRedirectHref());
      return;
    }
    const subscribed = availabilityOverride ?? (availabilitySubscriptions.data?.some((row) => row.offer_variant_id === variant.id) ?? false);
    setAvailabilityBusy(true);
    try {
      await apiFetch(`/customers/me/availability-subscriptions/${encodeURIComponent(variant.id)}`, {
        method: subscribed ? "DELETE" : "POST",
      });
      setAvailabilityOverride(!subscribed);
    } catch (err) {
      setCartError({ api: err, key: "pdp.err.availability" });
    } finally {
      setAvailabilityBusy(false);
    }
  }

  async function submitMatchReport() {
    if (!live || !variant) return;
    setReportBusy(true);
    setReportError(null);
    try {
      await apiFetch("/me/match-reports", {
        method: "POST",
        body: { offer_variant_id: variant.id, note: reportNote.trim() || undefined },
      });
      setReportOpen(false);
      setReportNote("");
      setReportDone(true);
    } catch (err) {
      setReportError({ api: err, key: "pdp.err.report" });
    } finally {
      setReportBusy(false);
    }
  }

  const following = followOverride?.token === token && token ? followOverride.following : (followStatus.data?.following ?? false);
  async function toggleFollow() {
    if (!live) return;
    if (!token) {
      router.push(loginRedirectHref());
      return;
    }
    setFollowBusy(true);
    try {
      const res = await apiFetch<{ following: boolean }>(`/customers/me/following/${slug}`, { method: following ? "DELETE" : "PUT" });
      setFollowOverride({ token, following: res.following });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        router.push(loginRedirectHref());
      }
    } finally {
      setFollowBusy(false);
    }
  }

  async function share() {
    if (!live) return;
    const url = window.location.href;
    try {
      if (navigator.share) await navigator.share({ title: data ? pickText(lang, data.title_en, data.title_ar) : undefined, url });
      else {
        await navigator.clipboard.writeText(url);
        setNotice("pdp.link_copied");
        setTimeout(() => setNotice(null), 2500);
      }
    } catch {
      // The share sheet was dismissed.
    }
  }

  const loadError = live ? offer.error : preview.error;
  const loadStatus = live ? offer.status : preview.status;
  if (loadError) {
    return (
      <div className="page-shell">
        <div className="wide-shell">
          {loadStatus === 404 ? (
            <EmptyState title={t("pdp.not_found")} actionHref={slug ? `/store/${slug}` : "/"} actionLabel={t("pdp.back_to_store")} />
          ) : (
            <ErrorBanner message={t("pdp.err.load")} />
          )}
        </div>
      </div>
    );
  }
  if (!data || !variant) {
    return (
      <div className="page-shell">
        <div className="wide-shell"><SkeletonGrid count={2} /></div>
      </div>
    );
  }

  const price = variant.sale_price ?? variant.base_price;
  // TB-25: the product's name in the interface language (Arabic when there is no English).
  const title = pickText(lang, data.title_en, data.title_ar);
  // PD-1: the chosen variant's own images (videos come in a later phase).
  // A variant without images - none at all, or video only - shows the
  // offer's images from its other variants instead, labelled as a
  // representative image; an older API without per-variant media falls
  // back to the flattened list.
  const imagesOf = (v: OfferVariantDto) =>
    (v.media ?? []).filter((m) => m.media_type === "IMAGE").map((m) => ({ url: m.url, alt: pickText(lang, m.alt_text_en, m.alt_text_ar) || title }));
  const ownImages = imagesOf(variant);
  const offerImages = Array.from(
    new Map(
      [variant, ...data.variants.filter((v) => v.id !== variant.id)]
        .flatMap(imagesOf)
        .map((img) => [img.url, img]),
    ).values(),
  );
  const hasPerVariantMedia = data.variants.some((v) => v.media !== undefined);
  const galleryItems = ownImages.length > 0
    ? ownImages
    : offerImages.length > 0
      ? offerImages
      : hasPerVariantMedia
        ? []
        : data.images.map((url) => ({ url, alt: title }));
  const representative = ownImages.length === 0 && galleryItems.length > 0;
  // Phase A++ (item 6): the product's shared images come after the colour's own.
  for (const url of data.shared_images ?? []) {
    if (!galleryItems.some((g) => g.url === url)) galleryItems.push({ url, alt: title });
  }
  const images = galleryItems.map((img) => img.url);
  // PD-2: availability and the cart button follow the server's facts.
  const facts = variant.fulfilment ?? null;
  const ctx = data.fulfilment_context ?? null;
  const availability: Availability = facts?.availability ?? (opts ? (combo?.availability ?? "sold_out") : variant.availability);
  const soldOut = availability === "sold_out" || data.purchasable === false || (opts ? !combo : false);
  // the same sold-out choice in the published page and in the owner's preview (where nothing can be sent)
  const exactSoldOutSelection = !!opts && !!combo && !!activeColor && !!size && combo.availability === "sold_out" && (!live || data.purchasable !== false);
  const availabilitySubscribed = availabilityOverride ?? (variant ? (availabilitySubscriptions.data?.some((row) => row.offer_variant_id === variant.id) ?? false) : false);
  const base = Number.parseFloat(variant.base_price);
  const sale = variant.sale_price ? Number.parseFloat(variant.sale_price) : null;
  const discountPercent = sale !== null && base > sale ? Math.round((1 - sale / base) * 100) : null;
  // Sprint 26: ask the store about THIS product on WhatsApp, when the
  // owner has set a WhatsApp link at all.
  const whatsappHref = store.data?.whatsapp_url
    ? whatsappChatUrl(store.data.whatsapp_url, productWhatsappMessage(store.data.display_name, data.title_ar, price))
    : null;
  const categoryName = taxonomyCategoryName(taxonomy.data, category, lang);
  const audiencePage = audience && AUDIENCE_PAGE[audience]
    ? { href: AUDIENCE_PAGE[audience].href, label: audienceName(taxonomy.data, audience, lang, t(`aud.${audience}`)) ?? audience }
    : null;
  /**
   * A colour's name in the interface language. Product colours: its own name
   * (English empty -> the Arabic name itself); an older API: the family's.
   */
  const colorLabel = (c: OfferOptionsDto["colors"][number]) =>
    c.id ? colorDisplayName(c, lang) : (taxonomyColorName(taxonomy.data, c.code, lang, c.name_ar) ?? c.name_ar);
  const colorName = activeColor ? (() => {
    const c = opts?.colors.find((x) => colorKey(x) === activeColor);
    return c ? colorLabel(c) : null;
  })() : null;
  /** Keep the exact requested option in the address so a sign-in round trip
      lands back on the same colour and size. This is presentation state only;
      cart and subscription calls still use the server-issued variant id. */
  function rememberOption(nextColor: string | null, nextSize: string | null) {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (nextColor) url.searchParams.set("color", nextColor); else url.searchParams.delete("color");
    if (nextSize) url.searchParams.set("size", nextSize); else url.searchParams.delete("size");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }
  // TB-25.3: each colour's thumbnail (its own first main image, or null -> colour circle).
  const thumbs = colorThumbnails(data.variants, opts?.colors.map(colorKey) ?? []);
  /** The colour change, exactly as the colour circles did it before TB-25.3. */
  function chooseColor(code: string) {
    if (!opts) return;
    setColor(code);
    resetGallery();
    const nextSize = size && opts.combinations.some((x) => comboColor(x) === code && x.size_code === size) ? size : null;
    if (nextSize !== size) setSize(null);
    rememberOption(code, nextSize);
    setAdded(false);
    setAvailabilityOverride(null);
  }
  /** Radio-group keys: arrows move and choose (left/right follow the reading direction), Home/End jump. */
  function onColorKey(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!opts || opts.colors.length === 0) return;
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const codes = opts.colors.map(colorKey);
    const current = Math.max(0, codes.indexOf(activeColor ?? codes[0]));
    let next: number | null = null;
    if (event.key === "ArrowDown" || event.key === (rtl ? "ArrowLeft" : "ArrowRight")) next = (current + 1) % codes.length;
    else if (event.key === "ArrowUp" || event.key === (rtl ? "ArrowRight" : "ArrowLeft")) next = (current - 1 + codes.length) % codes.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = codes.length - 1;
    if (next === null) return;
    event.preventDefault();
    chooseColor(codes[next]);
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
  }
  const cartErrorText = (m: UiMsg) =>
    "api" in m && m.api instanceof ApiError
      ? (cartQuantityErrorMessage(m.api.code, m.api.details, lang) ?? apiErrorMessage(m.api, lang))
      : uiMsgText(m, lang);
  // A size can be selected if that exact colour × size exists, even if it is
  // sold out. That lets the shopper request a restock alert for the exact
  // version; non-existent combinations remain disabled.
  const sizeExistsForColor = (code: string) =>
    !!opts?.combinations.some((c) => c.size_code === code && (activeColor === null || comboColor(c) === activeColor));
  const sizeAvailableForColor = (code: string) =>
    !!opts?.combinations.some((c) => c.size_code === code && (activeColor === null || comboColor(c) === activeColor) && c.availability !== "sold_out");
  const zones = data.delivery_zones ?? [];
  const shownZone = ctx?.zone ?? null;
  const deliveryText = (() => {
    const d = facts?.delivery;
    if (!d) return null;
    switch (d.status) {
      case "AVAILABLE":
        return d.fee === 0 ? t("pdp.free_delivery") : fmt(t("pdp.delivery_fee"), { fee: d.fee ?? 0 });
      case "NO_ZONE_SELECTED":
        return zones.map((z) => `${t(`zone.${z.region}`)}: ${z.fee === 0 ? t("pdp.free") : fmt(t("pdp.fee"), { fee: z.fee })}`).join(" · ");
      case "NOT_IN_ZONE":
        return fmt(t("pdp.not_in_zone"), { zone: shownZone ? t(`zone.${shownZone}`) : t("pdp.this_zone") });
      case "NO_UPCOMING_SLOTS":
        return t("pdp.no_slots");
      case "NO_ELIGIBLE_STOCK":
        return t("pdp.no_delivery_stock");
      case "NOT_OFFERED":
        return t("pdp.no_delivery");
      default:
        return t("pdp.not_purchasable");
    }
  })();
  // PD-5.1: the API's own earliest window (checkout's slot list) - shown
  // only when delivery is possible here or the zone is still to choose.
  const earliestSlot =
    facts?.delivery.earliest_slot && (facts.delivery.status === "AVAILABLE" || facts.delivery.status === "NO_ZONE_SELECTED")
      ? facts.delivery.earliest_slot
      : null;
  const returns = info.data?.returns && info.data.returns.mode !== "NO_RETURN" ? info.data.returns : null;
  const productFavorited = canonicalId ? favorites.favoriteIds.has(canonicalId) : false;
  const similarItems = (similar.data?.items ?? []).filter((c) => c.canonical_product_id !== canonicalId).slice(0, 10);
  const descriptionBits = [
    categoryName,
    seasonName(taxonomy.data, opts?.season, lang),
    variant.condition === "NEW" ? t("pdp.new") : variant.condition,
    opts?.colors.map((c) => colorLabel(c)).join(t("pdp.list_sep")),
  ].filter(Boolean) as string[];
  const specsText = pickText(lang, variant.specs_text_en, variant.specs_text_ar);

  return (
    <div className="pdp page-shell">
      <div className="pdp-shell">
        {!live && (
          <div className="pdp-preview-strip" role="status" data-testid="pdp-preview-strip">
            {t("pdp.preview_strip")}
          </div>
        )}
        <nav className="pdp-breadcrumb" aria-label={t("pdp.breadcrumb")}>
          <Link href="/">{t("pdp.home")}</Link>
          {audiencePage && (<><span aria-hidden="true">/</span><Link href={audiencePage.href}>{audiencePage.label}</Link></>)}
          {audiencePage && category && categoryName && (<><span aria-hidden="true">/</span><Link href={`${audiencePage.href}?category=${category}`}>{categoryName}</Link></>)}
          <span aria-hidden="true">/</span>
          <span className="pdp-breadcrumb-current">{title}</span>
        </nav>

        <div className="pdp-layout">
          {/* Gallery + reviews (the wide column). */}
          <div className="pdp-main">
            <div className="pdp-gallery">
              {images.length > 1 && (
                <div className="pdp-thumbs" role="tablist" aria-label={t("pdp.images")}>
                  {images.map((src, i) => (
                    <button key={src} type="button" role="tab" aria-selected={i === imageIndex} className={i === imageIndex ? "active" : ""} onClick={() => setImageIndex(i)} onMouseEnter={() => setImageIndex(i)} aria-label={fmt(t("pdp.image_n"), { n: i + 1 })}>
                      <SafeImage src={src} alt="" />
                    </button>
                  ))}
                </div>
              )}
              <button type="button" className="pdp-image" onClick={() => images.length && setZoomOpen(true)} aria-label={t("pdp.zoom")}>
                {images.length > 0 ? (
                  <SafeImage src={images[imageIndex] ?? images[0]} alt={galleryItems[imageIndex]?.alt ?? title} />
                ) : (
                  <span className="product-card-noimage">{t("pdp.no_image")}</span>
                )}
                {discountPercent !== null && <span className="pdp-image-badge" dir="ltr">-{discountPercent}%</span>}
                {representative && <span className="pdp-image-note">{t("pdp.representative")}</span>}
              </button>
            </div>

            {live && canonicalId && (
              <ProductReviews canonicalId={canonicalId} storeSlug={slug ?? ""} onAggregate={setRating} />
            )}
            {sizeGuide && data.size_guide_available && (
              <SizeGuideModal
                slug={slug ?? ""}
                offerId={offerId}
                preloaded={live ? undefined : preview.data?.size_guide}
                selectedSize={size}
                focusNotes={sizeGuide.focusNotes}
                onClose={() => setSizeGuide(null)}
              />
            )}
          </div>

          {/* The buy column. */}
          <aside className="pdp-buy" aria-label={t("pdp.buy")}>
            <Link href={`/store/${data.vendor_slug}`} className="pdp-store">
              <StoreCircle name={data.vendor_display_name} logoUrl={store.data?.logo_url ?? null} size={44} />
              <span>
                <strong>{data.vendor_display_name}{store.data?.is_verified && <span className="pdp-verified">{t("pdp.verified_short")}</span>}</strong>
                <span className="muted">{t("pdp.visit_store")}</span>
              </span>
              <span className="pdp-store-arrow" aria-hidden="true">‹</span>
            </Link>

            {data.bestseller && (
              <div className="pdp-bestseller">
                <BestsellerBadge mark={data.bestseller} scoped />
              </div>
            )}
            <div className="pdp-title-row">
              <h1>{title}</h1>
              <button type="button" className="pdp-icon-button" onClick={share} disabled={!live} aria-label={t("pdp.share_aria")} title={t("pdp.share")}><ExpandIcon /></button>
            </div>
            <div className="pdp-meta">
              {rating && rating.count > 0 && (
                <a href="#reviews" className="pdp-meta-rating">
                  {rating.average !== null && <Stars value={rating.average} />}
                  <span>{fmt(t("pdp.n_ratings"), { n: rating.count })}</span>
                </a>
              )}
            </div>

            <div className="pdp-price">
              <span className={`pdp-price-now${sale !== null ? " is-sale" : ""}`}>{price} ₪</span>
              {variant.sale_price && <s className="pdp-price-old">{variant.base_price} ₪</s>}
              {discountPercent !== null && <span className="pdp-price-off" dir="ltr">-{discountPercent}%</span>}
              <span className={`availability-badge availability-${availability}`}>{availabilityLabel(lang, availability)}</span>
            </div>

            {card.data && canonicalId && (
              <Link href={`/compare/${canonicalId}`} className="pdp-stores-banner">
                <span className="pdp-stores-badge">{fmt(t("pdp.sold_in"), { stores: storeCountLabel(lang, card.data.store_count) })}</span>
                <span>{t("pdp.compare_stores")}</span>
                <span aria-hidden="true">‹</span>
              </Link>
            )}

            {notice && <div className="notice-banner" role="status">{t(notice)}</div>}

            {opts ? (
              <>
                {opts.colors.length > 0 && (
                  <div className="pdp-option">
                    <div className="pdp-option-head"><strong>{t("pdp.color_label")}</strong> <span data-testid="pdp-color-name">{colorName ?? t("pdp.pick_color")}</span>
                      {images.length > 0 && <button type="button" className="pdp-link" onClick={() => setZoomOpen(true)}>{t("pdp.large_image")}</button>}
                    </div>
                    {/* TB-25.3: one thumbnail per colour from that colour's own images
                        (its colour circle when it has none). Choosing one runs the same
                        colour change as before - variant, size, stock and cart logic are
                        untouched. A radio group: arrow keys move and choose (RTL-aware). */}
                    <div className="pdp-color-thumbs" role="radiogroup" aria-label={t("pdp.color")} onKeyDown={onColorKey}>
                      {opts.colors.map((c, i) => {
                        const key = colorKey(c);
                        // Product colours: the seller's fabric swatch or HEX as a circle;
                        // otherwise the colour's own image (TB-25.3); otherwise the family's colour.
                        const sample = c.swatch_url || c.hex ? swatchBackground(c) : null;
                        const thumb = sample ? null : thumbs[key];
                        const name = colorLabel(c);
                        const checked = activeColor === key;
                        const tabbable = activeColor ? checked : i === 0;
                        return (
                          <button key={key} type="button" role="radio" aria-checked={checked} tabIndex={tabbable ? 0 : -1}
                            title={name} aria-label={name} data-color={c.code} data-color-id={c.id ?? undefined}
                            className={`pdp-color-thumb${checked ? " active" : ""}${thumb ? "" : " is-swatch"}`}
                            onClick={() => chooseColor(key)}>
                            {thumb ? <SafeImage src={thumb.url} alt="" /> : <span className="pdp-color-thumb-swatch" style={{ background: sample ?? (c.family_hex ?? c.hex ?? "#ddd") }} />}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                {opts.sizes.length > 0 && (
                  <div className="pdp-option">
                    <div className="pdp-option-head">
                      <strong>{t("pdp.size")}</strong>
                      {size && <span>{(() => { const s = opts.sizes.find((x) => x.code === size); return s ? sizeName(s.code, s.label, lang) : null; })()}</span>}
                      {data.size_guide_available && (
                        <button type="button" className="pdp-size-guide-link" onClick={() => setSizeGuide({ focusNotes: false })} aria-haspopup="dialog">
                          {data.size_guide_kind === "OFFER" ? sgText.ownTitle : sgText.open}
                        </button>
                      )}
                    </div>
                    <div className="pdp-sizes" role="radiogroup" aria-label={t("pdp.size")}>
                      {opts.sizes.map((s) => {
                        const exists = sizeExistsForColor(s.code);
                        const available = sizeAvailableForColor(s.code);
                        return (
                          <button key={s.code} type="button" role="radio" aria-checked={size === s.code} disabled={!exists}
                            className={`pdp-size${size === s.code ? " active" : ""}${exists && !available ? " is-sold-out" : ""}`}
                            onClick={() => { setSize(s.code); rememberOption(activeColor, s.code); resetGallery(); setCartError(null); setAdded(false); setAvailabilityOverride(null); }}>
                            {sizeName(s.code, s.label, lang)}
                          </button>
                        );
                      })}
                    </div>
                    {data.model && (
                      <p className="pdp-model" data-testid="pdp-model">
                        {t("pdp.model").replace("{h}", String(data.model.height_cm)).replace("{size}", sizeName(data.model.size_code, data.model.size_label, lang) ?? data.model.size_label)}
                      </p>
                    )}
                    {data.size_guide_available && (
                      <button type="button" className="pdp-link-inline pdp-not-my-size" onClick={() => setSizeGuide({ focusNotes: true })} aria-haspopup="dialog">
                        {sgText.notMySize}
                      </button>
                    )}
                  </div>
                )}
              </>
            ) : (
              data.variants.length > 1 && (
                <div className="pdp-option">
                  <div className="pdp-option-head"><strong>{t("pdp.pick_option")}</strong></div>
                  <div className="pdp-sizes" role="radiogroup" aria-label={t("pdp.options")}>
                    {data.variants.map((v, i) => (
                      <button key={v.id} type="button" role="radio" aria-checked={v.id === variant.id} className={`pdp-size${v.id === variant.id ? " active" : ""}`}
                        onClick={() => { setSelected(v.id); resetGallery(); setAdded(false); }}>
                        {optionLabel(v, i, lang)}
                      </button>
                    ))}
                  </div>
                </div>
              )
            )}

            {cartError && <ErrorBanner message={cartErrorText(cartError)} />}
            {added && (
              <div className="notice-banner" role="status">
                {t("pdp.added_pre")}<Link href="/cart">{t("pdp.go_to_cart")}</Link>{t("pdp.added_post")}
              </div>
            )}

            <div className="pdp-cart-row">
              <button type="button" className="pdp-cart" disabled={!live || adding || soldOut} onClick={addToCart} title={live ? undefined : t("pdp.preview_disabled")} data-testid="pdp-cart">
                {!live ? t("pdp.preview_disabled") : soldOut ? t("pdp.unavailable") : adding ? t("pdp.adding") : token || !hydrated ? t("pdp.add_to_cart") : t("pdp.sign_in_to_buy")}
              </button>
              {canonicalId && (
                <button type="button" className={`pdp-heart${productFavorited ? " on" : ""}`} aria-pressed={productFavorited}
                  aria-label={productFavorited ? t("shop.fav_remove") : t("shop.fav_add")}
                  disabled={favorites.favoritesLoading || favorites.favoritePendingIds.has(canonicalId)}
                  onClick={() => favorites.onToggleFavorite({ canonical_product_id: canonicalId })}>
                  <HeartIcon />
                </button>
              )}
            </div>
            {opts && (!activeColor || !size) && (
              <p className="pdp-availability-hint" role="status">{t("pdp.availability_pick_option")}</p>
            )}
            {exactSoldOutSelection && (
              <div className="pdp-availability-request" aria-live="polite">
                <p>{availabilitySubscribed ? t("pdp.availability_subscribed_hint") : t("pdp.availability_hint")}</p>
                <button
                  type="button"
                  className={availabilitySubscribed ? "pdp-availability-cancel" : "pdp-availability-button"}
                  // preview: shown as the shopper will see it, but nothing is ever sent
                  disabled={!live || availabilityBusy}
                  title={live ? undefined : t("pdp.preview_disabled")}
                  onClick={toggleAvailabilitySubscription}
                  data-testid="pdp-availability-request"
                >
                  {availabilityBusy ? t("pdp.availability_saving") : availabilitySubscribed ? t("pdp.availability_cancel") : fmt(t("pdp.availability_request"), { color: colorName ?? "", size: sizeName(size, opts.sizes.find((entry) => entry.code === size)?.label ?? size, lang) ?? size })}
                </button>
              </div>
            )}
            {favorites.favoriteError && <ErrorBanner message={favorites.favoriteError} />}

            <div className="pdp-extra-actions">
              {variant.canonical_product_id && (
                <Link href={`/compare/${variant.canonical_product_id}`} className="pdp-secondary">{t("pdp.compare")}</Link>
              )}
              {live && whatsappHref && (
                <a href={whatsappHref} target="_blank" rel="noopener noreferrer" className="pdp-whatsapp">
                  <WhatsAppIcon /> {t("pdp.ask_whatsapp")}
                </a>
              )}
            </div>

            <div className="pdp-service">
              <div className="pdp-service-row">
                <div className="pdp-service-head">
                  <strong>{shownZone ? fmt(t("pdp.delivery_to"), { zone: t(`zone.${shownZone}`) }) : t("pdp.delivery")}</strong>
                  {live && <ZonePicker className="pdp-zone" value={zoneChoice} onChange={setZoneChoice} defaultZone={ctx?.default_zone ?? null} lang={lang} />}
                </div>
                {deliveryText && (
                  <span className={facts?.delivery.status === "AVAILABLE" && facts.delivery.fee === 0 ? "pdp-green" : ""}>{deliveryText}</span>
                )}
                {earliestSlot && (
                  <span className="pdp-delivery-promise">
                    <b>
                      {fmt(t("pdp.earliest"), { day: formatSlotDay(earliestSlot.date, lang) })}{" "}
                      <bdi dir="ltr" className="slot-hours">{slotHours(earliestSlot)}</bdi>
                    </b>
                    {laterSlotsText(facts?.delivery.latest_slot_date ?? null, lang) && <> · {laterSlotsText(facts?.delivery.latest_slot_date ?? null, lang)}</>}
                    <small>{estimateNote(lang)}</small>
                  </span>
                )}
                {facts?.delivery.status === "AVAILABLE" && facts.delivery.minimum_order_value !== null && (
                  <span>{fmt(t("pdp.min_order"), { amount: facts.delivery.minimum_order_value })}</span>
                )}
                {token && ctx && !ctx.default_zone && (
                  <Link href="/account/addresses" className="pdp-link-inline">{t("pdp.add_address")}</Link>
                )}
              </div>
              {facts && facts.pickup.status !== "NOT_PURCHASABLE" && (
                <div className="pdp-service-row">
                  <strong>{t("pdp.pickup")}</strong>
                  <span>
                    {facts.pickup.status === "AVAILABLE"
                      ? facts.pickup.branches
                          .map((b) => (b.hours_set ? `${b.name} (${hoursTodayText(b.hours_today ?? null, lang)})` : b.name))
                          .join(t("pdp.list_sep"))
                      : t("pdp.no_pickup")}
                  </span>
                </div>
              )}
              <div className="pdp-service-row">
                <strong>{returns
                  ? (() => {
                      const key = `pdp.ret.${returns.mode}`;
                      const mode = t(key) === key ? t("pdp.ret.generic") : t(key);
                      return returns.window_days ? fmt(t("pdp.within_days"), { mode, n: returns.window_days }) : mode;
                    })()
                  : t("pdp.no_returns")}</strong>
              </div>
              <div className="pdp-service-row">
                <strong>{t("pdp.safe")}</strong>
                <span className="pdp-checks"><span>{t("pdp.safe_pay")}</span></span>
              </div>
            </div>

            <div className="pdp-sections">
              <Section title={t("pdp.description")} summary={descriptionBits.join(t("pdp.list_sep"))}>
                {specsText && <p data-testid="pdp-specs">{specsText}</p>}
                <dl className="pdp-specs">
                  {categoryName && (<><dt>{t("pdp.category")}</dt><dd>{categoryName}</dd></>)}
                  {audiencePage && (<><dt>{t("pdp.department")}</dt><dd>{audiencePage.label}</dd></>)}
                  {opts?.season && (<><dt>{t("pdp.season")}</dt><dd>{seasonName(taxonomy.data, opts.season, lang, opts.season)}</dd></>)}
                  {opts && opts.colors.length > 0 && (<><dt>{t("pdp.colors")}</dt><dd>{opts.colors.map((c) => colorLabel(c)).join(t("pdp.list_sep"))}</dd></>)}
                  {Object.entries(data.template_attributes ?? {})
                    .filter(([, v]) => typeof v === "string" && v.trim() && v !== "N/A")
                    .map(([k, v]) => (
                      <Fragment key={k}>
                        <dt>{translate(lang, `wz.spec.${k}`)}</dt>
                        <dd data-testid={`pdp-spec-${k}`}>{specValueText(k, v, lang)}</dd>
                      </Fragment>
                    ))}
                  <dt>{t("pdp.condition")}</dt><dd>{variant.condition === "NEW" ? t("pdp.new") : variant.condition}</dd>
                </dl>
                {/* fabric composition and country of origin - near the material and care; nothing when not given */}
                <CompositionView composition={data.composition ?? null} country={data.country_of_origin ?? null} lang={lang} />
              </Section>
              {opts && opts.sizes.length > 0 && (
                <Section title={t("pdp.size_fit")}>
                  <p>{fmt(t("pdp.sizes_available"), { sizes: opts.sizes.map((s) => sizeName(s.code, s.label, lang)).join(t("pdp.list_sep")) })}</p>
                  {data.size_guide_available && (
                    <button type="button" className="pdp-link-inline" onClick={() => setSizeGuide({ focusNotes: false })} aria-haspopup="dialog">
                      {sgText.openLong}
                    </button>
                  )}
                </Section>
              )}
              <Section title={t("pdp.about_store")} defaultOpen>
                <div className="pdp-about">
                  <StoreCircle name={data.vendor_display_name} logoUrl={store.data?.logo_url ?? null} size={52} />
                  <div>
                    <strong>{data.vendor_display_name}{store.data?.is_verified && <span className="pdp-verified">{t("pdp.verified")}</span>}</strong>
                    {store.data && <span className="muted">{fmt(t("pdp.n_followers"), { n: store.data.follower_count.toLocaleString("en-US") })}</span>}
                  </div>
                </div>
                {store.data?.bio && <p className="pdp-about-bio">{store.data.bio}</p>}
                <div className="pdp-about-actions">
                  <Link href={`/store/${data.vendor_slug}`} className="pdp-outline">{t("pdp.all_products")}</Link>
                  <button type="button" className="pdp-outline" onClick={toggleFollow} disabled={!live || followBusy} aria-pressed={following}>
                    {following ? t("pdp.following") : t("pdp.follow")}
                  </button>
                </div>
              </Section>
            </div>

            {/* PD-5.4: the store's own «نسّقي معه» picks (nothing when < 2 qualify). */}
            {source.mode === "live" && <OfferPairingsSection slug={source.slug} offerId={source.offerId} zone={zoneChoice} />}

            {variant.canonical_product_id && (
              <div className="pdp-report">
                {reportDone ? (
                  <p className="muted" role="status">{t("pdp.report_thanks")}</p>
                ) : reportOpen ? (
                  <div className="field">
                    <label htmlFor="match-report-note">{t("pdp.report_question")}</label>
                    <textarea id="match-report-note" rows={3} value={reportNote} disabled={reportBusy} onChange={(e) => setReportNote(e.target.value)} />
                    {reportError && <ErrorBanner message={uiMsgText(reportError, lang)} />}
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="button-link" disabled={reportBusy} onClick={submitMatchReport}>{reportBusy ? t("pdp.sending") : t("pdp.send_report")}</button>
                      <button className="button-link" disabled={reportBusy} onClick={() => { setReportOpen(false); setReportError(null); }}>{t("pdp.cancel")}</button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="pdp-report-link" onClick={() => {
                    if (!token) {
                      router.push(loginRedirectHref());
                      return;
                    }
                    setReportOpen(true);
                  }}>
                    {t("pdp.report")}
                  </button>
                )}
              </div>
            )}
          </aside>
        </div>

        {similarItems.length > 0 && (
          <section className="pdp-similar" aria-labelledby="pdp-similar-title">
            <h2 id="pdp-similar-title">{t("pdp.similar")}</h2>
            <div className="pdp-similar-grid">
              {similarItems.map((c) => <ProductCard key={c.canonical_product_id} card={c} />)}
            </div>
          </section>
        )}
      </div>

      {zoomOpen && images.length > 0 && (
        <div className="pdp-zoom" role="dialog" aria-modal="true" aria-label={t("pdp.large_image")} onClick={() => setZoomOpen(false)}>
          <button type="button" className="pdp-zoom-close" aria-label={t("pdp.close")} onClick={() => setZoomOpen(false)}>×</button>
          <SafeImage src={images[imageIndex] ?? images[0]} alt={title} />
          {images.length > 1 && (
            <div className="pdp-zoom-thumbs" onClick={(e) => e.stopPropagation()}>
              {images.map((src, i) => (
                <button key={src} type="button" className={i === imageIndex ? "active" : ""} onClick={() => setImageIndex(i)} aria-label={fmt(t("pdp.image_n"), { n: i + 1 })}>
                  <SafeImage src={src} alt="" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
