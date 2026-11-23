"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { CSSProperties, ReactNode, type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  BackIcon,
  ExpandIcon,
  ScanBarcodeIcon,
  FacebookIcon,
  InstagramIcon,
  ManagementTileIcon,
  PencilIcon,
  type ManagementTileIconName,
  SearchIcon,
  SparkleIcon,
  StarIcon,
  StoreManageIcon,
  TagIcon,
  UserIcon,
  WhatsAppIcon,
} from "@/components/Icons";
import SafeImage from "@/components/SafeImage";
import StoreOfferCard from "@/components/StoreOfferCard";
import { EmptyState, ErrorBanner } from "@/components/States";
import { ApiError, IMAGE_UPLOAD_ACCEPT, apiFetch, uploadVendorImage } from "@/lib/api";
import { clearSession } from "@/lib/session";
import { Availability } from "@/lib/types";
import { ownerHubTiles, type WorkspaceInfo } from "@/lib/nav";
import { useHydrated, useSessionToken, useUnreadNotificationCount, useWorkspaces } from "@/lib/useSession";
import "@/lib/collectionsText";
import { IconBell } from "@/components/product-wizard/wizardIcons";
import NotificationsPanel from "@/components/NotificationsPanel";
import {
  WORKSPACE_EVENT,
  forgetWorkspace,
  hasWorkspace,
  workspaceEntryHref,
  workspaceSnapshot,
} from "@/lib/workspaceSession";
import { WorkspaceEnterPanel } from "@/components/WorkspaceEnterPanel";
import "@/lib/workspaceText";
import "@/lib/storePosText";
import { useFetch } from "@/lib/useFetch";
import { listingFilterOptions } from "@/lib/listingCategories";
import { useTaxonomy } from "@/lib/taxonomy";
import { sizeGroupFor, type ListingAudience } from "@/lib/discoveryFilters";
import {
  coverLookBody,
  coverLookFromDto,
  coverLookProblem,
  coverPresentation,
  type CoverLook,
  type StorefrontCoverDto,
} from "@/lib/storeCover";
import StoreCoverControls from "@/components/StoreCoverControls";
import StoreAppearanceEditor from "@/components/StoreAppearanceEditor";
import HeroTextControls from "@/components/HeroTextControls";
import {
  heroTextBody,
  heroTextCss,
  heroTextFromDto,
  heroTextProblem,
  type HeroTextDto,
  type HeroTextField,
  type HeroTextLook,
  type HeroTextStyle,
} from "@/lib/heroText";
import {
  appearanceColorsValid,
  appearancePatch,
  appearanceVars,
  resolveAppearance,
  type StoreAppearance,
} from "@/lib/storeAppearance";
import { storeWhatsappMessage, whatsappChatUrl } from "@/lib/whatsapp";
import StoreInfo, { StoreInfoDto } from "./StoreInfo";
import { translate } from "@/lib/i18n";
import { useLang } from "@/lib/useLang";
import { pickText } from "@/lib/localized";
import { fmt } from "@/lib/shopText";
import { type UiMsg, uiMsgText } from "@/lib/storeText";
import "@/lib/listText";
import { loginRedirectHref } from "@/lib/loginRedirect";
import { ProductWizardPanel, type WizardOpen } from "@/components/product-wizard/ProductWizardPanel";
import type { WizardResult } from "@/components/product-wizard/ProductWizard";
import { fill as fillWz } from "@/lib/offerWizardText";
import StoreHomeBlocks, { useDraftHome, useStoreHome } from "@/components/store-home/StoreHomeBlocks";
import { PreviewGuard } from "@/components/store-home/PreviewGuard";
import { scrollToBrowse, type HomeTarget } from "@/lib/storeHome";

interface StorefrontDto extends StorefrontCoverDto, HeroTextDto {
  slug: string;
  display_name: string;
  hero_title: string | null;
  logo_url: string | null;
  bio: string | null;
  cover_image_url: string | null;
  cover_color: string | null;
  instagram_url: string | null;
  facebook_url: string | null;
  whatsapp_url: string | null;
  /** The panel pencil's configuration (defaults + the owner's changes). */
  storefront_appearance?: unknown;
  is_available: boolean;
  is_verified: boolean;
  follower_count: number;
}

type QuickEditField = "display_name" | "hero_title" | "bio" | "logo_url" | "cover_image_url";

// TB-25: the label and help are translation keys (store.qe.<field>[.help]).
const QUICK_EDIT_COPY: Record<QuickEditField, { multiline?: boolean }> = {
  display_name: {},
  hero_title: {},
  bio: { multiline: true },
  logo_url: {},
  cover_image_url: {},
};

interface OfferSummaryDto {
  id: string;
  title_ar: string;
  title_en: string;
  min_price: string | null;
  availability: Availability;
  image_url: string | null;
  created_at: string;
  favorite_variant_id: string | null;
  original_price: string | null;
  discount_percent: number | null;
}

type Collection = "ALL" | "TRENDING" | "NEW" | "DISCOUNT";

interface StoreDepartmentDto {
  audience: ListingAudience;
  name_ar: string;
  name_en: string;
  categories: { code: string; name_ar: string; name_en: string }[];
}

// GET /storefronts/:slug/products - the whole catalogue pipeline runs on
// the server: department -> detailed category -> smart collection ->
// search -> drawer filters, each one narrowing the previous (AND).
interface StoreProductsDto {
  is_available: boolean;
  collection: Collection;
  total: number;
  store_total: number;
  page: number;
  page_size: number;
  items: OfferSummaryDto[];
  collection_counts: Record<Collection, number>;
  departments: StoreDepartmentDto[];
  /** PD-5.3: the «الأكثر مبيعاً» sort is available (feature flag). */
  bestseller_enabled?: boolean;
}

interface ReviewsDto {
  aggregate: { average: number | null; count: number };
}

interface FavoriteDto {
  id: string;
  offer_variant_id: string | null;
}

type SortKey = "newest" | "price_asc" | "price_desc" | "bestseller";

// The main departments (the store's types); which ones a store offers and
// the detailed categories under each come from the API.
const DEPARTMENTS: ListingAudience[] = ["WOMEN", "MEN", "KIDS"];
// TB-25: a department's name is translate(lang, `aud.${department}`).

/** The drawer's filters once applied (sent to the API). */
interface StoreFilters {
  colors: string[];
  sizes: string[];
  seasons: string[];
  availableOnly: boolean;
  priceMin: number;
  priceMax: number;
  sort: SortKey;
}

const PRICE_CEILING = 1000;
const NO_FILTERS: StoreFilters = {
  colors: [],
  sizes: [],
  seasons: [],
  availableOnly: false,
  priceMin: 0,
  priceMax: PRICE_CEILING,
  sort: "newest",
};
/** «مجموعات المتجر» as a shopper sees them (GET /storefronts/:slug/store-collections). */
interface StoreGroupDto {
  id: string;
  name_ar: string;
  name_en: string | null;
  cover_url: string | null;
  count: number;
}

const PAGE_SIZE = 24;
const SEARCH_DEBOUNCE_MS = 300;

// The smart buttons: one collection at a time, kept in ?cat= so a refresh,
// back/forward or a shared link land on the same view.
const SMART_TABS: { id: string; collection: Exclude<Collection, "ALL">; label: string; icon: ReactNode }[] = [
  { id: "new", collection: "NEW", label: "store.smart.new", icon: <SparkleIcon /> },
  { id: "sale", collection: "DISCOUNT", label: "store.smart.sale", icon: <TagIcon /> },
  { id: "trend", collection: "TRENDING", label: "store.smart.trend", icon: <StarIcon /> },
];
const SAFE_URL = /^(https?:\/\/|\/)/;

// Each hub tile's icon and words, by the page it opens (not by its place in
// the list - removing a tile, like «الأقسام» did, must not shift the others).
const MANAGEMENT_TILE_DETAILS: Record<string, { icon: ManagementTileIconName; badge: string; footer: string }> = {
  storefront: { icon: "store", badge: "store.tile.0.badge", footer: "store.tile.0.footer" },
  offers: { icon: "tag", badge: "store.tile.2.badge", footer: "store.tile.2.footer" },
  "match-review": { icon: "shield", badge: "store.tile.3.badge", footer: "store.tile.3.footer" },
  branches: { icon: "pin", badge: "store.tile.4.badge", footer: "store.tile.4.footer" },
  staff: { icon: "team", badge: "store.tile.5.badge", footer: "store.tile.5.footer" },
  verification: { icon: "document", badge: "store.tile.9.badge", footer: "store.tile.9.footer" },
  reviews: { icon: "star", badge: "store.tile.12.badge", footer: "store.tile.12.footer" },
  performance: { icon: "chart", badge: "store.tile.13.badge", footer: "store.tile.13.footer" },
  "store-sales": { icon: "barcode", badge: "", footer: "pos.tile.sales_hint" },
  labels: { icon: "barcode", badge: "", footer: "pos.tile.labels_hint" },
  "storefront/home": { icon: "grid", badge: "", footer: "" },
};
const tileKey = (href: string) => href.split("/").slice(3).join("/");

// offer variant id -> favorite id (the id DELETE /favorites/:id needs).
const NO_FAVORITES: ReadonlyMap<string, string> = new Map();

function favoritesByVariant(rows: FavoriteDto[]): Map<string, string> {
  return new Map(
    rows
      .filter((f) => f.offer_variant_id !== null)
      .map((f) => [f.offer_variant_id as string, f.id]),
  );
}

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** The owner's «إضافة منتج»: opens the product-entry wizard over this list (phase A). */
function AddProductCard({ onClick }: { onClick: () => void }) {
  const lang = useLang();
  const t = (key: string) => translate(lang, key);
  return (
    <button type="button" className="store-add-product-card" aria-label={t("store.add_product")} title={t("store.add_product")} onClick={onClick} data-testid="store-add-product">
      <span className="store-add-product-media" aria-hidden="true">
        <span className="store-add-product-icon">+</span>
      </span>
      <span className="store-add-product-body">
        <strong>{t("store.add_product")}</strong>
        <small>{t("store.add_product_hint")}</small>
      </span>
    </button>
  );
}

/** A not-yet-published product or open draft (from the owner-only API). */
interface UnpublishedItem {
  kind: "draft" | "offer";
  id: string;
  title: string;
  label: "DRAFT" | "BRAND_PENDING";
  audience: ListingAudience | null;
  category: string | null;
  thumbnail: string | null;
}

/**
 * Phase A: shown ONLY to the owner inside the store workspace - never on
 * the public storefront, search or discovery (it comes from an owner-only
 * API the public page never calls). A draft reopens in the wizard; a
 * created-but-unpublished product opens its own management page.
 */
function OwnerUnpublishedCard({ item, vendorId, onOpenDraft }: { item: UnpublishedItem; vendorId: string; onOpenDraft: (id: string) => void }) {
  const lang = useLang();
  const t = (key: string) => translate(lang, key);
  const title = item.title === "مسودة جديدة" ? t("wz.draft_title_new") : item.title;
  const body = (
    <>
      <span className="store-owner-card-media">
        {item.thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.thumbnail} alt="" />
        ) : (
          <span className="store-owner-card-empty" aria-hidden="true" />
        )}
      </span>
      <span className="store-owner-card-body">
        <span className={`store-owner-badge store-owner-badge-${item.label === "DRAFT" ? "draft" : "pending"}`}>{t(`wz.card.${item.label}`)}</span>
        <strong>{title}</strong>
        <small>{t("wz.card.only_you")}</small>
      </span>
    </>
  );
  return item.kind === "draft" ? (
    <button type="button" className="store-owner-card" onClick={() => onOpenDraft(item.id)} data-testid="store-owner-card" data-kind="draft" data-label={item.label}>
      {body}
    </button>
  ) : (
    <Link href={`/vendor/${vendorId}/offers/${item.id}`} className="store-owner-card" data-testid="store-owner-card" data-kind="offer" data-label={item.label}>
      {body}
    </Link>
  );
}

function StoreSkeleton() {
  const lang = useLang();
  return (
    <div className="store-view" aria-busy="true" aria-label={translate(lang, "store.loading")}>
      <section className="store-hero">
        <div className="store-shell">
          <div className="store-topbar">
            <div className="store-identity">
              <span className="store-skel store-skel-logo" />
              <div className="store-identity-text">
                <span className="store-skel" style={{ width: 170, height: 16 }} />
                <span className="store-skel" style={{ width: 120, height: 11 }} />
              </div>
            </div>
            <span className="store-skel" style={{ width: 46, height: 46, borderRadius: 14 }} />
          </div>
          <div className="store-intro">
            <span className="store-skel" style={{ width: "60%", height: 30, margin: "0 auto" }} />
            <span className="store-skel" style={{ width: "80%", height: 13, margin: "22px auto 0" }} />
          </div>
          <div className="store-chips" aria-hidden="true">
            {[78, 96, 84, 70].map((w, i) => (
              <span key={i} className="store-skel" style={{ width: w, height: 40, borderRadius: 999 }} />
            ))}
          </div>
        </div>
      </section>
      <section className="store-products">
        <div className="store-shell">
          <div className="product-grid store-product-grid">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i}>
                <span className="store-skel" style={{ display: "block", aspectRatio: "4 / 5", borderRadius: 18 }} />
                <span className="store-skel" style={{ width: "70%", height: 12, marginTop: 12 }} />
                <span className="store-skel" style={{ width: "40%", height: 12, marginTop: 8 }} />
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

// Sprint 7/8 (RB-STOREF-001/002, PDR-011/012): the public storefront.
// Customer view only - everything here is what the store owner set on
// /vendor/[id]/storefront (identity, cover, links) and
// /vendor/[id]/sections (their own categories, names, order and
// membership); "وصل حديثاً" / "تخفيضات" are the API's automatic
// filters. Sprint 26 adds the profile stats line, a small follow
// button, per-product favorites, local search/sort, ?cat= in the URL
// and a sticky category bar. "المحل غير متاح حالياً" stays a status
// beside the identity, never a 404.
function subscribeWorkspaces(onChange: () => void): () => void {
  window.addEventListener(WORKSPACE_EVENT, onChange);
  return () => window.removeEventListener(WORKSPACE_EVENT, onChange);
}

export default function StorefrontPage() {
  const lang = useLang();
  const t = (key: string) => translate(lang, key);
  const params = useParams<{ slug: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const token = useSessionToken();
  const workspaces = useWorkspaces(token);
  const taxonomy = useTaxonomy();

  const store = useFetch<StorefrontDto>(`/storefronts/${params.slug}`);
  const reviews = useFetch<ReviewsDto>(`/storefronts/${params.slug}/reviews`);
  const info = useFetch<StoreInfoDto>(`/storefronts/${params.slug}/info`);
  const followStatus = useFetch<{ following: boolean }>(
    token ? `/customers/me/following/${params.slug}` : null,
    true,
  );

  // Both keyed by the session token: signing out (or in as someone
  // else) never keeps showing the previous account's follow/hearts.
  const [followOverrideState, setFollowOverrideState] = useState<{ token: string; following: boolean } | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  const [favoritesState, setFavoritesState] = useState<{ token: string; byVariant: Map<string, string> } | null>(null);
  const [favoriteBusy, setFavoriteBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [applied, setApplied] = useState<StoreFilters>(NO_FILTERS);
  const [storeFilterOpen, setStoreFilterOpen] = useState(false);
  const [draftSort, setDraftSort] = useState<SortKey>("newest");
  const [draftColors, setDraftColors] = useState<string[]>([]);
  const [draftSizes, setDraftSizes] = useState<string[]>([]);
  const [draftSeasons, setDraftSeasons] = useState<string[]>([]);
  const [draftAvailableOnly, setDraftAvailableOnly] = useState(false);
  const [draftPriceMin, setDraftPriceMin] = useState(0);
  const [draftPriceMax, setDraftPriceMax] = useState(1000);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<UiMsg | null>(null);
  const [chipsStuck, setChipsStuck] = useState(false);
  const [managementOpen, setManagementOpen] = useState(false);
  const [inboxVersion, setInboxVersion] = useState(0);
  const [employeeWorkspaceOpen, setEmployeeWorkspaceOpen] = useState(false);
  const [managementDetail, setManagementDetail] = useState<{
    href: string;
    title: string;
  } | null>(null);
  // The management frame is the ONE management window: the page inside it
  // tells this header its current screen's title and whether «رجوع» has
  // somewhere to go; × asks it to save first (lib/manageFrame.ts).
  const managementFrameRef = useRef<HTMLIFrameElement>(null);
  // The store workspace's «إشعاراتي»: the SAME drawer as the shopping
  // bell's (look and behaviour), over the current screen - never a screen in
  // the management window. STORE notifications of this store only.
  const [storeInboxOpen, setStoreInboxOpen] = useState(false);
  // stable (the drawer's effects depend on it); the setters never change
  const [closeStoreInbox] = useState(() => () => {
    setStoreInboxOpen(false);
    setInboxVersion((v) => v + 1);
  });
  /** Where a store notification leads - for the owner, inside the management window. */
  function openFromInbox(href: string) {
    if (!ownerVendorId) {
      router.push(href);
      return;
    }
    const frame = managementFrameRef.current?.contentWindow;
    setManagementOpen(true);
    if (managementDetail && frame) {
      // the window is open: its content moves there (an open wizard saves first)
      frame.postMessage({ source: "fp-manage-frame", type: "navigate", href }, window.location.origin);
      return;
    }
    const key = href.split("?")[0].split("/").slice(3).join("/");
    const tiles = ownerHubTiles(ownerVendorId);
    // addresses that moved into «إدارة الفروع» (their old pages redirect there) keep its title
    const moved = /^(orders|delivery-windows|delivery-zones|return-policy|returns\/redeem|settings)$/.test(key) ? "branches" : key;
    const tile = tiles.find((x) => moved === x.href.split("/").slice(3).join("/")) ?? tiles.find((x) => moved.startsWith(`${x.href.split("/").slice(3).join("/")}/`));
    setFrameState({ title: null, canBack: false, backTitle: null });
    setManagementDetail({ href, title: tile?.title ?? t("store.manage") });
  }
  const [frameState, setFrameState] = useState<{ title: string | null; canBack: boolean; backTitle: string | null }>({ title: null, canBack: false, backTitle: null });
  const frameCloseTimer = useRef<number | null>(null);
  const closeManagementNow = useCallback(() => {
    if (frameCloseTimer.current !== null) window.clearTimeout(frameCloseTimer.current);
    frameCloseTimer.current = null;
    setManagementDetail(null);
    setManagementOpen(false);
    setFrameState({ title: null, canBack: false, backTitle: null });
    setInboxVersion((v) => v + 1);
  }, []);
  const requestManagementClose = useCallback(() => {
    const frame = managementFrameRef.current?.contentWindow;
    if (!frame) {
      closeManagementNow();
      return;
    }
    // a page without the frame bridge never answers: close after a short wait
    if (frameCloseTimer.current !== null) window.clearTimeout(frameCloseTimer.current);
    frameCloseTimer.current = window.setTimeout(closeManagementNow, 1500);
    frame.postMessage({ source: "fp-manage-frame", type: "close" }, window.location.origin);
  }, [closeManagementNow]);
  useEffect(() => {
    if (!managementDetail) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== managementFrameRef.current?.contentWindow) return;
      const data = event.data as { source?: string; type?: string; title?: string | null; canBack?: boolean; backTitle?: string | null } | null;
      if (!data || data.source !== "fp-manage") return;
      if (data.type === "state") setFrameState({ title: data.title ?? null, canBack: Boolean(data.canBack), backTitle: data.backTitle ?? null });
      else if (data.type === "ack") {
        // the page is saving what needs saving; it says "closed" when done (or stays open if saving failed)
        if (frameCloseTimer.current !== null) window.clearTimeout(frameCloseTimer.current);
        frameCloseTimer.current = null;
      } else if (data.type === "closed") closeManagementNow();
      else if (data.type === "escape") requestManagementClose();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [managementDetail, closeManagementNow, requestManagementClose]);
  const [quickEdit, setQuickEdit] = useState<{
    field: QuickEditField;
    value: string;
    file: File | null;
    /** The cover pencil's layer settings (a draft until saved). */
    cover?: CoverLook;
    /** The title / description pencil's text styling (a draft until saved). */
    text?: HeroTextStyle;
  } | null>(null);
  // The title / description styling saved during this visit (shown without a refetch).
  const [heroTextSaved, setHeroTextSaved] = useState<Partial<HeroTextLook>>({});
  // The cover look saved during this visit (shown without a refetch).
  const [coverLookOverride, setCoverLookOverride] = useState<CoverLook | null>(null);
  const [quickEditSaving, setQuickEditSaving] = useState(false);
  // The panel pencil: the draft being edited (null = closed) and what was
  // saved during this visit (shown without a refetch).
  const [appearanceDraft, setAppearanceDraft] = useState<StoreAppearance | null>(null);
  const [appearanceSaved, setAppearanceSaved] = useState<StoreAppearance | null>(null);
  const [appearanceSaving, setAppearanceSaving] = useState(false);
  const [quickEditValues, setQuickEditValues] = useState<Partial<Record<QuickEditField, string>>>({});
  const [activeDepartment, setActiveDepartment] = useState<"all" | ListingAudience>("all");
  // A taxonomy category code of the active department.
  const [activeSubcategory, setActiveSubcategory] = useState<string | null>(null);
  const [departmentPickerOpen, setDepartmentPickerOpen] = useState(false);
  const [subcategoryPickerOpen, setSubcategoryPickerOpen] = useState(false);
  const [catalogueSaving, setCatalogueSaving] = useState(false);
  // The departments the owner saved during this visit (shown without a refetch).
  const [departmentsOverride, setDepartmentsOverride] = useState<StoreDepartmentDto[] | null>(null);
  const [debouncedQuery, setDebouncedQuery] = useState("");
  // The listing for one query string (`key`); "load more" appends pages.
  const [catalogue, setCatalogue] = useState<{ key: string; data: StoreProductsDto; items: OfferSummaryDto[] } | null>(null);
  const [catalogueError, setCatalogueError] = useState<UiMsg | null>(null);
  const [catalogueVersion, setCatalogueVersion] = useState(0);
  // Phase A: the product-entry wizard over this list, and the owner's own
  // not-yet-published products / drafts (owner-only cards).
  const [wizard, setWizard] = useState<WizardOpen | null>(null);
  const [wizardNotice, setWizardNotice] = useState<string | null>(null);
  const [ownerItems, setOwnerItems] = useState<{ vendorId: string; items: UnpublishedItem[] } | null>(null);
  const [ownerItemsVersion, setOwnerItemsVersion] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  // A callback ref (state), not useRef: the sentinel only mounts once
  // the skeleton is replaced, and the observer must attach then.
  const [chipsSentinel, setChipsSentinel] = useState<HTMLDivElement | null>(null);

  // TB-26: signing in is SHOPPING only - the public store page shows no
  // owner or employee tools on its own. A member of THIS store (from their
  // own workspace list, which carries the public slug) sees one extra link,
  // «إدارة هذا المتجر», to the entry confirmation; the tools appear only
  // once this tab has entered that store's workspace, and go away when it
  // leaves. Every tool call is still authorized by the API.
  const hydrated = useHydrated();
  const wsSnapshot = useSyncExternalStore(subscribeWorkspaces, workspaceSnapshot, () => "");
  const memberWorkspace = workspaces?.find(
    (workspace): workspace is Extract<WorkspaceInfo, { type: "vendor" }> =>
      workspace.type === "vendor" &&
      workspace.status === "ACTIVE" &&
      workspace.storefront_slug === params.slug,
  );
  const inWorkspace = Boolean(
    memberWorkspace &&
      hydrated &&
      wsSnapshot &&
      hasWorkspace({ type: "vendor", vendor_id: memberWorkspace.vendor_id }),
  );
  const ownerVendorId =
    inWorkspace && memberWorkspace?.role === "OWNER" ? memberWorkspace.vendor_id : null;
  useEffect(() => {
    if (!ownerVendorId) return;
    let cancelled = false;
    apiFetch<{ items: UnpublishedItem[] }>(`/vendors/${ownerVendorId}/unpublished-products`)
      .then((r) => {
        if (!cancelled) setOwnerItems({ vendorId: ownerVendorId, items: r.items });
      })
      .catch(() => {
        if (!cancelled) setOwnerItems({ vendorId: ownerVendorId, items: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [ownerVendorId, ownerItemsVersion]);
  const employeeWorkspace =
    inWorkspace && memberWorkspace?.role === "BRANCH_EMPLOYEE" && memberWorkspace.branch_id
      ? memberWorkspace
      : undefined;
  // «إشعاراتي» of the store workspace this tab is in - STORE notifications of
  // this store only (an employee: their own branch); the shopping bell never.
  const storeInboxVendor = ownerVendorId ?? employeeWorkspace?.vendor_id ?? null;
  // «بيع من المحل» (2026-11-20): in the store workspace the header's barcode
  // icon (instead of «مشاركة», which a store's own staff never needs) opens
  // the cashier inside the ONE large management window - for the owner and
  // for a branch employee alike. Shown only while the API serves the cashier
  // (store_cashier_enabled); a shopper's header is untouched.
  const [cashierVendor, setCashierVendor] = useState<string | null>(null);
  useEffect(() => {
    if (!storeInboxVendor) return;
    let cancelled = false;
    apiFetch(`/vendors/${storeInboxVendor}/cashier`)
      .then(() => {
        if (!cancelled) setCashierVendor(storeInboxVendor);
      })
      .catch(() => {
        if (!cancelled) setCashierVendor(null);
      });
    return () => {
      cancelled = true;
    };
  }, [storeInboxVendor]);
  const cashierEnabled = Boolean(storeInboxVendor && cashierVendor === storeInboxVendor);
  function openCashier() {
    if (!storeInboxVendor) return;
    setEmployeeWorkspaceOpen(false);
    setFrameState({ title: null, canBack: false, backTitle: null });
    setManagementOpen(true);
    setManagementDetail({ href: `/vendor/${storeInboxVendor}/cashier`, title: t("pos.title") });
  }
  const storeUnread = useUnreadNotificationCount(
    storeInboxVendor ? token : null,
    storeInboxVendor ? `/vendor/${storeInboxVendor}/notifications#${inboxVersion}` : "",
  );
  const manageHref =
    memberWorkspace && !inWorkspace && token
      ? workspaceEntryHref({ type: "vendor", vendor_id: memberWorkspace.vendor_id }, `/store/${params.slug}`)
      : null;

  // Phase A+ (final decision): «إدارة هذا المتجر» asks first - in a small
  // panel over this store page (no route of its own); a workspace card in
  // «حسابي» enters at once, and a direct link to a workspace page still goes
  // to the confirmation page. The API checks the membership and records the
  // entry (workspace.entered) either way.
  const [confirmEntry, setConfirmEntry] = useState(false);

  async function leaveStoreWorkspace() {
    if (!memberWorkspace) return;
    const ref = { type: "vendor" as const, vendor_id: memberWorkspace.vendor_id };
    try {
      await apiFetch("/me/workspace-sessions/current", { method: "DELETE", workspace: ref });
    } catch {
      // Leaving locally is what matters; the token also expires by itself.
    }
    forgetWorkspace(ref);
    setManagementOpen(false);
    setEmployeeWorkspaceOpen(false);
  }

  useEffect(() => {
    if (!managementOpen && !quickEdit && !appearanceDraft && !departmentPickerOpen && !subcategoryPickerOpen && !storeFilterOpen) return;
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (storeFilterOpen) setStoreFilterOpen(false);
        else if (departmentPickerOpen) setDepartmentPickerOpen(false);
        else if (subcategoryPickerOpen) setSubcategoryPickerOpen(false);
        else if (quickEdit) setQuickEdit(null);
        else if (appearanceDraft) setAppearanceDraft(null);
        else if (managementDetail) requestManagementClose();
        else setManagementOpen(false);
      }
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [managementOpen, managementDetail, quickEdit, appearanceDraft, departmentPickerOpen, subcategoryPickerOpen, storeFilterOpen, requestManagementClose]);

  /** Saves only what the panel pencil changed (one partial PUT). */
  async function saveAppearance(saved: StoreAppearance) {
    if (!appearanceDraft || !ownerVendorId) return;
    if (!appearanceColorsValid(appearanceDraft)) {
      setActionError({ key: "store.err.color" });
      return;
    }
    const patch = appearancePatch(appearanceDraft, saved);
    if (!patch) {
      setAppearanceDraft(null);
      return;
    }
    setAppearanceSaving(true);
    setActionError(null);
    try {
      const updated = await apiFetch<{ storefront_appearance: unknown }>(`/vendors/${ownerVendorId}/storefront`, {
        method: "PUT",
        body: { storefront_appearance: patch },
      });
      setAppearanceSaved(resolveAppearance(updated.storefront_appearance));
      setAppearanceDraft(null);
      setNotice("store.saved_appearance");
    } catch (err) {
      setActionError({ api: err, key: "store.err.appearance" });
    } finally {
      setAppearanceSaving(false);
    }
  }

  function openQuickEdit(field: QuickEditField, value: string | null, text?: HeroTextStyle) {
    setQuickEdit({ field, value: value ?? "", file: null, text });
  }

  /** The cover pencil: image (upload/URL) plus its layer settings,
   * starting from what this store has saved. */
  function openCoverEdit(look: CoverLook) {
    setQuickEdit({ field: "cover_image_url", value: look.imageUrl ?? "", file: null, cover: look });
  }

  function updateCoverDraft(patch: Partial<CoverLook>) {
    setQuickEdit((current) => current?.cover ? { ...current, cover: { ...current.cover, ...patch } } : current);
  }

  async function saveQuickEdit() {
    if (!quickEdit || !ownerVendorId) return;
    let value = quickEdit.value.trim();
    if (quickEdit.field === "display_name" && !value) {
      setActionError({ key: "store.err.name_empty" });
      return;
    }
    const cover = quickEdit.cover;
    const coverProblem = cover ? coverLookProblem(cover) : null;
    if (coverProblem) {
      setActionError({ text: coverProblem });
      return;
    }
    const text = quickEdit.text;
    const textField = quickEdit.field as HeroTextField;
    const textProblem = text ? heroTextProblem(text) : null;
    if (textProblem) {
      setActionError({ text: textProblem });
      return;
    }
    setQuickEditSaving(true);
    setActionError(null);
    try {
      if ((quickEdit.field === "logo_url" || quickEdit.field === "cover_image_url") && quickEdit.file) {
        const uploaded = await uploadVendorImage(ownerVendorId, quickEdit.file);
        value = uploaded.url;
      }
      await apiFetch(`/vendors/${ownerVendorId}/storefront`, {
        method: "PUT",
        body: {
          [quickEdit.field]: value,
          // Every layer setting travels in the same request as the image.
          ...(cover ? coverLookBody(cover) : {}),
          // The text's own styling only - the other text keeps its own.
          ...(text ? heroTextBody(textField, text) : {}),
        },
      });
      setQuickEditValues((current) => ({ ...current, [quickEdit.field]: value }));
      if (cover) setCoverLookOverride({ ...cover, imageUrl: value || null });
      if (text) setHeroTextSaved((current) => ({ ...current, [textField]: text }));
      setQuickEdit(null);
      setNotice("store.saved");
    } catch (err) {
      setActionError({ api: err, key: "store.err.save" });
    } finally {
      setQuickEditSaving(false);
    }
  }

  const followOverride = followOverrideState?.token === token ? followOverrideState.following : null;
  const favorites = favoritesState?.token === token ? favoritesState.byVariant : NO_FAVORITES;

  const loadFavorites = useCallback(async (forToken: string) => {
    setFavoritesState({ token: forToken, byVariant: favoritesByVariant(await apiFetch<FavoriteDto[]>("/favorites")) });
  }, []);

  /** A token the server rejects: clear it and sign in again. */
  function sessionExpired(err: unknown): boolean {
    if (!(err instanceof ApiError) || err.status !== 401) return false;
    clearSession();
    router.push(loginRedirectHref());
    return true;
  }

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    apiFetch<FavoriteDto[]>("/favorites")
      .then((rows) => {
        if (!cancelled) setFavoritesState({ token, byVariant: favoritesByVariant(rows) });
      })
      .catch(() => {
        // Non-fatal: hearts simply start empty.
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // The category bar sticks to the top only once its own spot has
  // scrolled past the top of the viewport.
  useEffect(() => {
    if (!chipsSentinel) return;
    const observer = new IntersectionObserver(([entry]) => {
      setChipsStuck(!entry.isIntersecting && entry.boundingClientRect.top < 0);
    });
    observer.observe(chipsSentinel);
    return () => observer.disconnect();
  }, [chipsSentinel]);

  // ?cat= is the single source of truth for the smart button.
  const activeSmart = SMART_TABS.find((t) => t.id === searchParams.get("cat")) ?? null;
  const collection: Collection = activeSmart?.collection ?? "ALL";

  // «مجموعات المتجر»: the store's own collections a shopper can open (visible,
  // with a product that can be bought now), in the owner's order - chips after
  // the automatic filters, kept in ?group=. A link to a hidden or empty one
  // lands on «الكل».
  const [storeGroups, setStoreGroups] = useState<StoreGroupDto[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ items: StoreGroupDto[] }>(`/storefronts/${params.slug}/store-collections`, { auth: false })
      .then((r) => {
        if (!cancelled) setStoreGroups(r.items);
      })
      .catch(() => {
        if (!cancelled) setStoreGroups([]);
      });
    return () => {
      cancelled = true;
    };
  }, [params.slug, catalogueVersion]);
  const groupParam = searchParams.get("group");
  const activeGroup = (groupParam && storeGroups?.find((g) => g.id === groupParam)) || null;
  useEffect(() => {
    if (!groupParam || storeGroups === null || activeGroup) return;
    const next = new URLSearchParams(searchParams.toString());
    next.delete("group");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [groupParam, storeGroups, activeGroup, searchParams, pathname, router]);

  function selectTab(id: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (id === "all") next.delete("cat");
    else next.set("cat", id);
    next.delete("group");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  /** A collection (null = none): the department and category go back to «الكل». */
  function selectGroup(id: string | null) {
    const next = new URLSearchParams(searchParams.toString());
    next.delete("cat");
    if (id) next.set("group", id);
    else next.delete("group");
    setActiveDepartment("all");
    setActiveSubcategory(null);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  // «الصفحة الرئيسية المرنة للمتجر»: the published blocks (none = the page
  // exactly as before). The home area (blocks, «معلومات المتجر») is the
  // «الكل» page only: a department (نساء / رجال / أطفال, with or without a
  // detailed category), a search, filter, smart filter or collection shows
  // the product browsing only - «استكشفي التصنيفات» stays to switch.
  const publishedHome = useStoreHome(params.slug, catalogueVersion);
  // «معاينة كاملة» from the designer: the OWNER sees her unpublished draft here
  // (?home_preview=draft), resolved by the API with the shoppers' own rules -
  // nothing is published; anyone else gets the public page.
  const draftPreviewAsked = searchParams.get("home_preview") === "draft";
  const draftHome = useDraftHome(draftPreviewAsked ? ownerVendorId : null);
  const draftPreview = Boolean(draftPreviewAsked && ownerVendorId && draftHome);
  const home = draftPreview ? draftHome : publishedHome;
  const homeActive = (home?.blocks.length ?? 0) > 0;
  const browsing =
    activeSubcategory !== null || activeSmart !== null || activeGroup !== null || debouncedQuery !== "" ||
    applied.colors.length + applied.sizes.length + applied.seasons.length > 0 || applied.availableOnly || applied.priceMin > 0 || applied.priceMax < PRICE_CEILING;
  /** The «الكل» page: identity, «استكشفي التصنيفات», the blocks, «معلومات المتجر», then the products. */
  const homeView = !browsing && activeDepartment === "all";
  const wasBrowsing = useRef(browsing);
  useEffect(() => {
    if (homeActive && browsing && !wasBrowsing.current) scrollToBrowse();
    wasBrowsing.current = browsing;
  }, [browsing, homeActive]);
  /** A block's destination: a product page, or the products section with that filter applied. */
  function applyHomeTarget(target: HomeTarget) {
    if (target.kind === "product") {
      router.push(`/store/${params.slug}/products/${target.id}`);
      return;
    }
    if (target.kind === "products") scrollToBrowse();
    else if (target.kind === "new" || target.kind === "sale") selectTab(target.kind);
    else if (target.kind === "collection") selectGroup(target.id);
    else if (target.kind === "audience") {
      // a category card to a department: that department's products (the fixed chips follow)
      selectGroup(null);
      selectDepartment(target.audience as ListingAudience);
      requestAnimationFrame(() => scrollToBrowse());
    } else {
      selectGroup(null);
      setActiveDepartment(target.audience as ListingAudience);
      setActiveSubcategory(target.category);
    }
  }

  // One request per combination of selections; the server narrows the
  // store's products by every one of them and counts the result.
  const catalogueQuery = (() => {
    const p = new URLSearchParams();
    if (activeDepartment !== "all") p.set("audience", activeDepartment);
    if (activeSubcategory) p.set("category", activeSubcategory);
    if (collection !== "ALL") p.set("collection", collection);
    if (activeGroup) p.set("section", activeGroup.id);
    if (debouncedQuery) p.set("q", debouncedQuery);
    if (applied.colors.length) p.set("color", applied.colors.join(","));
    if (applied.sizes.length) p.set("size", applied.sizes.join(","));
    if (applied.seasons.length) p.set("season", applied.seasons.join(","));
    if (applied.priceMin > 0) p.set("min_price", String(applied.priceMin));
    if (applied.priceMax < PRICE_CEILING) p.set("max_price", String(applied.priceMax));
    if (applied.availableOnly) p.set("available_only", "true");
    // Without a sort the API lists newest first (trending ones by trend).
    if (applied.sort !== "newest") p.set("sort", applied.sort);
    p.set("page_size", String(PAGE_SIZE));
    return p.toString();
  })();

  useEffect(() => {
    let cancelled = false;
    apiFetch<StoreProductsDto>(`/storefronts/${params.slug}/products?${catalogueQuery}&page=1`, { auth: false })
      .then((data) => {
        if (cancelled) return;
        setCatalogue({ key: catalogueQuery, data, items: data.items });
        setCatalogueError(null);
      })
      .catch((err) => {
        if (!cancelled)
          setCatalogueError(
            err instanceof ApiError && err.code === "FEATURE_DISABLED"
              ? { key: "store.err.bestseller_off" }
              : { api: err, key: "store.err.products" },
          );
      });
    return () => {
      cancelled = true;
    };
  }, [params.slug, catalogueQuery, catalogueVersion]);

  async function loadMore() {
    if (!catalogue || loadingMore) return;
    const { key, data } = catalogue;
    setLoadingMore(true);
    try {
      const next = await apiFetch<StoreProductsDto>(
        `/storefronts/${params.slug}/products?${key}&page=${data.page + 1}`,
        { auth: false },
      );
      setCatalogue((current) => {
        if (current?.key !== key) return current;
        const seen = new Set(current.items.map((o) => o.id));
        return { key, data: next, items: [...current.items, ...next.items.filter((o) => !seen.has(o.id))] };
      });
    } catch (err) {
      setActionError({ api: err, key: "store.err.more" });
    } finally {
      setLoadingMore(false);
    }
  }

  const initialFollowing = followStatus.data?.following ?? false;
  const following = followOverride ?? initialFollowing;

  async function toggleFollow() {
    if (!token) {
      router.push(loginRedirectHref());
      return;
    }
    setFollowBusy(true);
    setActionError(null);
    try {
      const res = await apiFetch<{ following: boolean }>(`/customers/me/following/${params.slug}`, {
        method: following ? "DELETE" : "PUT",
      });
      setFollowOverrideState({ token, following: res.following });
    } catch (err) {
      if (sessionExpired(err)) return;
      setActionError({ api: err, key: "store.err.follow" });
    } finally {
      setFollowBusy(false);
    }
  }

  async function toggleFavorite(offer: OfferSummaryDto) {
    const variantId = offer.favorite_variant_id;
    if (!variantId) return;
    if (!token) {
      router.push(loginRedirectHref());
      return;
    }
    setFavoriteBusy(variantId);
    setActionError(null);
    try {
      const existing = favorites.get(variantId);
      if (existing) {
        await apiFetch(`/favorites/${existing}`, { method: "DELETE" });
      } else {
        await apiFetch("/favorites", {
          method: "POST",
          body: { target_type: "OFFER", offer_variant_id: variantId },
        });
      }
      // The add response carries no id, so re-read the list - it is
      // also what keeps every heart in sync with the account.
      await loadFavorites(token);
    } catch (err) {
      if (sessionExpired(err)) return;
      setActionError({ api: err, key: "store.err.favorite" });
    } finally {
      setFavoriteBusy(null);
    }
  }

  async function share() {
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: store.data?.display_name, url });
      } else {
        await navigator.clipboard.writeText(url);
        setNotice("store.link_copied");
        setTimeout(() => setNotice(null), 2500);
      }
    } catch {
      // The user dismissed the share sheet - nothing to report.
    }
  }

  if (store.error) {
    return (
      <div className="page-shell">
        <div className="wide-shell">
          {store.status === 404 ? (
            <EmptyState title={t("store.not_found")} actionHref="/discovery" actionLabel={t("store.discover")} />
          ) : (
            <ErrorBanner message={t("store.err.page")} />
          )}
        </div>
      </div>
    );
  }
  if (!store.data || (!catalogue && !catalogueError)) {
    return <StoreSkeleton />;
  }

  const s = store.data;
  const statusLine = [
    s.is_available ? t("store.available_now") : t("store.unavailable"),
    s.is_verified && t("store.verified"),
  ]
    .filter(Boolean)
    .join(" · ");

  // Follower count shown after a follow/unfollow in this visit, without
  // re-fetching the storefront.
  const followerCount =
    s.follower_count + (followOverride === null ? 0 : Number(followOverride) - Number(initialFollowing));
  const rating = reviews.data?.aggregate;

  const logoUrl = quickEditValues.logo_url ?? s.logo_url;
  const coverImageUrl = quickEditValues.cover_image_url ?? s.cover_image_url;
  // The store's saved cover look (or what the owner just saved here).
  const coverLook: CoverLook = coverLookOverride ?? { ...coverLookFromDto(s), imageUrl: coverImageUrl };
  const cover = coverPresentation(coverLook, (url) => SAFE_URL.test(url));
  // The panel pencil's appearance (or what the owner just saved here).
  const appearance: StoreAppearance = appearanceSaved ?? resolveAppearance(s.storefront_appearance);
  const heroClass = ["store-hero", ...cover.heroClasses].join(" ");
  // The title's and description's own styling (or what the owner just saved here).
  const heroText: HeroTextLook = { ...heroTextFromDto(s), ...heroTextSaved };
  const lightHeroText = cover.heroClasses.includes("has-light-cover-text");

  const socialCandidates: { key: string; label: string; url: string | null; icon: ReactNode }[] = [
    { key: "whatsapp", label: t("store.social.whatsapp"), url: s.whatsapp_url, icon: <WhatsAppIcon /> },
    { key: "instagram", label: t("store.social.instagram"), url: s.instagram_url, icon: <InstagramIcon /> },
    { key: "facebook", label: t("store.social.facebook"), url: s.facebook_url, icon: <FacebookIcon /> },
  ];
  const socials = socialCandidates.filter(
    (c): c is { key: string; label: string; url: string; icon: ReactNode } =>
      c.url !== null && SAFE_URL.test(c.url),
  );
  // Sprint 26: WhatsApp opens with a ready first message naming the store.
  for (const c of socials) {
    if (c.key === "whatsapp") c.url = whatsappChatUrl(c.url, storeWhatsappMessage(s.display_name));
  }
  const whatsapp = socials.find((c) => c.key === "whatsapp");

  const listing = catalogue?.data ?? null;
  const storeTotal = listing?.store_total ?? 0;
  const hasProducts = storeTotal > 0;
  const departments = departmentsOverride ?? listing?.departments ?? [];
  // Phase A: the owner's own cards in the place shown (department / category).
  const ownerCards =
    ownerVendorId && ownerItems?.vendorId === ownerVendorId
      ? ownerItems.items
          .filter((item) => activeDepartment === "all" || item.audience === activeDepartment)
          .filter((item) => !activeSubcategory || item.category === activeSubcategory)
          .map((item) => (
            <OwnerUnpublishedCard key={`${item.kind}-${item.id}`} item={item} vendorId={ownerVendorId} onOpenDraft={(id) => setWizard({ draftId: id })} />
          ))
      : null;
  const activeDepartmentInfo =
    activeDepartment === "all" ? null : (departments.find((d) => d.audience === activeDepartment) ?? null);

  /** The sizes still valid in `department` (age sizes for kids, adult
   * sizes otherwise; «الكل» keeps both). */
  function sizesValidIn(department: "all" | ListingAudience, sizes: string[]) {
    if (department === "all" || !taxonomy.data) return sizes;
    const group = sizeGroupFor(department);
    const valid = new Set(taxonomy.data.sizes.filter((size) => size.group === group).map((size) => size.code));
    return sizes.filter((code) => valid.has(code));
  }

  // «الكل» or another department replaces only the department/category
  // scope: the smart button, the search and the drawer's filters stay,
  // except sizes of the other size group.
  function selectDepartment(department: "all" | ListingAudience) {
    setActiveDepartment(department);
    setActiveSubcategory(null);
    setApplied((current) => ({ ...current, sizes: sizesValidIn(department, current.sizes) }));
    setDraftSizes((current) => sizesValidIn(department, current));
  }

  /** «إضافة منتج»: the wizard over this list, with the list's own place as its (changeable) defaults. */
  function openAddProduct() {
    setWizardNotice(null);
    setWizard({
      draftId: null,
      context:
        activeDepartment === "all"
          ? {}
          : { audience: activeDepartment, category: activeSubcategory },
    });
  }

  /**
   * After the wizard: the list behind it changes only now - to the place
   * the product was saved in (its audience / category), when the storefront
   * shows that place; otherwise it says so. Nothing entered: nothing moves.
   */
  function onWizardClose(result: WizardResult) {
    setWizard(null);
    if (result.kind === "closed") return;
    setOwnerItemsVersion((v) => v + 1);
    if (result.kind === "created" || result.kind === "applied") setCatalogueVersion((v) => v + 1);
    if (result.kind === "applied") {
      setWizardNotice(t("wz.edit.applied"));
      return;
    }
    let message = result.kind === "saved" ? t("wz.toast.saved_draft") : result.published ? t("wz.toast.published") : t("wz.toast.created");
    if (result.audience) {
      const department = departments.find((d) => d.audience === result.audience);
      const categoryName = (() => {
        const c = taxonomy.data?.categories.find((x) => x.code === result.category);
        return c ? (lang === "en" ? c.name_en || c.name_ar : c.name_ar) : null;
      })();
      const path = [t(`wz.audience.${result.audience}`), categoryName].filter(Boolean).join(" › ");
      if (!department) {
        message += ` ${fillWz(t("wz.toast.not_listed"), { path })}`;
      } else {
        selectDepartment(result.audience);
        if (result.category && department.categories.some((c) => c.code === result.category)) {
          setActiveSubcategory(result.category);
        } else if (result.category) {
          message += ` ${fillWz(t("wz.toast.not_listed"), { path })}`;
        }
      }
    }
    setWizardNotice(message);
  }

  /** The owner's departments/categories, saved at once (owner-only PUT). */
  async function saveCatalogue(next: ListingAudience[], categories?: Partial<Record<ListingAudience, string[]>>) {
    if (!ownerVendorId || catalogueSaving) return;
    setCatalogueSaving(true);
    setActionError(null);
    try {
      const res = await apiFetch<{ departments: StoreDepartmentDto[] }>(`/vendors/${ownerVendorId}/storefront/catalogue`, {
        method: "PUT",
        body: { departments: next, ...(categories ? { categories } : {}) },
      });
      setDepartmentsOverride(res.departments);
      const still = res.departments.find((d) => d.audience === activeDepartment);
      if (activeDepartment !== "all" && !still) {
        setActiveDepartment("all");
        setActiveSubcategory(null);
      } else if (still && activeSubcategory && !still.categories.some((c) => c.code === activeSubcategory)) {
        setActiveSubcategory(null);
      }
      setCatalogueVersion((v) => v + 1);
    } catch (err) {
      setActionError({ api: err, key: "store.err.catalogue" });
    } finally {
      setCatalogueSaving(false);
    }
  }

  function toggleDepartment(department: ListingAudience) {
    const current = departments.map((d) => d.audience);
    void saveCatalogue(
      current.includes(department)
        ? current.filter((item) => item !== department)
        : DEPARTMENTS.filter((item) => item === department || current.includes(item)),
    );
  }

  function toggleSubcategory(department: ListingAudience, code: string) {
    const current = departments.find((d) => d.audience === department)?.categories.map((c) => c.code) ?? [];
    void saveCatalogue(departments.map((d) => d.audience), {
      [department]: current.includes(code) ? current.filter((item) => item !== code) : [...current, code],
    });
  }

  // The owner picks from the taxonomy's categories of that department.
  const subcategoryChoices =
    activeDepartment === "all" || !taxonomy.data
      ? []
      : taxonomy.data.categories
          .filter((category) => category.audiences.includes(activeDepartment))
          .sort((a, b) => a.sort_order - b.sort_order);

  function renderDepartmentTabs(stuck: boolean) {
    return (
      <div className={`store-department-nav${stuck ? " compact" : ""}`}>
        <div className="store-chips store-department-chips" role="tablist" aria-label={stuck ? t("store.departments_stuck") : t("store.departments")}>
          <button
            type="button"
            role="tab"
            aria-selected={activeDepartment === "all"}
            className={`store-chip store-chip-all${activeDepartment === "all" ? " active" : ""}`}
            onClick={() => selectDepartment("all")}
          >
            <span>{t("store.all")}</span>
            <small>{storeTotal}</small>
          </button>
          {departments.map((department) => (
            <button
              key={department.audience}
              type="button"
              role="tab"
              aria-selected={activeDepartment === department.audience}
              data-department={department.audience.toLowerCase()}
              className={`store-chip store-chip-department${activeDepartment === department.audience ? " active" : ""}`}
              onClick={() => selectDepartment(department.audience)}
            >
              <span>{pickText(lang, department.name_en, department.name_ar)}</span>
            </button>
          ))}
          {ownerVendorId && !stuck && (
            <button
              type="button"
              className="store-category-add-button store-department-add-button"
              onClick={() => setDepartmentPickerOpen((open) => !open)}
              aria-label={t("store.manage_departments")}
              title={t("store.add_department")}
            >
              +
            </button>
          )}
        </div>
        {activeDepartment !== "all" && (
          <div className="store-subcategory-row" data-department={activeDepartment.toLowerCase()} role="tablist" aria-label={fmt(t("store.categories_of"), { dept: t(`aud.${activeDepartment}`) })}>
            {ownerVendorId && !stuck && (
              <button type="button" className="store-category-add-button store-subcategory-add-button" onClick={() => setSubcategoryPickerOpen((open) => !open)} aria-label={t("store.manage_subcategories")} title={t("store.add_category")}>
                +
              </button>
            )}
            <button
              type="button"
              className="store-subcategory-scroll-button store-subcategory-scroll-previous"
              onClick={(event) => event.currentTarget.parentElement?.querySelector<HTMLElement>(".store-subcategory-chips")?.scrollBy({ left: -300, behavior: "smooth" })}
              aria-label={t("store.prev_categories_aria")}
              title={t("store.prev_categories")}
            >
              <BackIcon />
            </button>
            <div className="store-subcategory-chips">
              {(activeDepartmentInfo?.categories ?? []).map((category) => (
                <button
                  key={category.code}
                  type="button"
                  role="tab"
                  aria-selected={activeSubcategory === category.code}
                  data-category={category.code}
                  className={`store-subcategory-chip${activeSubcategory === category.code ? " active" : ""}`}
                  onClick={() => setActiveSubcategory((current) => (current === category.code ? null : category.code))}
                >
                  {pickText(lang, category.name_en, category.name_ar)}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="store-subcategory-scroll-button store-subcategory-scroll-next"
              onClick={(event) => event.currentTarget.parentElement?.querySelector<HTMLElement>(".store-subcategory-chips")?.scrollBy({ left: 300, behavior: "smooth" })}
              aria-label={t("store.next_categories_aria")}
              title={t("store.next_categories")}
            >
              <BackIcon />
            </button>
          </div>
        )}
      </div>
    );
  }

  function renderSmartFilters() {
    return (
      <div className="store-smart-filters" aria-label={t("store.product_filters")}>
        {SMART_TABS.map((tab) => {
          const active = collection === tab.collection;
          // Counted within everything else currently selected.
          const count = listing?.collection_counts[tab.collection] ?? 0;
          if (!active && count === 0) return null;
          return (
            <button
              key={tab.id}
              type="button"
              data-collection={tab.collection}
              aria-pressed={active}
              className={`store-chip store-chip-smart${active ? " active" : ""}`}
              onClick={() => selectTab(active ? "all" : tab.id)}
            >
              {tab.icon}
              <span>{t(tab.label)}</span>
              <small>{count}</small>
            </button>
          );
        })}
        {(storeGroups ?? []).map((g) => {
          const active = activeGroup?.id === g.id;
          return (
            <button
              key={g.id}
              type="button"
              aria-pressed={active}
              className={`store-chip store-chip-group${active ? " active" : ""}`}
              onClick={() => selectGroup(active ? null : g.id)}
              data-testid={`store-group-${g.id}`}
            >
              <span>{pickText(lang, g.name_en ?? "", g.name_ar)}</span>
              <small>{g.count}</small>
            </button>
          );
        })}
      </div>
    );
  }

  const filterAudiences: ListingAudience[] = activeDepartment === "all"
    ? ["WOMEN", "MEN", "KIDS"]
    : [activeDepartment];
  const audienceFilterOptions = filterAudiences.map((audience) => listingFilterOptions(audience, taxonomy.data, lang));
  // "الكل" is a genuine general filter: it joins the same taxonomy choices
  // shown in the three audience pages, without duplicate values.
  const filterOptions = {
    sizes: Array.from(new Map(audienceFilterOptions.flatMap((options) => options.sizes).map((option) => [option.code, option])).values()),
    colors: Array.from(new Map(audienceFilterOptions.flatMap((options) => options.colors).map((option) => [option.code, option])).values()),
    seasons: Array.from(new Map(audienceFilterOptions.flatMap((options) => options.seasons).map((option) => [option.code, option])).values()),
  };
  const filterCount = applied.colors.length + applied.sizes.length + applied.seasons.length + Number(applied.availableOnly) + Number(applied.priceMin > 0 || applied.priceMax < PRICE_CEILING);

  function openStoreFilter() {
    setDraftSort(applied.sort);
    setDraftColors(applied.colors);
    setDraftSizes(applied.sizes);
    setDraftSeasons(applied.seasons);
    setDraftAvailableOnly(applied.availableOnly);
    setDraftPriceMin(applied.priceMin);
    setDraftPriceMax(applied.priceMax);
    setStoreFilterOpen(true);
  }

  function toggleDraftValue(value: string, setValue: Dispatch<SetStateAction<string[]>>) {
    setValue((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  }

  function clearStoreFilter() {
    setDraftSort("newest");
    setDraftColors([]);
    setDraftSizes([]);
    setDraftSeasons([]);
    setDraftAvailableOnly(false);
    setDraftPriceMin(0);
    setDraftPriceMax(PRICE_CEILING);
    // Only the drawer's own filters: department, category, smart button
    // and search stay.
    setApplied(NO_FILTERS);
  }

  function applyStoreFilter() {
    setApplied({
      colors: draftColors,
      sizes: sizesValidIn(activeDepartment, draftSizes),
      seasons: draftSeasons,
      availableOnly: draftAvailableOnly,
      priceMin: draftPriceMin,
      priceMax: draftPriceMax,
      sort: draftSort,
    });
    setStoreFilterOpen(false);
  }

  // a category opened from a home block may not be one of the owner's own chips
  const activeSubcategoryName = activeSubcategory
    ? (() => {
        const c = activeDepartmentInfo?.categories.find((x) => x.code === activeSubcategory) ?? taxonomy.data?.categories.find((x) => x.code === activeSubcategory);
        return c ? pickText(lang, c.name_en, c.name_ar) : null;
      })()
    : null;
  const activeLabel = [
    activeDepartmentInfo ? pickText(lang, activeDepartmentInfo.name_en, activeDepartmentInfo.name_ar) : null,
    (() => {
      // a category opened from a home block may not be one of the owner's own chips
      const c = activeDepartmentInfo?.categories.find((x) => x.code === activeSubcategory) ?? taxonomy.data?.categories.find((x) => x.code === activeSubcategory);
      return c ? pickText(lang, c.name_en, c.name_ar) : null;
    })(),
    activeSmart ? t(activeSmart.label) : null,
  ].filter(Boolean).join(" · ");
  const listingStale = catalogue?.key !== catalogueQuery;
  // «استكشفي التصنيفات»: always right under the store's identity, above the
  // home blocks (every store, with or without them) - never a filter tool of
  // «تصفّحي المنتجات».
  const categoriesBlock = hasProducts && (
    <div className="store-categories">
      <div className="store-categories-heading">
        <h2>{t("store.explore_categories")}</h2>
      </div>
      <div className="store-category-controls">
        <div ref={setChipsSentinel} />
        {renderDepartmentTabs(false)}
      </div>
    </div>
  );
  /**
   * P3: when the first block shown on «الكل» is a full-width Hero and nothing
   * else (a notice, an error, the store's unavailable banner) sits above it,
   * the Hero starts at the very top of the content panel, rounded like it.
   * Automatic - no setting of its own; every other page keeps its spacing.
   */
  const firstHome = homeActive && homeView ? home?.blocks[0] : undefined;
  const flushHero = Boolean(
    firstHome && firstHome.type === "hero" && firstHome.display?.width === "full" &&
      !notice && !wizardNotice && !confirmEntry && !actionError && s.is_available && !catalogueError,
  );
  // phone only (CSS): skip the home blocks straight to the products
  const jumpLink = (
    <a
      href="#store-browse"
      className="store-jump-products"
      onClick={(event) => {
        event.preventDefault();
        scrollToBrowse();
        document.getElementById("store-browse")?.focus({ preventScroll: true });
      }}
      data-testid="store-jump-products"
    >
      {t("home.jump_products")} <span aria-hidden="true">↓</span>
    </a>
  );
  const displayName = quickEditValues.display_name ?? s.display_name;
  const heroTitle = quickEditValues.hero_title ?? s.hero_title;
  const storeBio = quickEditValues.bio ?? s.bio;

  return (
    <div className={`store-view${whatsapp ? " has-whatsapp-fab" : ""}`} style={appearanceVars(appearance) as CSSProperties}>
      <section className={heroClass} style={cover.heroVars as CSSProperties}>
        {cover.overlay && <span className="store-cover-overlay" aria-hidden="true" />}
        {ownerVendorId && <button type="button" className="store-image-edit-button store-cover-edit-button" onClick={() => openCoverEdit(coverLook)} aria-label={t("store.change_cover")} title={t("store.change_cover")}><PencilIcon /></button>}
        <div className="store-shell">
          <div className="store-topbar">
            <div className="store-identity">
              <div className="store-logo-editable">
              {logoUrl ? (
                <SafeImage src={logoUrl} alt={displayName} className="store-logo" />
              ) : (
                <div className="store-logo store-view-logo-placeholder">{displayName.slice(0, 1)}</div>
              )}
              {ownerVendorId && <button type="button" className="store-image-edit-button store-logo-edit-button" onClick={() => openQuickEdit("logo_url", logoUrl)} aria-label={t("store.change_logo")} title={t("store.change_logo")}><PencilIcon /></button>}
              </div>
              <div className="store-identity-text">
                <div className="store-name-row">
                  <h1 className="store-name">{displayName}</h1>
                  {ownerVendorId && (
                    <button type="button" className="store-inline-edit-button" onClick={() => openQuickEdit("display_name", displayName)} aria-label={t("store.edit_name")} title={t("store.edit_name")}><PencilIcon /></button>
                  )}
                  <button
                    type="button"
                    className={`store-follow${following ? " following" : ""}`}
                    onClick={toggleFollow}
                    disabled={followBusy || (!s.is_available && !following)}
                    aria-pressed={following}
                  >
                    {following ? t("store.following") : t("store.follow")}
                  </button>
                </div>
                <div className="store-stats">
                  {listing && <span>{fmt(t("store.n_products"), { n: formatCount(storeTotal) })}</span>}
                  <span>{fmt(t("store.n_followers"), { n: formatCount(followerCount) })}</span>
                  {rating && rating.count > 0 && (
                    <Link href={`/store/${params.slug}/reviews`} className="store-rating">
                      {rating.average !== null ? (
                        <>
                          <StarIcon /> {rating.average.toFixed(1)}
                          <small>({formatCount(rating.count)})</small>
                        </>
                      ) : (
                        <>{fmt(t("store.n_ratings"), { n: formatCount(rating.count) })}</>
                      )}
                    </Link>
                  )}
                </div>
                <span className={`store-status${s.is_available ? "" : " store-status-off"}`}>{statusLine}</span>
              </div>
            </div>
            <div className="store-topbar-actions">
              {ownerVendorId ? (
                <>
                  <button
                    type="button"
                    className="store-icon-button store-account-button"
                    onClick={() => window.dispatchEvent(new Event("open-account-overlay"))}
                    aria-label={t("store.open_account")}
                    aria-haspopup="dialog"
                    title={t("store.account")}
                  >
                    <UserIcon />
                  </button>
                  <button
                    type="button"
                    className="store-icon-button store-manage-button"
                    onClick={() => setManagementOpen(true)}
                    aria-label={t("store.open_manage")}
                    aria-haspopup="dialog"
                    title={t("store.manage")}
                  >
                    <StoreManageIcon />
                  </button>
                  <button
                    type="button"
                    className="store-icon-button store-inbox-button"
                    onClick={() => setStoreInboxOpen(true)}
                    aria-label={storeUnread > 0 ? fmt(t("store.inbox_open"), { n: storeUnread }) : t("store.inbox")}
                    title={t("store.inbox")}
                    data-testid="store-inbox-button"
                  >
                    <IconBell />
                    {storeUnread > 0 && <span className="store-inbox-badge" aria-hidden="true">{storeUnread}</span>}
                  </button>
                  {cashierEnabled ? (
                    <button
                      type="button"
                      className="store-icon-button store-cashier-button"
                      onClick={openCashier}
                      aria-label={t("pos.icon.open")}
                      aria-haspopup="dialog"
                      title={t("pos.icon.title")}
                      data-testid="store-cashier-button"
                    >
                      <ScanBarcodeIcon />
                    </button>
                  ) : (
                    <button type="button" className="store-icon-button" onClick={share} aria-label={t("store.share")} title={t("store.share")}>
                      <ExpandIcon />
                    </button>
                  )}
                  <button type="button" className="store-leave-workspace" onClick={() => void leaveStoreWorkspace()} aria-label={t("ws.leave.aria")} data-testid="store-leave-workspace">
                    {t("ws.leave")}
                  </button>
                </>
              ) : employeeWorkspace ? (
                <>
                  <button
                    type="button"
                    className="store-icon-button store-back-button"
                    onClick={() => window.history.length > 1 ? router.back() : router.push("/")}
                    aria-label={t("store.back_aria")}
                    title={t("store.back")}
                  >
                    <BackIcon />
                  </button>
                  <button
                    type="button"
                    onClick={() => setStoreInboxOpen(true)}
                    className="store-icon-button store-inbox-button"
                    aria-label={storeUnread > 0 ? fmt(t("store.inbox_open"), { n: storeUnread }) : t("store.inbox")}
                    title={t("store.inbox")}
                    data-testid="store-inbox-button"
                  >
                    <IconBell />
                    {storeUnread > 0 && <span className="store-inbox-badge" aria-hidden="true">{storeUnread}</span>}
                  </button>
                  {cashierEnabled && (
                    <button
                      type="button"
                      className="store-icon-button store-cashier-button"
                      onClick={openCashier}
                      aria-label={t("pos.icon.open")}
                      aria-haspopup="dialog"
                      title={t("pos.icon.title")}
                      data-testid="store-cashier-button"
                    >
                      <ScanBarcodeIcon />
                    </button>
                  )}
                  <button
                    type="button"
                    className="store-icon-button store-employee-workspace-button"
                    onClick={() => setEmployeeWorkspaceOpen(true)}
                    aria-label={t("store.open_workspace")}
                    title={t("store.workspace")}
                  >
                    <StoreManageIcon />
                  </button>
                  <button type="button" className="store-leave-workspace" onClick={() => void leaveStoreWorkspace()} aria-label={t("ws.leave.aria")} data-testid="store-leave-workspace">
                    {t("ws.leave")}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="store-icon-button store-back-button"
                    onClick={() => window.history.length > 1 ? router.back() : router.push("/")}
                    aria-label={t("store.back_aria")}
                    title={t("store.back")}
                  >
                    <BackIcon />
                  </button>
                  {manageHref && (
                    <a
                      href={manageHref}
                      className="store-manage-link"
                      aria-haspopup="dialog"
                      onClick={(e) => {
                        e.preventDefault();
                        setConfirmEntry(true);
                      }}
                      data-testid="store-manage-link"
                    >
                      {t("ws.manage_store")}
                    </a>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="store-intro">
            <div className="store-editable-hero-line">
              <h2 style={heroTextCss(heroText.hero_title, lightHeroText)}>{heroTitle || displayName}</h2>
              {ownerVendorId && <button type="button" className="store-inline-edit-button" onClick={() => openQuickEdit("hero_title", heroTitle, heroText.hero_title)} aria-label={t("store.edit_hero_title")} title={t("store.edit_hero_title")}><PencilIcon /></button>}
            </div>
            <div className="store-editable-hero-line store-editable-hero-bio">
              <p style={heroTextCss(heroText.bio, lightHeroText)}>{storeBio ?? t("store.bio_default")}</p>
              {ownerVendorId && <button type="button" className="store-inline-edit-button" onClick={() => openQuickEdit("bio", storeBio, heroText.bio)} aria-label={t("store.edit_bio")} title={t("store.edit_bio")}><PencilIcon /></button>}
            </div>
            {socials.length > 0 && (
              <div className="store-socials">
                {socials.map((c) => (
                  <a
                    key={c.key}
                    href={c.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`store-social store-social-${c.key}`}
                    aria-label={c.label}
                    title={c.label}
                  >
                    {c.icon}
                  </a>
                ))}
              </div>
            )}
          </div>

          {categoriesBlock}
        </div>
      </section>

      {ownerVendorId && departmentPickerOpen && (
        <div className="store-category-picker-overlay" role="presentation" onClick={() => setDepartmentPickerOpen(false)}>
          <div className="store-category-picker" role="dialog" aria-modal="true" aria-label={t("store.pick_departments")} onClick={(event) => event.stopPropagation()}>
            <strong>{t("store.departments_offered")}</strong>
            <p>{t("store.departments_hint")}</p>
            <div>
              {DEPARTMENTS.map((department) => (
                <label key={department}>
                  <input type="checkbox" checked={departments.some((d) => d.audience === department)} disabled={catalogueSaving} onChange={() => toggleDepartment(department)} />
                  <span>{t(`aud.${department}`)}</span>
                </label>
              ))}
            </div>
            <button type="button" onClick={() => setDepartmentPickerOpen(false)}>{t("store.done")}</button>
          </div>
        </div>
      )}
      {ownerVendorId && activeDepartment !== "all" && subcategoryPickerOpen && (
        <div className="store-category-picker-overlay" role="presentation" onClick={() => setSubcategoryPickerOpen(false)}>
          <div className="store-category-picker" role="dialog" aria-modal="true" aria-label={t("store.pick_subcategories")} onClick={(event) => event.stopPropagation()}>
            <strong>{fmt(t("store.categories_of"), { dept: t(`aud.${activeDepartment}`) })}</strong>
            <p>{t("store.subcategories_hint")}</p>
            <div>
              {subcategoryChoices.map((category) => (
                <label key={category.code}>
                  <input
                    type="checkbox"
                    checked={activeDepartmentInfo?.categories.some((c) => c.code === category.code) ?? false}
                    disabled={catalogueSaving}
                    onChange={() => toggleSubcategory(activeDepartment, category.code)}
                  />
                  <span>{pickText(lang, category.name_en, category.name_ar)}</span>
                </label>
              ))}
            </div>
            <button type="button" onClick={() => setSubcategoryPickerOpen(false)}>{t("store.done")}</button>
          </div>
        </div>
      )}

      {storeFilterOpen && (
        <>
          <button className="store-filter-scrim" type="button" aria-label={t("list.close_filter")} onClick={() => setStoreFilterOpen(false)} />
          <aside id="store-filter-drawer" className="store-filter-drawer" aria-label={t("list.filter_products")}>
            <div className="store-filter-head">
              <div><span>{t("list.find_yours")}</span><h2>{t("list.filter")}</h2></div>
              <button type="button" className="store-filter-close" aria-label={t("list.close_filter")} onClick={() => setStoreFilterOpen(false)}>
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
              </button>
            </div>
            <div className="store-filter-scroll">
              <fieldset className="store-filter-group"><legend>{t("list.sort")}</legend><div className="store-filter-options">
                {([['newest', 'list.sort.newest'], ['price_asc', 'list.sort.price-asc'], ['price_desc', 'list.sort.price-desc'], ...(catalogue?.data.bestseller_enabled ? [['bestseller', 'list.sort.bestseller'] as const] : [])] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={draftSort === value} onClick={() => setDraftSort(value)}>{t(label)}</button>)}
              </div></fieldset>
              <fieldset className="store-filter-group"><legend>{t("list.price")}</legend><div className="store-filter-price">
                <span>{fmt(t("list.price_from"), { n: draftPriceMin > 0 ? draftPriceMin : 0 })} — {draftPriceMax < 1000 ? fmt(t("list.price_to"), { n: draftPriceMax }) : t("list.price_no_max")}</span>
                <input type="range" aria-label={t("list.price_min")} min="0" max="1000" step="10" value={draftPriceMin} onChange={(event) => setDraftPriceMin(Math.min(Number(event.target.value), draftPriceMax))} />
                <input type="range" aria-label={t("list.price_max")} min="0" max="1000" step="10" value={draftPriceMax} onChange={(event) => setDraftPriceMax(Math.max(Number(event.target.value), draftPriceMin))} />
              </div></fieldset>
              <fieldset className="store-filter-group"><legend>{t("list.size")}</legend><div className="store-filter-options store-filter-options-compact">
                {filterOptions.sizes.map((size) => <button key={size.code} type="button" aria-pressed={draftSizes.includes(size.code)} onClick={() => toggleDraftValue(size.code, setDraftSizes)}>{size.label}</button>)}
              </div></fieldset>
              <fieldset className="store-filter-group"><legend>{t("list.color")}</legend><div className="store-filter-colors">
                {filterOptions.colors.map((color) => <label key={color.code}><input type="checkbox" checked={draftColors.includes(color.code)} onChange={() => toggleDraftValue(color.code, setDraftColors)} /><span>{color.label}</span></label>)}
              </div></fieldset>
              <fieldset className="store-filter-group"><legend>{t("list.season")}</legend><div className="store-filter-options">
                {filterOptions.seasons.map((season) => <button key={season.code} type="button" aria-pressed={draftSeasons.includes(season.code)} onClick={() => toggleDraftValue(season.code, setDraftSeasons)}>{season.label}</button>)}
              </div></fieldset>
              <label className="store-filter-availability"><input type="checkbox" checked={draftAvailableOnly} onChange={(event) => setDraftAvailableOnly(event.target.checked)} /><span>{t("list.available_only")}</span></label>
            </div>
            <div className="store-filter-actions"><button type="button" onClick={clearStoreFilter}>{t("list.clear_all")}</button><button type="button" onClick={applyStoreFilter}>{t("list.show_results")}</button></div>
          </aside>
        </>
      )}

      {draftPreview && (
        <div className="store-home-draft-banner" role="status" data-testid="store-home-draft-banner">
          <span>{t("home.draft_banner")}</span>
          {/* closing the preview is the one thing that still works in it */}
          <Link href={`/store/${params.slug}`} className="store-home-draft-close" data-preview-allow data-testid="store-home-draft-close">{t("home.draft_banner_close")}</Link>
        </div>
      )}
      {/* P1 «معاينة آمنة»: the owner's full preview is read only - nothing acts, no write leaves the browser */}
      {draftPreviewAsked && ownerVendorId && <PreviewGuard mode="document" />}

      {hasProducts && (
        <div className={`store-sticky-bar${chipsStuck ? " visible" : ""}`} aria-hidden={!chipsStuck}>
          <div className="store-shell">{renderDepartmentTabs(true)}</div>
        </div>
      )}

      <section
        className={[
          "store-products",
          ...cover.panelClasses,
          // The panel pencil's own shadow/border join the cover's fade.
          (appearance.panel.shadow_opacity > 0 || appearance.panel.border_opacity > 0) && "has-panel-own-shadow",
          flushHero && "has-flush-hero",
        ].filter(Boolean).join(" ")}
        style={cover.panelVars as CSSProperties}
        // the first full-width Hero reaches the panel's own edges
        data-sh-frame={flushHero ? "" : undefined}
      >
        {ownerVendorId && (
          <button
            type="button"
            className="store-image-edit-button store-panel-edit-button"
            onClick={() => setAppearanceDraft(appearance)}
            aria-label={t("store.edit_panel")}
            title={t("store.edit_panel")}
          >
            <PencilIcon />
          </button>
        )}
        <div className="store-shell">
          {notice && <div className="notice-banner" role="status">{t(notice)}</div>}
          {wizardNotice && <div className="notice-banner" role="status" data-testid="store-wizard-notice">{wizardNotice}</div>}
          {wizard && ownerVendorId && <ProductWizardPanel vendorId={ownerVendorId} open={wizard} onClose={onWizardClose} />}
          {confirmEntry && memberWorkspace && !inWorkspace && (
            <WorkspaceEnterPanel
              vendorId={memberWorkspace.vendor_id}
              storeName={memberWorkspace.vendor_legal_name}
              role={memberWorkspace.role}
              branchName={memberWorkspace.branch_name}
              onCancel={() => setConfirmEntry(false)}
              onEntered={() => setConfirmEntry(false)}
            />
          )}
          {actionError && <ErrorBanner message={uiMsgText(actionError, lang)} />}
          {!s.is_available && (
            <div className="warning-banner">{t("store.unavailable_banner")}</div>
          )}

          {catalogueError && <ErrorBanner message={uiMsgText(catalogueError, lang)} />}

          {homeActive && homeView && home && (
            // the first full-width Hero starts at the very top of the panel: the owner's pencil
            // floats over it (no row of its own) and the phone's jump link follows the Hero
            <div className={`store-home-area${flushHero ? " is-flush" : ""}`} data-testid="store-home-area">
              {!flushHero && jumpLink}
              {ownerVendorId && (
                <div className="store-home-owner-bar">
                  <button type="button" className="store-home-owner-edit" onClick={() => openFromInbox(`/vendor/${ownerVendorId}/storefront/home`)} data-testid="store-home-design">
                    <PencilIcon /> {t("home.design")}
                  </button>
                </div>
              )}
              <StoreHomeBlocks blocks={home.blocks} slug={params.slug} onTarget={applyHomeTarget} look={home.style} afterFirst={flushHero ? jumpLink : undefined} />
            </div>
          )}
          {ownerVendorId && home?.enabled && !homeActive && homeView && (
            <div className="store-home-owner-prompt" data-testid="store-home-prompt">
              <div>
                <strong>{t("home.owner_prompt_title")}</strong>
                <p>{t("home.owner_prompt_lead")}</p>
              </div>
              <button type="button" className="button owner-primary" onClick={() => openFromInbox(`/vendor/${ownerVendorId}/storefront/home`)}>
                {t("home.owner_prompt_cta")}
              </button>
            </div>
          )}

          {/* «معلومات المتجر»: the end of the home area - the «الكل» page only */}
          {homeView && info.data && <StoreInfo info={info.data} />}

          <div id="store-browse" className="store-browse" tabIndex={-1}>

          {listing && storeTotal === 0 && s.is_available && !ownerVendorId && (
            <EmptyState title={t("store.empty")} />
          )}
          {listing && storeTotal === 0 && ownerVendorId && (
            <div className="product-grid store-product-grid">
              <AddProductCard onClick={openAddProduct} />
              {ownerCards}
            </div>
          )}

          {hasProducts && (
            <>
              {activeDepartmentInfo && (
                <div className="store-audience-title" data-testid="store-audience-title">
                  <h2>
                    <span className="store-audience-name">{pickText(lang, activeDepartmentInfo.name_en, activeDepartmentInfo.name_ar)}</span>
                    {activeSubcategoryName && (
                      <>
                        <span className="store-audience-sep" aria-hidden="true"> · </span>
                        <span className="store-audience-sub">{activeSubcategoryName}</span>
                      </>
                    )}
                  </h2>
                  {activeSubcategoryName && (
                    <span className="store-audience-count" data-testid="store-audience-count">{fmt(t("store.n_products"), { n: listing?.total ?? 0 })}</span>
                  )}
                </div>
              )}
              <div className="store-products-heading">
                {activeDepartmentInfo ? (
                  // the audience title above names the page; the tools keep their place
                  <span className="store-products-heading-spacer" aria-hidden="true" />
                ) : (
                  <h2>
                    {activeLabel || t("store.all_products")}
                    <span className="muted store-products-total"> · {fmt(t("store.n_products"), { n: listing?.total ?? 0 })}</span>
                  </h2>
                )}
                <div className="store-products-controls">
                  <div className="store-tools">
                    <label className={`store-search${searchExpanded ? " expanded" : ""}`} onClick={() => setSearchExpanded(true)}>
                      <SearchIcon />
                      <input
                        type="search"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onBlur={() => { if (!query.trim()) setSearchExpanded(false); }}
                        placeholder={t("store.search_placeholder")}
                        aria-label={t("store.search_aria")}
                      />
                    </label>
                    <button
                      type="button"
                      className="store-filter-toggle"
                      onClick={openStoreFilter}
                      aria-expanded={storeFilterOpen}
                      aria-controls="store-filter-drawer"
                    >
                      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M5.5 10h9M8 15h4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
                      {t("list.filter")}{filterCount > 0 ? ` (${filterCount})` : ""}
                    </button>
                  </div>
                  {renderSmartFilters()}
                </div>
              </div>
              {/* No match stays empty - the selections are never widened. */}
              {(catalogue?.items.length ?? 0) === 0 && (
                <p className="muted store-no-results" aria-busy={listingStale}>
                  {debouncedQuery ? t("store.no_search_results") : t("store.no_filter_results")}
                </p>
              )}
              {((catalogue?.items.length ?? 0) > 0 || ownerVendorId) && (
                <div className="product-grid store-product-grid" aria-busy={listingStale}>
                  {ownerVendorId && <AddProductCard onClick={openAddProduct} />}
                  {ownerCards}
                  {(catalogue?.items ?? []).map((o) => (
                    <StoreOfferCard
                      key={o.id}
                      slug={params.slug}
                      offer={o}
                      favorited={o.favorite_variant_id !== null && favorites.has(o.favorite_variant_id)}
                      busy={favoriteBusy !== null && favoriteBusy === o.favorite_variant_id}
                      onToggleFavorite={toggleFavorite}
                    />
                  ))}
                </div>
              )}
              {catalogue && !listingStale && catalogue.items.length < catalogue.data.total && (
                <div className="store-load-more">
                  <button type="button" className="button button-secondary" onClick={loadMore} disabled={loadingMore}>
                    {loadingMore ? t("store.loading_more") : fmt(t("store.show_more"), { n: catalogue.data.total - catalogue.items.length })}
                  </button>
                </div>
              )}
            </>
          )}
          </div>
        </div>
      </section>

      {whatsapp && (
        <a
          href={whatsapp.url}
          target="_blank"
          rel="noopener noreferrer"
          className="store-whatsapp-fab"
        >
          <WhatsAppIcon size={22} />
          <span>{t("store.whatsapp_cta")}</span>
        </a>
      )}

      {storeInboxVendor && (
        <NotificationsPanel
          open={storeInboxOpen}
          onClose={closeStoreInbox}
          apiBase={`/vendors/${storeInboxVendor}/notifications`}
          title={t("store.inbox")}
          variant="store"
          onNavigate={openFromInbox}
        />
      )}
      {managementOpen && (ownerVendorId || (employeeWorkspace && managementDetail)) && (
        <div
          className="store-management-overlay"
          role="presentation"
          onClick={(event) => {
            const target = event.target;
            if (!(target instanceof Element) || !target.closest(".store-management-tile")) {
              setManagementDetail(null);
              setManagementOpen(false);
            }
          }}
        >
          {ownerVendorId && (
          <section
            className="store-management-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="store-management-title"
          >
            <header className="store-management-header">
              <h2 id="store-management-title">{t("store.manage")}</h2>
            </header>
            <div className="hub-grid store-management-grid">
              {ownerHubTiles(ownerVendorId)
                .filter((tile) => cashierEnabled || !(tile.href.endsWith("/store-sales") || tile.href.endsWith("/labels")))
                .filter((tile) => home?.enabled || !tile.href.endsWith("/storefront/home"))
                .map((tile) => {
                // Keep the management panel usable if a new navigation tile is
                // added before its optional visual metadata is configured.
                const detail = MANAGEMENT_TILE_DETAILS[tileKey(tile.href)] ?? { icon: "chart" as ManagementTileIconName, badge: "", footer: "" };
                return (
                <button
                  key={tile.href}
                  type="button"
                  className={`hub-tile store-management-tile${tile.deferred ? " is-deferred" : ""}`}
                  data-testid={`management-tile-${tileKey(tile.href)}`}
                  onClick={() => {
                    setFrameState({ title: null, canBack: false, backTitle: null });
                    setManagementDetail({ href: tile.href, title: tile.title });
                  }}
                >
                  <span className="store-management-tile-icon"><ManagementTileIcon name={detail.icon} /></span>
                  <span className="store-management-tile-copy">
                    <small className="store-management-tile-meta">{detail.badge ? t(detail.badge) : ""}</small>
                    <strong>{tile.title}</strong>
                    <span>{tile.description}</span>
                  </span>
                  <span className="store-management-tile-footer">
                    <small>{detail.footer ? t(detail.footer) : ""}</small>
                    <b>{t("store.open")} <i aria-hidden="true">‹</i></b>
                  </span>
                </button>
                );
              })}
            </div>
          </section>
          )}
          {managementDetail && (
            <div
              className="store-management-detail-layer"
              onClick={(event) => {
                event.stopPropagation();
                if (event.target === event.currentTarget) requestManagementClose();
              }}
            >
              <section
                className="store-management-detail-panel"
                role="dialog"
                aria-modal="true"
                aria-labelledby="store-management-detail-title"
              >
                <header className="store-management-detail-header">
                  <div className="store-management-detail-heading">
                    {frameState.canBack && (
                      <button
                        type="button"
                        className="store-management-detail-back"
                        onClick={() => managementFrameRef.current?.contentWindow?.postMessage({ source: "fp-manage-frame", type: "back" }, window.location.origin)}
                        aria-label={fillWz(t("panel.back_to"), { title: frameState.backTitle ?? managementDetail.title })}
                        title={fillWz(t("panel.back_to"), { title: frameState.backTitle ?? managementDetail.title })}
                        data-testid="management-frame-back"
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon-flip-rtl">
                          <path d="M15 6l-6 6 6 6" />
                        </svg>
                      </button>
                    )}
                    <h2 id="store-management-detail-title" data-testid="management-frame-title">{frameState.title ?? managementDetail.title}</h2>
                  </div>
                  {ownerVendorId && (
                    <button
                      type="button"
                      className="store-management-detail-inbox"
                      onClick={() => setStoreInboxOpen(true)}
                      aria-label={storeUnread > 0 ? fmt(t("store.inbox_open"), { n: storeUnread }) : t("store.inbox")}
                      title={t("store.inbox")}
                      data-testid="management-frame-inbox"
                    >
                      <IconBell />
                      {storeUnread > 0 && <span className="store-inbox-badge" aria-hidden="true">{storeUnread}</span>}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={requestManagementClose}
                    aria-label={t("store.close")}
                    title={t("store.close")}
                    data-testid="management-frame-close"
                  >
                    ×
                  </button>
                </header>
                <iframe
                  ref={managementFrameRef}
                  className="store-management-detail-frame"
                  src={`${managementDetail.href}${managementDetail.href.includes("?") ? "&" : "?"}embed=management`}
                  title={managementDetail.title}
                />
              </section>
            </div>
          )}
        </div>
      )}
      {employeeWorkspaceOpen && employeeWorkspace && (
        <div className="store-management-overlay employee-workspace-overlay" role="presentation" onClick={() => setEmployeeWorkspaceOpen(false)}>
          <section className="employee-workspace-panel" role="dialog" aria-modal="true" aria-labelledby="employee-workspace-title" onClick={(event) => event.stopPropagation()}>
            <header className="employee-workspace-panel-header">
              <div>
                <span>{t("store.workspace")}</span>
                <h2 id="employee-workspace-title">{employeeWorkspace.branch_name ?? t("store.my_branch")}</h2>
                <p>{t("store.workspace_hint")}</p>
              </div>
              <button type="button" onClick={() => setEmployeeWorkspaceOpen(false)} aria-label={t("store.close_workspace")} title={t("store.close")}>×</button>
            </header>
            <div className="employee-workspace-card-grid">
              <Link href={`/vendor/${employeeWorkspace.vendor_id}/notifications`} className="employee-workspace-card" onClick={() => setEmployeeWorkspaceOpen(false)} data-testid="employee-inbox-card">
                <span className="employee-workspace-card-icon"><ManagementTileIcon name="bell" /></span>
                <strong>{t("store.ws.alerts")}</strong>
                <p>{t("store.ws.alerts_hint")}</p>
                <span className="employee-workspace-card-footer"><small>{t("store.ws.alerts_footer")}</small><b>{t("store.open")} <i>‹</i></b></span>
              </Link>
              <Link href={`/vendor/${employeeWorkspace.vendor_id}/branches/${employeeWorkspace.branch_id}/orders`} className="employee-workspace-card" onClick={() => setEmployeeWorkspaceOpen(false)}>
                <span className="employee-workspace-card-icon"><ManagementTileIcon name="document" /></span>
                <strong>{t("store.ws.orders")}</strong>
                <p>{t("store.ws.orders_hint")}</p>
                <span className="employee-workspace-card-footer"><small>{t("store.ws.orders_footer")}</small><b>{t("store.open")} <i>‹</i></b></span>
              </Link>
              <Link href={`/vendor/${employeeWorkspace.vendor_id}/branches/${employeeWorkspace.branch_id}/stock`} className="employee-workspace-card" onClick={() => setEmployeeWorkspaceOpen(false)}>
                <span className="employee-workspace-card-icon"><ManagementTileIcon name="barcode" /></span>
                <strong>{t("store.ws.stock")}</strong>
                <p>{t("store.ws.stock_hint")}</p>
                <span className="employee-workspace-card-footer"><small>{t("store.ws.stock_footer")}</small><b>{t("store.open")} <i>‹</i></b></span>
              </Link>
              <Link href={`/vendor/${employeeWorkspace.vendor_id}/branches/${employeeWorkspace.branch_id}/returns`} className="employee-workspace-card" onClick={() => setEmployeeWorkspaceOpen(false)}>
                <span className="employee-workspace-card-icon"><ManagementTileIcon name="return" /></span>
                <strong>{t("store.ws.returns")}</strong>
                <p>{t("store.ws.returns_hint")}</p>
                <span className="employee-workspace-card-footer"><small>{t("store.ws.returns_footer")}</small><b>{t("store.open")} <i>‹</i></b></span>
              </Link>
              {cashierEnabled && (
                <button type="button" className="employee-workspace-card" onClick={openCashier} data-testid="employee-cashier-card">
                  <span className="employee-workspace-card-icon"><ManagementTileIcon name="barcode" /></span>
                  <strong>{t("pos.title")}</strong>
                  <p>{t("pos.tile.cashier_hint")}</p>
                  <span className="employee-workspace-card-footer"><small /><b>{t("store.open")} <i>‹</i></b></span>
                </button>
              )}
              {cashierEnabled && (
                <Link href={`/vendor/${employeeWorkspace.vendor_id}/store-sales`} className="employee-workspace-card" onClick={() => setEmployeeWorkspaceOpen(false)} data-testid="employee-store-sales-card">
                  <span className="employee-workspace-card-icon"><ManagementTileIcon name="document" /></span>
                  <strong>{t("pos.tile.sales")}</strong>
                  <p>{t("pos.tile.sales_hint")}</p>
                  <span className="employee-workspace-card-footer"><small /><b>{t("store.open")} <i>‹</i></b></span>
                </Link>
              )}
            </div>
          </section>
        </div>
      )}
      {appearanceDraft && ownerVendorId && (
        <div className="store-quick-edit-overlay" role="presentation" onClick={() => !appearanceSaving && setAppearanceDraft(null)}>
          <section className="store-quick-edit-dialog store-appearance-dialog" role="dialog" aria-modal="true" aria-labelledby="store-appearance-title" onClick={(event) => event.stopPropagation()}>
            <h2 id="store-appearance-title">{t("store.edit_panel")}</h2>
            <p>{t("store.appearance_hint")}</p>
            <StoreAppearanceEditor value={appearanceDraft} onChange={setAppearanceDraft} disabled={appearanceSaving} />
            <div className="store-quick-edit-actions">
              <button type="button" onClick={() => setAppearanceDraft(null)} disabled={appearanceSaving}>{t("store.cancel")}</button>
              <button type="button" onClick={() => saveAppearance(appearance)} disabled={appearanceSaving}>{appearanceSaving ? t("store.saving") : t("store.save")}</button>
            </div>
          </section>
        </div>
      )}
      {quickEdit && ownerVendorId && (
        <div className="store-quick-edit-overlay" role="presentation" onClick={() => !quickEditSaving && setQuickEdit(null)}>
          <section className="store-quick-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="store-quick-edit-title" onClick={(event) => event.stopPropagation()}>
            <h2 id="store-quick-edit-title">{fmt(t("store.edit_field"), { field: t(`store.qe.${quickEdit.field}`) })}</h2>
            <p>{t(`store.qe.${quickEdit.field}.help`)}</p>
            {(quickEdit.field === "logo_url" || quickEdit.field === "cover_image_url") && (
              <label className="store-quick-image-upload">
                {t("store.pick_image")}
                <input
                  type="file"
                  accept={IMAGE_UPLOAD_ACCEPT}
                  disabled={quickEditSaving}
                  onChange={(event) => setQuickEdit((current) => current ? { ...current, file: event.target.files?.[0] ?? null } : current)}
                />
                {quickEdit.file && <small>{fmt(t("store.picked"), { name: quickEdit.file.name })}</small>}
              </label>
            )}
            <label>
              {quickEdit.field === "logo_url" || quickEdit.field === "cover_image_url" ? t("store.or_paste_url") : t(`store.qe.${quickEdit.field}`)}
              {QUICK_EDIT_COPY[quickEdit.field].multiline ? (
                <textarea value={quickEdit.value} rows={4} autoFocus onChange={(event) => setQuickEdit((current) => current ? { ...current, value: event.target.value } : current)} />
              ) : (
                <input type={quickEdit.field === "logo_url" || quickEdit.field === "cover_image_url" ? "url" : "text"} value={quickEdit.value} autoFocus onChange={(event) => setQuickEdit((current) => current ? { ...current, value: event.target.value } : current)} />
              )}
            </label>
            {quickEdit.cover && (
              <StoreCoverControls look={quickEdit.cover} onChange={updateCoverDraft} disabled={quickEditSaving} />
            )}
            {quickEdit.text && (
              <HeroTextControls
                field={quickEdit.field as HeroTextField}
                style={quickEdit.text}
                disabled={quickEditSaving}
                onChange={(text) => setQuickEdit((current) => current ? { ...current, text } : current)}
              />
            )}
            <div className="store-quick-edit-actions">
              <button type="button" onClick={() => setQuickEdit(null)} disabled={quickEditSaving}>{t("store.cancel")}</button>
              <button type="button" onClick={saveQuickEdit} disabled={quickEditSaving}>{quickEditSaving ? t("store.saving") : t("store.save")}</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
