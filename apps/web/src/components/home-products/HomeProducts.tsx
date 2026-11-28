"use client";

import Link from "next/link";
import { Cormorant_Garamond, Inter, Noto_Naskh_Arabic } from "next/font/google";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import ProductCard from "@/components/ProductCard";
import ProductReelViewer from "@/components/ProductReelViewer";
import { apiFetch } from "@/lib/api";
import { pickText, refOf, useManagedSection } from "@/lib/contentStudio";
import { registerTranslations } from "@/lib/i18n";
import type { ComparisonCardDto } from "@/lib/types";
import { useLang, useT } from "@/lib/useLang";
import { useProductFavorites } from "@/lib/useProductFavorites";
import { useSessionToken } from "@/lib/useSession";
import { CURATED_PIECES, type CuratedPiece } from "./curatedPieces";
import { FOLLOWING_DEMO_PIECES } from "./followingDemo";
import { reelForPiece, type ProductReel } from "./productReels";
import "@/app/women/women.css";
import HomeSectionHead from "@/components/home-section-head/HomeSectionHead";
import styles from "./home-products.module.css";

// The hero's editorial faces (same next/font settings, so the same files).
const arDisplay = Noto_Naskh_Arabic({ subsets: ["arabic"], weight: ["400"], variable: "--hp-ar-display" });
const enDisplay = Cormorant_Garamond({ subsets: ["latin"], weight: ["500"], variable: "--hp-en-display", preload: false });
const enText = Inter({ subsets: ["latin"], weight: ["400", "500"], variable: "--hp-en-text" });
const FONT_VARS = [arDisplay.variable, enDisplay.variable, enText.variable].join(" ");

registerTranslations({
  ar: {
    "hp.title": "قطع تستاهل الاكتشاف",
    "hp.subtitle": "من محلات مختلفة، كلها بمكان واحد.",
    "hp.filters": "تصفية القطع",
    "hp.d.discover": "اكتشف", "hp.d.all": "الكل", "hp.d.for-you": "قد يعجبك", "hp.d.following": "أتابعه",
    "hp.d.new": "وصل حديثاً", "hp.d.trending": "الأكثر رواجاً", "hp.d.offers": "العروض",
    "hp.s.women": "نساء", "hp.s.men": "رجال", "hp.s.kids": "أطفال",
    "hp.s.accessories": "إكسسوارات", "hp.s.shoes": "أحذية", "hp.s.bags": "حقائب",
    "hp.more": "اكتشف المزيد",
    "hp.loading": "جارٍ التحميل…",
    "hp.empty": "لا توجد قطع تطابق هذا الاختيار حالياً.",
    "hp.error": "تعذّر تحميل القطع.",
    "hp.retry": "إعادة المحاولة",
    "hp.unavailable": "غير متوفر حالياً",
    "hp.forYouFallback": "لا توجد توصيات شخصية بعد - نعرض لك الأكثر رواجاً.",
    "hp.followingSignIn": "سجّل الدخول لرؤية قطع المتاجر التي تتابعها.",
    "hp.followingSignInCta": "تسجيل الدخول",
    "hp.followingNoScope": "تصفية قطع المتاجر التي تتابعها حسب الفئة غير متاحة بعد.",
    "hp.demo": "معاينة تجريبية",
    "hp.demoNote": "منتجات تجريبية من متاجر تجريبية، غير مرتبطة بأي حساب.",
    "hp.demoProduct": "منتج تجريبي",
  },
  en: {
    "hp.title": "Pieces Worth Discovering",
    "hp.subtitle": "From different stores, all in one place.",
    "hp.filters": "Filter pieces",
    "hp.d.discover": "Discover", "hp.d.all": "All", "hp.d.for-you": "For You", "hp.d.following": "Following",
    "hp.d.new": "New Arrivals", "hp.d.trending": "Trending", "hp.d.offers": "Offers",
    "hp.s.women": "Women", "hp.s.men": "Men", "hp.s.kids": "Kids",
    "hp.s.accessories": "Accessories", "hp.s.shoes": "Shoes", "hp.s.bags": "Bags",
    "hp.more": "Discover More",
    "hp.loading": "Loading…",
    "hp.empty": "No pieces match this selection right now.",
    "hp.error": "Couldn't load the pieces.",
    "hp.retry": "Retry",
    "hp.unavailable": "Not available yet",
    "hp.forYouFallback": "No personal recommendations yet - showing what's trending.",
    "hp.followingSignIn": "Sign in to see pieces from the stores you follow.",
    "hp.followingSignInCta": "Sign in",
    "hp.followingNoScope": "Filtering your followed stores' pieces by category isn't available yet.",
    "hp.demo": "Demo preview",
    "hp.demoNote": "Demo products from demo stores - not linked to any account.",
    "hp.demoProduct": "Demo product",
  },
});

/** Discovery (what to show) and scope (whose / what kind) are two
 *  independent choices on one bar: e.g. Offers + Women. Add options here. */
const DISCOVERY = ["discover", "all", "for-you", "following", "new", "trending", "offers"] as const;
const SCOPES = ["women", "men", "kids", "accessories", "shoes", "bags"] as const;
type Discovery = (typeof DISCOVERY)[number];
type Scope = (typeof SCOPES)[number];

/** Grid columns per viewport - the same tiers as .grid in
 *  home-products.module.css (change both together). Nothing here limits how
 *  many pieces exist: every batch is complete rows for the current tier -
 *  two rows, or three on the two-column phone layout. */
const COLUMN_TIERS = [
  { min: 1600, cols: 6 },
  { min: 1200, cols: 5 },
  { min: 900, cols: 4 },
  { min: 600, cols: 3 },
  { min: 0, cols: 2 },
] as const;
/** Discover and Following - one shopping grid: smaller cards, six per row
 *  from 1400px (as .grid[data-view="shop"] in home-products.module.css). */
const SHOP_COLUMN_TIERS = [
  { min: 1400, cols: 6 },
  { min: 1100, cols: 5 },
  { min: 900, cols: 4 },
  { min: 600, cols: 3 },
  { min: 0, cols: 2 },
] as const;
const rowsPerBatch = (cols: number) => (cols === 2 ? 3 : 2);
/** TEMPORARY: signed out, "Following" shows the labelled demo feed instead
 *  of asking to sign in. Set to false to bring the sign-in prompt back. */
const GUEST_FOLLOWING_DEMO = false;

/** The tabs that use the shopping grid above. */
const usesShopGrid = (d: Discovery) => d === "discover" || d === "following";

/** The demo preview of the Following tab: /?yourvia=demo (no sign-in needed;
 *  shows the labelled demo feed, never an account's data). */
const noopSubscribe = () => () => {};
const readDemoParam = () => new URLSearchParams(window.location.search).get("yourvia") === "demo";
const useDemoPreview = () => useSyncExternalStore(noopSubscribe, readDemoParam, () => false);

/** The API's per-request ceiling (discovery and following controllers). */
const MAX_PAGE_SIZE = 50;

const tierQuery = (min: number) => `(min-width: ${min}px)`;
type Tiers = readonly { min: number; cols: number }[];
/** A live column count for a set of tiers (one store per set, made once). */
function columnsStore(tiers: Tiers) {
  return {
    read: (): number => tiers.find((t) => window.matchMedia(tierQuery(t.min)).matches)?.cols ?? 2,
    subscribe: (onChange: () => void) => {
      const lists = tiers.map((t) => window.matchMedia(tierQuery(t.min)));
      lists.forEach((l) => l.addEventListener("change", onChange));
      return () => lists.forEach((l) => l.removeEventListener("change", onChange));
    },
  };
}
const DEFAULT_COLUMNS = columnsStore(COLUMN_TIERS);
const SHOP_COLUMNS = columnsStore(SHOP_COLUMN_TIERS);
/** Live column count; the server renders the four-column tier. */
const useColumns = (store: ReturnType<typeof columnsStore>) => useSyncExternalStore(store.subscribe, store.read, () => 4);

/** While more exist, only complete rows are shown; the remainder joins the next batch. */
const completeRows = (count: number, cols: number, more: boolean) =>
  more && count >= cols ? count - (count % cols) : count;

/** Real catalog query for a discovery mode + scope; null = not supported. */
function catalogPath(d: Discovery, scope: Scope | null, size: number, page: { cursor?: string | null; n?: number }): string | null {
  const p = new URLSearchParams({ page_size: String(size) });
  // Audience = the store segment; shoes / bags = the catalogue's own
  // category classification.
  if (scope === "shoes" || scope === "bags") p.set("category", scope);
  else if (scope) p.set("segment", scope);
  if (d === "following") {
    if (scope) return null;
    p.set("page", String(page.n ?? 1));
    return `/customers/me/following/feed?${p}`;
  }
  // Browse mode (cursor pages): newest, trending, discounted.
  if (d === "new") p.set("sort", "newest");
  // No recommendation service exists: "For You" falls back to trending,
  // and the section says so.
  if (d === "trending" || d === "for-you") p.set("filter", "trend");
  if (d === "offers") p.set("filter", "discounts");
  if (d === "all" && !p.has("category")) {
    p.set("page", String(page.n ?? 1));
  } else if (page.cursor) p.set("cursor", page.cursor);
  return `/discovery/all?${p}`;
}

interface CatalogPage {
  items: ComparisonCardDto[];
  total?: number;
  next_cursor?: string | null;
  page?: number;
}
/** `pageSize`: the size the query started with - numbered pages keep it so
 *  page n always starts where page n-1 ended. */
interface Loaded { items: ComparisonCardDto[]; cursor: string | null; page: number; pageSize: number; more: boolean }

/** A catalog page appended to what is already shown - never a duplicate. */
function merge(prev: Loaded | undefined, res: CatalogPage, pageSize: number): Loaded {
  const before = prev?.items ?? [];
  const seen = new Set(before.map((x) => x.canonical_product_id));
  const items = [...before, ...res.items.filter((x) => !seen.has(x.canonical_product_id))];
  const page = res.page ?? (prev?.page ?? 0) + 1;
  // Cursor pages say whether more exist; numbered pages give a total.
  const more = res.next_cursor !== undefined ? Boolean(res.next_cursor) : typeof res.total === "number" ? items.length < res.total : false;
  return { items, cursor: res.next_cursor ?? null, page, pageSize, more };
}

/** A curated piece as a women-page card: no VIA product yet - no price,
 *  stores, colours or sizes (as the Trending page's look pieces). */
function curatedCard(p: CuratedPiece, name: string): ComparisonCardDto {
  return {
    canonical_product_id: `curated-${p.id}`,
    canonical_name_ar: name,
    canonical_name_en: "",
    lowest_price: "",
    lowest_price_availability: "available",
    image_url: p.image.src,
    brand_name: null,
    category_name: null,
    store_count: 0,
    colors: [],
    sizes: [],
    cheapest_offer: { vendor_id: "", vendor_slug: p.pick?.vendorSlug ?? "", offer_id: p.pick?.offerId ?? "", offer_variant_id: "" },
    store_logos: [],
  };
}

function matchesScope(p: CuratedPiece, scope: Scope | null): boolean {
  if (!scope) return true;
  if (scope === "women" || scope === "men" || scope === "kids") return p.audience === scope;
  return p.category === scope;
}

export default function HomeProducts() {
  const lang = useLang();
  const t = useT();
  const token = useSessionToken();
  const favorites = useProductFavorites("/");
  // The tab the visitor picked; until then the preview link (/?yourvia=demo)
  // opens on "Following", every other visit on "Discover".
  const demoPreview = useDemoPreview();
  const [pickedDiscovery, setDiscovery] = useState<Discovery | null>(null);
  const discovery: Discovery = pickedDiscovery ?? (demoPreview ? "following" : "discover");
  const [scope, setScope] = useState<Scope | null>(null);
  const defaultCols = useColumns(DEFAULT_COLUMNS);
  const shopCols = useColumns(SHOP_COLUMNS);
  const shopGrid = usesShopGrid(discovery);
  const cols = shopGrid ? shopCols : defaultCols;
  // A product with its own reel (productReels.ts), while its viewer is open.
  const [openReel, setOpenReel] = useState<{ reel: ProductReel; name: string } | null>(null);
  const closeReel = useCallback(() => setOpenReel(null), []);
  const batch = cols * rowsPerBatch(cols);
  // Curated pieces revealed so far; null = the first batch for the current tier.
  const [shown, setShown] = useState<number | null>(null);
  // Real products behind curated pieces that have a canonical id.
  const [mapped, setMapped] = useState<Record<string, ComparisonCardDto | null>>({});
  // Catalog results per query (discovery + scope), kept so switching back
  // and forth never re-requests.
  const [catalog, setCatalog] = useState<Record<string, Loaded>>({});
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const key = `${discovery}|${scope ?? ""}`;
  const isCurated = discovery === "discover";
  // "Following" shows the labelled demo feed (followingDemo.ts) in the demo
  // preview (/?yourvia=demo) and, for now (GUEST_FOLLOWING_DEMO), to anyone
  // signed out - instead of the sign-in prompt. Signed in: the real feed.
  const demoFollowing = discovery === "following" && (demoPreview || (GUEST_FOLLOWING_DEMO && !token));
  const isDemoFeed = demoFollowing && !scope;
  const firstPath = isCurated || demoFollowing ? null : catalogPath(discovery, scope, batch, {});
  const needsSignIn = discovery === "following" && !token && !demoFollowing;
  const unsupported = !isCurated && !isDemoFeed && !needsSignIn && firstPath === null;

  useEffect(() => {
    let cancelled = false;
    for (const p of CURATED_PIECES) {
      const id = p.canonicalProductId;
      if (!id) continue;
      apiFetch<ComparisonCardDto>(`/canonical-products/${encodeURIComponent(id)}/comparison-card`, { auth: false })
        .then((card) => !cancelled && setMapped((m) => ({ ...m, [p.id]: card })))
        .catch(() => !cancelled && setMapped((m) => ({ ...m, [p.id]: null })));
    }
    return () => {
      cancelled = true;
    };
  }, []);

  // First page of a catalog mode, once per discovery + scope (kept after,
  // so switching back never re-requests); a retry clears the error.
  const hasPage = Boolean(catalog[key]);
  useEffect(() => {
    if (isCurated || needsSignIn || !firstPath || hasPage || errorKey === key) return;
    let cancelled = false;
    apiFetch<CatalogPage>(firstPath, { auth: discovery === "following" })
      .then((res) => !cancelled && setCatalog((c) => ({ ...c, [key]: merge(undefined, res, batch) })))
      .catch(() => !cancelled && setErrorKey(key));
    return () => {
      cancelled = true;
    };
  }, [key, firstPath, isCurated, needsSignIn, hasPage, errorKey, discovery, batch]);

  // VIA phase 6: Editorial Product Picks from the Content Studio replace the
  // built-in curated pieces of the Discover tab (same cards); a pick whose
  // product is no longer public is dropped by the server.
  const picks = useManagedSection("home.picks");
  const curated = useMemo(() => {
    if (picks.mode === "hidden") return [];
    if (picks.mode === "managed" && picks.section.items.length > 0) {
      return picks.section.items.flatMap((it): CuratedPiece[] => {
        const ref = refOf(it.fields.product);
        if (!ref) return [];
        const m = /^\/store\/([^/]+)\/products\/([^/?#]+)/.exec(ref.href ?? "");
        return [
          {
            ...CURATED_PIECES[0],
            id: it.id,
            name: { ar: ref.title?.ar ?? "", en: ref.title?.en ?? ref.title?.ar ?? "" },
            image: { ...CURATED_PIECES[0].image, src: ref.image_url ?? CURATED_PIECES[0].image.src },
            canonicalProductId: null,
            pick: m ? { vendorSlug: m[1], offerId: m[2] } : undefined,
          } as CuratedPiece,
        ];
      });
    }
    return CURATED_PIECES.filter((p) => matchesScope(p, scope));
  }, [scope, picks]);
  const curatedLimit = shown ?? batch;
  const curatedMore = curated.length > curatedLimit;
  const curatedVisible = curated.slice(0, completeRows(Math.min(curatedLimit, curated.length), cols, curatedMore));
  const loaded = catalog[key];
  const catalogVisible = loaded ? loaded.items.slice(0, completeRows(loaded.items.length, cols, loaded.more)) : [];
  // The Following demo feed (newest first), revealed like Discover.
  const demoMore = FOLLOWING_DEMO_PIECES.length > curatedLimit;
  const demoVisible = isDemoFeed
    ? FOLLOWING_DEMO_PIECES.slice(0, completeRows(Math.min(curatedLimit, FOLLOWING_DEMO_PIECES.length), cols, demoMore))
    : [];
  const hasMore = isCurated ? curatedMore : isDemoFeed ? demoMore : Boolean(loaded?.more);

  function pick(next: { discovery?: Discovery; scope?: Scope | null }) {
    if (next.discovery !== undefined) setDiscovery(next.discovery);
    if (next.scope !== undefined) setScope(next.scope);
    setShown(null); // a new selection starts from its first batch
    setErrorKey(null);
  }

  /** The next batch: complete rows for the current column count, appended. */
  async function more() {
    if (isCurated) return setShown(curatedVisible.length + batch);
    if (isDemoFeed) return setShown(demoVisible.length + batch);
    if (!loaded || loadingKey === key) return;
    const k = key;
    const target = catalogVisible.length + batch;
    setLoadingKey(k);
    try {
      let state = loaded;
      while (state.more && state.items.length < target) {
        // Cursor pages ask for exactly what is missing; numbered pages keep
        // their size and may take a second page to fill the last row.
        const size = state.cursor ? Math.min(target - state.items.length, MAX_PAGE_SIZE) : state.pageSize;
        const path = catalogPath(discovery, scope, size, { cursor: state.cursor, n: state.page + 1 });
        if (!path) break;
        const res = await apiFetch<CatalogPage>(path, { auth: discovery === "following" });
        const next = merge(state, res, state.pageSize);
        setCatalog((c) => ({ ...c, [k]: next }));
        if (next.items.length === state.items.length) break; // nothing new: never loop
        state = next;
      }
    } catch {
      // The button stays: another click retries.
    } finally {
      setLoadingKey((l) => (l === k ? null : l));
    }
  }

  const cardFor = (card: ComparisonCardDto, reelAction?: { label: string; onOpen: () => void }) => (
    <div key={card.canonical_product_id} className={styles.item}>
      <ProductCard
        card={card}
        presentation="women"
        favorited={favorites.favoriteIds.has(card.canonical_product_id)}
        favoritePending={favorites.favoritesLoading || favorites.favoritePendingIds.has(card.canonical_product_id)}
        onToggleFavorite={favorites.onToggleFavorite}
        reelAction={reelAction}
      />
    </div>
  );

  /** A demo piece, the same in Discover and Following: its real product once
   *  mapped, else shown whole on its own background - and its reel action
   *  only if productReels.ts gives it a reel. */
  const pieceItem = (p: CuratedPiece, unavailableLabel: string) => {
    const reel = reelForPiece(p.id);
    const name = p.name[lang];
    const reelAction = reel ? { label: t("productReel.watch"), onOpen: () => setOpenReel({ reel, name }) } : undefined;
    const real = p.canonicalProductId ? mapped[p.id] : null;
    if (real) return cardFor(real, reelAction);
    return (
      <div className={styles.item} data-fit="contain" style={{ "--media-bg": p.background } as CSSProperties}>
        <ProductCard card={curatedCard(p, name)} presentation="women" unavailableLabel={unavailableLabel} reelAction={reelAction} />
      </div>
    );
  };

  let body: ReactNode;
  if (isDemoFeed) {
    body = demoVisible.length ? (
      <ul className={styles.grid} data-view="shop">
        {demoVisible.map((p) => <li key={p.id}>{pieceItem(p, t("hp.demoProduct"))}</li>)}
      </ul>
    ) : (
      <p className={styles.note}>{t("hp.empty")}</p>
    );
  } else if (needsSignIn) {
    body = (
      <p className={styles.note}>
        {t("hp.followingSignIn")} <Link href="/login?next=/">{t("hp.followingSignInCta")}</Link>
      </p>
    );
  } else if (unsupported) {
    body = <p className={styles.note}>{t("hp.followingNoScope")}</p>;
  } else if (isCurated) {
    body = curatedVisible.length ? (
      <ul className={styles.grid} data-view="shop">
        {curatedVisible.map((p) => <li key={p.id}>{pieceItem(p, t("hp.unavailable"))}</li>)}
      </ul>
    ) : (
      <p className={styles.note}>{t("hp.empty")}</p>
    );
  } else if (errorKey === key && !loaded) {
    body = (
      <p className={styles.note}>
        {t("hp.error")}{" "}
        <button type="button" className={styles.textButton} onClick={() => setErrorKey(null)}>{t("hp.retry")}</button>
      </p>
    );
  } else if (!loaded) {
    body = <p className={styles.note} aria-live="polite">{t("hp.loading")}</p>;
  } else {
    body = catalogVisible.length ? (
      <ul className={styles.grid} data-view={shopGrid ? "shop" : undefined}>{catalogVisible.map((c) => <li key={c.canonical_product_id}>{cardFor(c)}</li>)}</ul>
    ) : (
      <p className={styles.note}>{t("hp.empty")}</p>
    );
  }

  return (
    <section className={`${styles.root} ${FONT_VARS}`} data-lang={lang} dir={lang === "ar" ? "rtl" : "ltr"} aria-labelledby="home-products-title">
      <HomeSectionHead
        id="home-products-title"
        title={picks.mode === "managed" ? pickText(picks.section.fields.heading, lang, t("hp.title")) : t("hp.title")}
        aside={t("hp.subtitle")}
      />

      {/* One line: what to show | whose / what kind (independent choices). */}
      <div className={styles.bar} role="toolbar" aria-label={t("hp.filters")}>
        <div className={styles.group}>
          {DISCOVERY.map((d) => (
            <button key={d} type="button" className={styles.tab} aria-pressed={discovery === d} onClick={() => pick({ discovery: d })}>
              {t(`hp.d.${d}`)}
            </button>
          ))}
        </div>
        <span className={styles.sep} aria-hidden="true" />
        <div className={styles.group}>
          {SCOPES.map((s) => (
            <button key={s} type="button" className={styles.tab} aria-pressed={scope === s} onClick={() => pick({ scope: scope === s ? null : s })}>
              {t(`hp.s.${s}`)}
            </button>
          ))}
        </div>
      </div>

      {discovery === "for-you" && !needsSignIn && <p className={styles.fallback}>{t("hp.forYouFallback")}</p>}
      {isDemoFeed && (
        <p className={`${styles.fallback} ${styles.demoNote}`}>
          <span className={styles.demoBadge}>{t("hp.demo")}</span>
          <span>{t("hp.demoNote")}</span>
        </p>
      )}

      <div className={`women-page ${styles.cards}`}>{body}</div>

      {hasMore && !needsSignIn && !unsupported && (
        <div className={styles.moreRow}>
          <button type="button" className={styles.more} onClick={() => void more()} disabled={loadingKey === key}>
            {loadingKey === key ? t("hp.loading") : t("hp.more")}
          </button>
        </div>
      )}

      {openReel && (
        <ProductReelViewer
          video={openReel.reel.video}
          width={openReel.reel.width}
          height={openReel.reel.height}
          poster={openReel.reel.poster}
          name={openReel.name}
          onClose={closeReel}
        />
      )}
    </section>
  );
}
