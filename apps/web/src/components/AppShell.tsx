"use client";

import "@/lib/branchesText";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { FormEvent, ReactNode, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  BagIcon,
  BellIcon,
  CartIcon,
  CloseIcon,
  CompassIcon,
  HeartIcon,
  HomeIcon,
  MenuIcon,
  SearchIcon,
  SupportIcon,
  UserIcon,
} from "./Icons";
import {
  NavLink,
  desktopLinks,
  isActivePath,
  mobileTabs,
  workspaceEntry,
} from "@/lib/nav";
import { signOutToLogin } from "@/lib/auth";
import { loginHref } from "@/lib/loginRedirect";
import { recordRoute } from "@/lib/navTrail";
import { reportFrameState, startManageFrame } from "@/lib/manageFrame";
import "@/lib/storePosText";
import "@/lib/offerWizardText";
import "@/lib/collectionsText";
import "@/lib/storeHomeText";
import "@/lib/performanceText";
import {
  useCartCount,
  useHydrated,
  useSessionToken,
  useUnreadNotificationCount,
  useWorkspaces,
} from "@/lib/useSession";
import {
  WORKSPACE_EVENT,
  WORKSPACE_REQUIRED_EVENT,
  forgetWorkspace,
  hasWorkspace,
  notificationsPagePath,
  workspaceEntryHref,
  workspaceOfPage,
  workspaceSnapshot,
  type WorkspaceRef,
} from "@/lib/workspaceSession";
import "@/lib/workspaceText";
import { enterWorkspaceNow } from "@/lib/workspaceActions";
import { newIdempotencyKey, apiFetch } from "@/lib/api";
import { Lang, setLang } from "@/lib/i18n";
import { useLang, useSyncServerLanguagePref, useT } from "@/lib/useLang";
import LangEffect from "./LangEffect";
import Toaster from "./Toaster";
import NotificationsPanel from "./NotificationsPanel";
import homeStyles from "./via-header.module.css";

const TAB_ICONS: Record<NavLink["key"], ReactNode> = {
  home: <HomeIcon />,
  discover: <CompassIcon />,
  cart: <CartIcon />,
  orders: <BagIcon />,
  following: <HeartIcon />,
  account: <UserIcon />,
};

// Sprint 22: AppShell's own nav labels, independent of nav.ts's
// desktopLinks()/mobileTabs() output (which also feeds the pre-S22
// /account page's workspace switcher via workspaceEntry() - that
// output is left untouched/Arabic-only by design, see this file's own
// i18n comment below). Keyed by NavLink["key"] so both the desktop
// header and the bottom tab bar share one source.
const NAV_LABELS: Record<Lang, Record<NavLink["key"], string>> = {
  ar: { home: "الرئيسية", discover: "اكتشف", cart: "السلة", orders: "طلباتي", following: "أتابعه", account: "حسابي" },
  en: { home: "Home", discover: "Discover", cart: "Cart", orders: "Orders", following: "Following", account: "Account" },
};

// These own a full-bleed design (background photo, glass card) with
// no navigation of their own - AppShell renders bare on them, see the
// pathname check below.
const AUTH_PAGE_PATHS = new Set(["/login", "/register", "/reset-password", "/reactivate", "/join-team"]);

// The Via header's main links, in RTL reading order. A null href is a
// section that is not built yet - it is shown, but not clickable.
const VIA_NAV: { label: string; href: string | null }[] = [
  { label: "الرئيسية", href: "/" },
  { label: "نساء", href: "/women" },
  { label: "رجال", href: "/men" },
  { label: "أطفال", href: "/kids" },
  { label: "الترند", href: "/trending" },
  { label: "الإعلانات", href: "/ads" },
  { label: "عن VIA", href: null },
];

// The header settles into a light, sticky bar once the page moves.
const subscribeToScroll = (onChange: () => void) => {
  window.addEventListener("scroll", onChange, { passive: true });
  return () => window.removeEventListener("scroll", onChange);
};
const readHeaderScrolled = () => window.scrollY > 24;

// Sprint 13: the one app shell every page renders inside - a sticky
// header on desktop (logo, search, main links, account/workspace menu)
// and a bottom navigation on mobile. Pure presentation: it only reads
// the session to decide what to SHOW; backend authorization is the
// real protection for every route it links to.
// `?embed=management|account` (the owner's management modal and the
// account modal load pages in an iframe). Read from the browser's own
// URL, not useSearchParams(), so the shell never forces every static
// page out of prerendering: the server (and hydration) render the
// normal shell, the client then switches. Until hydration, the inline
// EMBED_BOOT_SCRIPT (root layout) has already marked <html data-embed>
// and CSS hides the shell chrome, so the iframe never flashes a header.
// The value never changes without a full load (it is fixed per iframe).
const subscribeToLocation = (onChange: () => void) => {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
};
const readEmbedMode = () => new URLSearchParams(window.location.search).get("embed");
function useEmbedMode(): string | null {
  return useSyncExternalStore(subscribeToLocation, readEmbedMode, () => null);
}

/**
 * The tab's route trail (lib/navTrail.ts): what "back to where you came
 * from" arrows (e.g. on /compare/:id) return to. The one part of the
 * shell that needs the live query string - isolated here, inside its
 * own invisible Suspense boundary, so useSearchParams() never makes the
 * whole shell (and with it every static page) client-only.
 */
function RouteTrailRecorder() {
  const pathname = usePathname();
  const routeQuery = useSearchParams().toString();
  useEffect(() => {
    recordRoute(routeQuery ? `${pathname}?${routeQuery}` : pathname);
  }, [pathname, routeQuery]);
  return null;
}

function subscribeWorkspaces(onChange: () => void): () => void {
  window.addEventListener(WORKSPACE_EVENT, onChange);
  return () => window.removeEventListener(WORKSPACE_EVENT, onChange);
}

function currentUrl(): string {
  return `${window.location.pathname}${window.location.search}`;
}

export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const embedMode = useEmbedMode();
  const isManagementEmbed = embedMode === "management";
  const isAccountEmbed = embedMode === "account";
  const isHomePage = pathname === "/";
  // The trend page uses the same campaign header as the homepage.
  const isTrendPage = pathname === "/trending";
  // The ads page shows the homepage header as it is on the homepage (over
  // its full-bleed campaign hero).
  const isAdsPage = pathname === "/ads";
  const usesTrendChrome = isTrendPage;
  const isViaExperience = isHomePage || pathname === "/women" || pathname === "/kids" || pathname === "/men" || isTrendPage || isAdsPage;
  const isShoppingProfilePage = pathname === "/profile";
  const isNotificationsPage = pathname === "/notifications";
  const isCartPage = pathname === "/cart";
  // The shopping profile belongs to the Via browsing experience, so it uses
  // the same refined public header rather than the legacy platform bar.
  const usesViaHeader = isViaExperience || isShoppingProfilePage || isNotificationsPage || isCartPage;
  // Store pages carry their own identity bar (logo, name, icon), so the
  // platform header is not rendered on top of them.
  // 2026-11-24: the old owner hub address /vendor/<id> only redirects to the
  // store page - it shows the store page's own skeleton, never the legacy bar.
  const isStorePage = pathname.startsWith("/store/") || /^\/vendor\/[^/]+\/?$/.test(pathname);
  const isComparisonPage = pathname.startsWith("/compare/");
  const isAccountPage = pathname === "/account";
  const isFavoritesPage = pathname === "/account/favorites";
  // Branch operation pages already have their focused, role-scoped tools.
  // They intentionally omit the customer-facing global navigation bar.
  const isEmployeeWorkspacePage = /^\/vendor\/[^/]+\/branches\/[^/]+(?:\/|$)/.test(pathname);
  const isWomenPage = pathname === "/women";
  const isKidsPage = pathname === "/kids";
  const isMenPage = pathname === "/men";
  const router = useRouter();
  const tFrame = useT();
  // Inside the store's management frame: the frame's header shows each screen's title and «رجوع» (lib/manageFrame.ts).
  useEffect(() => {
    startManageFrame((path) => {
      if (/^\/vendor\/[^/]+\/offers\/new\/?$/.test(path)) return tFrame("wz.start.drafts");
      if (/^\/vendor\/[^/]+\/offers\/import\/?$/.test(path)) return tFrame("panel.import");
      if (/^\/vendor\/[^/]+\/offers\/[^/]+\/details\/?$/.test(path)) return tFrame("panel.details");
      if (/^\/vendor\/[^/]+\/notifications\/?$/.test(path)) return tFrame("store.inbox");
      if (/^\/vendor\/[^/]+\/branches\/?$/.test(path)) return tFrame("br.title");
      if (/^\/vendor\/[^/]+\/branches\/new\/?$/.test(path)) return tFrame("br.add");
      if (/^\/vendor\/[^/]+\/branches\/[^/]+\/settings\/?$/.test(path)) return tFrame("br.settings.title");
      if (/^\/vendor\/[^/]+\/settings\/?$/.test(path)) return tFrame("br.store_settings");
      // a branch and each of its tabs: one screen, «إدارة الفروع» (the branch header says which branch and tab)
      if (/^\/vendor\/[^/]+\/branches\/[^/]+(?:\/[a-z-]+)?\/?$/.test(path)) return tFrame("br.title");
      if (/^\/vendor\/[^/]+\/cashier\/?$/.test(path)) return tFrame("pos.title");
      if (/^\/vendor\/[^/]+\/store-sales\/?$/.test(path)) return tFrame("pos.sales.title");
      if (/^\/vendor\/[^/]+\/labels\/?$/.test(path)) return tFrame("pos.labels.title");
      if (/^\/vendor\/[^/]+\/storefront\/home\/?$/.test(path)) return tFrame("home.title");
      // «صفحتي» (the store page's identity; «رجوع» from the designer names it)
      if (/^\/vendor\/[^/]+\/storefront\/?$/.test(path)) return tFrame("mypage.title");
      // «أداء المتجر» (labels and the cashier opened from its tools say «رجوع إلى أداء المتجر»)
      if (/^\/vendor\/[^/]+\/performance\/?$/.test(path)) return tFrame("pf.title");
      // opened from «صفحتي» › «حالة المتجر» (its «رجوع» returns there)
      if (/^\/vendor\/[^/]+\/verification\/?$/.test(path)) return tFrame("mystatus.verify_title");
      return null;
    }, (href) => router.push(href), (a, b) => {
      // «إدارة الفروع»: the branches, each branch and its tabs are views of one screen - no «رجوع» between them
      // («إضافة فرع» and «إعدادات الفرع» are screens opened from it: they get «رجوع»)
      const view = /^(\/vendor\/[^/]+\/branches)(?:\/(?!new\/?$)[^/]+(?:\/(?!settings\/?$)[a-z-]+)?)?\/?$/;
      const x = view.exec(a);
      const y = view.exec(b);
      return Boolean(x && y && x[1] === y[1]);
    });
    reportFrameState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);
  const token = useSessionToken();
  const workspaces = useWorkspaces(token);
  const hydrated = useHydrated();
  // TB-26: the workspace this PAGE belongs to (a /vendor/<id> or /admin
  // page), and whether this tab has entered it. Signing in is shopping
  // only: a workspace page without an entered workspace goes to the entry
  // confirmation - never entered on its own.
  const pageWorkspace = workspaceOfPage(pathname);
  const pageWorkspaceKey = pageWorkspace
    ? pageWorkspace.type === "platform" ? "platform" : `vendor:${pageWorkspace.vendor_id}`
    : "";
  const wsSnapshot = useSyncExternalStore(subscribeWorkspaces, workspaceSnapshot, () => "");
  const inPageWorkspace = Boolean(pageWorkspace && hydrated && wsSnapshot && hasWorkspace(pageWorkspace));
  const cartCount = useCartCount(token, pathname);
  const unreadCount = useUnreadNotificationCount(token, pathname);
  const lang = useLang();
  const t = useT();
  useSyncServerLanguagePref(token);
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [homeSearchOpen, setHomeSearchOpen] = useState(false);
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const [notificationsPanelOpen, setNotificationsPanelOpen] = useState(false);
  // TB-4: a stable callback - the panel's fetch effect depends on it, so a
  // new function on every shell render would re-send its request.
  const closeNotificationsPanel = useCallback(() => setNotificationsPanelOpen(false), []);
  const menuRef = useRef<HTMLDivElement>(null);
  /** Visual pass: the workspace's own small menu in the header (no strip over every page). */
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  const wsMenuRef = useRef<HTMLDivElement>(null);
  const homeSearchInputRef = useRef<HTMLInputElement>(null);
  const homeHeaderRef = useRef<HTMLElement>(null);
  // The Via header: its collapsed (tablet/phone) link menu, and whether the
  // page has moved (the header then settles into a light, sticky bar).
  const [homeNavOpen, setHomeNavOpen] = useState(false);
  const headerScrolled = useSyncExternalStore(subscribeToScroll, readHeaderScrolled, () => false);

  // The collapsed navigation menu closes on an outside tap or Escape.
  useEffect(() => {
    if (!homeNavOpen) return;
    function onPointer(e: PointerEvent) {
      if (homeHeaderRef.current && !homeHeaderRef.current.contains(e.target as Node)) {
        setHomeNavOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setHomeNavOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [homeNavOpen]);

  useEffect(() => {
    if (!homeSearchOpen) return;
    const frame = window.requestAnimationFrame(() => homeSearchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [homeSearchOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!wsMenuOpen) return;
    function onClick(e: MouseEvent) {
      if (wsMenuRef.current && !wsMenuRef.current.contains(e.target as Node)) setWsMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setWsMenuOpen(false);
        (wsMenuRef.current?.querySelector("button") as HTMLButtonElement | null)?.focus();
      }
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [wsMenuOpen]);

  // Account details stay in context: open them above the current page
  // instead of taking the customer away from wherever they were browsing.
  useEffect(() => {
    if (!accountModalOpen) return;
    const previousOverflow = document.body.style.overflow;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAccountModalOpen(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [accountModalOpen]);

  useEffect(() => {
    const onAccountOverlayMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === "close-account-overlay") setAccountModalOpen(false);
    };
    window.addEventListener("message", onAccountOverlayMessage);
    return () => window.removeEventListener("message", onAccountOverlayMessage);
  }, []);

  useEffect(() => {
    const openAccountOverlay = () => setAccountModalOpen(true);
    window.addEventListener("open-account-overlay", openAccountOverlay);
    return () => window.removeEventListener("open-account-overlay", openAccountOverlay);
  }, []);

  function onSearch(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    router.push(q ? `/discovery?q=${encodeURIComponent(q)}` : "/discovery");
  }

  // The search icon focuses (or, on small screens, opens) the field; with
  // text in it, it searches.
  function onHomeSearchButton() {
    if (query.trim()) {
      homeSearchInputRef.current?.form?.requestSubmit();
      return;
    }
    setHomeNavOpen(false);
    setHomeSearchOpen(true);
    homeSearchInputRef.current?.focus();
  }

  function renderViaNav(className: string) {
    return VIA_NAV.map(({ label, href }) => {
      if (!href) {
        return (
          <span key={label} className={`${className} ${homeStyles.navPending}`} aria-disabled="true" title={t("appshell.soon")}>
            {label}
          </span>
        );
      }
      const current = pathname === href;
      return (
        <Link
          key={label}
          href={href}
          className={`${className}${current ? ` ${homeStyles.navCurrent}` : ""}`}
          aria-current={current ? "page" : undefined}
          onClick={() => setHomeNavOpen(false)}
        >
          {label}
        </Link>
      );
    });
  }

  // TB-26: choosing a workspace in the account menu IS the explicit step -
  // it enters at once and opens the workspace's home (if entering fails,
  // the entry page shows why). Shopping simply goes home.
  async function switchTo(index: number) {
    if (!workspaces) return;
    const w = workspaces[index];
    const entry = workspaceEntry(w);
    if (entry.disabled) return;
    setMenuOpen(false);
    if (w.type === "customer") {
      router.push("/");
      return;
    }
    const ref = w.type === "platform" ? ({ type: "platform" } as const) : ({ type: "vendor", vendor_id: w.vendor_id } as const);
    try {
      await enterWorkspaceNow(ref);
      router.push(entry.href);
    } catch {
      router.push(workspaceEntryHref(ref, entry.href));
    }
  }

  // Set while leaving, so the gate below does not send the page being
  // left to the entry confirmation before the navigation home lands.
  const leavingRef = useRef(false);
  // The session is checked FIRST: the entry confirmation is only for a
  // still-valid session, so the gate waits until the workspaces read has
  // answered (`workspaces` stays null while it is in flight). A 401 there
  // clears the session instead (useWorkspacesResult), the token goes and
  // the page itself sends to sign-in with `next` = this very page - never
  // to sign-in by way of the confirmation, whichever answer comes first.
  // Any other failure (429, 5xx) is not a lost session: the entry page
  // says so in its own words.
  const sessionChecked = workspaces !== null;
  useEffect(() => {
    if (!pageWorkspace) leavingRef.current = false;
    if (!hydrated || !token || !sessionChecked || !pageWorkspace || inPageWorkspace || leavingRef.current) return;
    router.replace(workspaceEntryHref(pageWorkspace, currentUrl()));
    // pageWorkspaceKey stands for pageWorkspace (a new object each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, token, sessionChecked, pageWorkspaceKey, inPageWorkspace, router]);

  useEffect(() => {
    const onRequired = (event: Event) => {
      const ref = (event as CustomEvent<WorkspaceRef>).detail;
      // A late answer from the page just left must not replace the
      // confirmation (and its `next`) with a confirmation of itself.
      if (!ref || window.location.pathname.startsWith("/workspaces/")) return;
      router.replace(workspaceEntryHref(ref, currentUrl()));
    };
    window.addEventListener(WORKSPACE_REQUIRED_EVENT, onRequired);
    return () => window.removeEventListener(WORKSPACE_REQUIRED_EVENT, onRequired);
  }, [router]);

  async function leaveWorkspace() {
    if (!pageWorkspace) return;
    const ref = pageWorkspace;
    leavingRef.current = true;
    try {
      await apiFetch("/me/workspace-sessions/current", { method: "DELETE", workspace: ref });
    } catch {
      // Leaving locally is what matters; the token also expires by itself.
    }
    forgetWorkspace(ref);
    router.push("/");
  }

  async function signOut() {
    setMenuOpen(false);
    setAccountModalOpen(false);
    // the full sign-in page of the site (closes every window around it)
    await signOutToLogin();
  }

  /**
   * The person icon (2026-11-24): a shopping-only account goes straight to
   * its personal page; an owner, a branch employee or platform staff (more
   * than one context) gets the workspace chooser; signed out -> the full
   * sign-in page. While the account's contexts are still loading the chooser
   * is the safe answer (it shows the personal page's entry too).
   */
  function openAccount() {
    setMenuOpen(false);
    if (!token) {
      router.push(loginHref(currentUrl()));
      return;
    }
    if (workspaces !== null && workspaces.every((w) => w.type === "customer")) {
      setAccountModalOpen(false);
      router.push("/profile");
      return;
    }
    setAccountModalOpen(true);
  }

  function toggleLanguage() {
    const next: Lang = lang === "ar" ? "en" : "ar";
    setLang(next);
    if (token) {
      // Best-effort: the UI has already switched locally regardless of
      // whether this write succeeds - same resilience as every other
      // "local state is the source of truth, the server call is a
      // persistence side-effect" pattern in this codebase.
      apiFetch("/customers/me", {
        method: "PATCH",
        body: { language_pref: next },
        idempotencyKey: newIdempotencyKey("lang-pref"),
      }).catch(() => {});
    }
  }

  // TB-26: the active context is the page's own (per tab), not a stored choice.
  const isActiveWorkspace = (i: number) => {
    if (!workspaces) return false;
    const w = workspaces[i];
    if (w.type === "customer") return !pageWorkspace;
    if (w.type === "platform") return pageWorkspace?.type === "platform";
    return pageWorkspace?.type === "vendor" && pageWorkspace.vendor_id === w.vendor_id;
  };

  // TB-26: a workspace page is not rendered at all - none of its code,
  // none of its API calls - until this tab has entered that workspace (the
  // gate above sends it to the confirmation). Signed-out visitors still
  // get the page itself, which sends them to sign in.
  const pageContent =
    pageWorkspace && (!hydrated || (token && !inPageWorkspace)) ? (
      <div className="page-shell" aria-busy="true">
        <div className="skeleton" style={{ height: 96, width: "100%", maxWidth: 720 }} />
      </div>
    ) : (
      children
    );

  // Visual pass: the workspace is shown by one compact button in the header
  // (its name), whose menu holds «خروج من مساحة العمل» and the workspace's
  // notifications - no strip over every page's content. Same leaveWorkspace,
  // same notifications path; nothing about the workspace itself changes.
  const workspaceLabel = pageWorkspace ? t(pageWorkspace.type === "platform" ? "ws.bar.platform" : "ws.bar.vendor") : "";
  const workspaceName =
    pageWorkspace?.type === "vendor" && workspaces
      ? (() => {
          const m = workspaces.find((w) => w.type === "vendor" && w.vendor_id === pageWorkspace.vendor_id);
          return m && m.type === "vendor" ? m.vendor_legal_name : "";
        })()
      : "";
  const workspaceMenu =
    pageWorkspace && inPageWorkspace && !isManagementEmbed && !isAccountEmbed ? (
      <div className="workspace-menu" ref={wsMenuRef} data-testid="workspace-bar">
        <button
          type="button"
          className="workspace-menu-button"
          aria-haspopup="true"
          aria-expanded={wsMenuOpen}
          aria-controls="workspace-menu-panel"
          aria-label={t("ws.menu.aria").replace("{name}", workspaceName || workspaceLabel)}
          title={workspaceName ? `${workspaceLabel} - ${workspaceName}` : workspaceLabel}
          onClick={() => setWsMenuOpen((v) => !v)}
          data-testid="workspace-menu-button"
        >
          <WorkspaceIcon />
          <span className="workspace-menu-name">{workspaceName || workspaceLabel}</span>
          <span className="workspace-menu-caret" aria-hidden="true">▾</span>
        </button>
        <div className="workspace-menu-panel" id="workspace-menu-panel" hidden={!wsMenuOpen}>
          <div className="workspace-menu-title">
            {workspaceLabel}
            {workspaceName && <strong>{workspaceName}</strong>}
          </div>
          <Link href={notificationsPagePath(pathname)} className="workspace-menu-item" onClick={() => setWsMenuOpen(false)} data-testid="workspace-bar-notifications">
            <BellIcon />
            <span>{t("appshell.notifications_aria")}</span>
            {unreadCount > 0 && <span className="badge-count">{unreadCount}</span>}
          </Link>
          <button type="button" className="workspace-menu-item workspace-menu-leave" onClick={() => void leaveWorkspace()} aria-label={t("ws.leave.aria")} data-testid="workspace-leave">
            <LeaveIcon />
            <span>{t("ws.leave")}</span>
          </button>
        </div>
      </div>
    ) : null;

  const links = desktopLinks();
  const tabs = mobileTabs(Boolean(token));
  // These are standalone, pre-session pages with their own full-bleed
  // design (background photo, glass card) - no header/search/account
  // menu or bottom tab bar belongs on top of them. LangEffect still
  // runs so <html lang/dir> stays correct for whichever page the
  // customer lands on next.
  // «إدارة طلبات الفرع v2» phase 1: print pages (the internal prep sheet)
  // are paper - no header, no menus, no bottom tab bar, on screen or printed.
  if (AUTH_PAGE_PATHS.has(pathname) || pathname.startsWith("/print/")) {
    // Deliberately NOT the shared .app-main class - that reserves
    // header/bottom-nav space (globals.css) neither of which renders
    // here, which would just leave a dead gap under the auth pages'
    // own full-viewport .page layout.
    return (
      <>
        <LangEffect />
        <Toaster />
        <Suspense fallback={null}>
          <RouteTrailRecorder />
        </Suspense>
        <main>{children}</main>
      </>
    );
  }

  // Management pages rendered inside the store-owner modal use their
  // existing routes and authorization, but deliberately omit the global
  // shell so only the page content appears in the modal frame.
  if (isManagementEmbed || isAccountEmbed) {
    return (
      <>
        <LangEffect />
        <Toaster />
        <Suspense fallback={null}>
          <RouteTrailRecorder />
        </Suspense>
        <main className={isManagementEmbed ? "management-embedded-page" : "account-embedded-page"}>{pageContent}</main>
      </>
    );
  }

  return (
    <>
      <LangEffect />
        <Toaster />
      <Suspense fallback={null}>
        <RouteTrailRecorder />
      </Suspense>
      {usesViaHeader ? (
        <>
        <header
          key={pathname}
          ref={homeHeaderRef}
          className={[
            homeStyles.homeHeader,
            // Light pages get the header's dark-ink variant: /trending, the
            // homepage (its editorial hero is a warm ivory photograph), and the
            // shopping profile and cart canvases.
            usesTrendChrome ? `${homeStyles.headerInk} trend-page-header` : (isHomePage || isShoppingProfilePage || isCartPage) ? homeStyles.headerInk : "",
            headerScrolled || homeNavOpen ? homeStyles.headerScrolled : "",
          ].filter(Boolean).join(" ")}
        >
          <div className={homeStyles.headerInner}>
            <button
              type="button"
              className={homeStyles.menuToggle}
              aria-label={homeNavOpen ? t("appshell.menu_close") : t("appshell.menu_open")}
              aria-expanded={homeNavOpen}
              aria-controls="via-header-menu"
              onClick={() => {
                setHomeSearchOpen(false);
                setHomeNavOpen((v) => !v);
              }}
            >
              {homeNavOpen ? <CloseIcon /> : <MenuIcon />}
            </button>

            <div className={homeStyles.brandArea}>
              <Link href="/" className={homeStyles.brand} aria-label="VIA - الرئيسية" onClick={() => setHomeNavOpen(false)}>
                <Image className={homeStyles.brandLogo} src="/images/via-logo.svg" alt="" width={70} height={56} priority />
                <span className={homeStyles.brandName}>ViA</span>
              </Link>
              {/* The header row stays RTL; the tagline itself follows the site language. */}
              <span className={homeStyles.brandTagline} lang={lang} dir={lang === "ar" ? "rtl" : "ltr"}>
                {t("appshell.tagline")}
              </span>
            </div>

            <nav className={homeStyles.homeNav} aria-label="التنقل الرئيسي">
              {renderViaNav(homeStyles.navLink)}
            </nav>

            {/* via-header-tools: stable hook for page-scoped styling (trend page).
                Order (RTL, right to left): search, favourites, account, notifications, cart, support. */}
            <div className={`${homeStyles.headerTools} via-header-tools`}>
              <form
                className={`${homeStyles.homeSearch}${homeSearchOpen ? ` ${homeStyles.homeSearchOpen}` : ""}`}
                role="search"
                onSubmit={onSearch}
              >
                <button
                  type="button"
                  className={homeStyles.searchToggle}
                  aria-label={t("appshell.search.submit_aria")}
                  aria-expanded={homeSearchOpen}
                  onClick={onHomeSearchButton}
                >
                  <SearchIcon />
                </button>
                <input
                  ref={homeSearchInputRef}
                  className={homeStyles.homeSearchInput}
                  type="search"
                  aria-label={t("appshell.search.placeholder")}
                  placeholder={t("appshell.search.placeholder")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onFocus={() => setHomeSearchOpen(true)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setHomeSearchOpen(false);
                      e.currentTarget.blur();
                    }
                  }}
                />
                <button
                  type="button"
                  className={homeStyles.searchClose}
                  aria-label={t("appshell.search.close")}
                  onClick={() => setHomeSearchOpen(false)}
                >
                  <CloseIcon />
                </button>
              </form>
              <Link
                href="/account"
                className={homeStyles.toolLink}
                aria-label={NAV_LABELS[lang].account}
                onClick={(event) => {
                  event.preventDefault();
                  openAccount();
                }}
                data-testid="header-account"
              >
                <UserIcon />
              </Link>
              <button
                type="button"
                className={homeStyles.toolLink}
                aria-label={t("appshell.bell_aria")}
                title={t("appshell.bell_aria")}
                onClick={() => setNotificationsPanelOpen(true)}
              >
                <BellIcon />
                {unreadCount > 0 && <span className="badge-count">{unreadCount}</span>}
              </button>
              <Link href="/cart" className={homeStyles.toolLink} aria-label={NAV_LABELS[lang].cart}>
                <CartIcon />
                {cartCount > 0 && <span className="badge-count">{cartCount}</span>}
              </Link>
              {/* No help centre exists yet: the entry point is in place, inactive. */}
              <button
                type="button"
                className={`${homeStyles.toolLink} ${homeStyles.toolPending}`}
                aria-label={t("appshell.support_soon")}
                title={t("appshell.support_soon")}
                aria-disabled="true"
              >
                <SupportIcon />
              </button>
            </div>
          </div>

          {homeNavOpen && (
            <nav id="via-header-menu" className={homeStyles.headerMenu} aria-label="التنقل الرئيسي">
              {renderViaNav(homeStyles.headerMenuLink)}
            </nav>
          )}
        </header>
        <NotificationsPanel open={notificationsPanelOpen} onClose={closeNotificationsPanel} />
        </>
      ) : isStorePage || isComparisonPage || isAccountPage || isFavoritesPage || isEmployeeWorkspacePage ? null : (
      <header className={`app-header${isWomenPage ? " women-header" : ""}`}>
        {isWomenPage ? (
          <div className="women-header-inner">
            <div className="women-header-actions" aria-label="روابط سريعة">
              <Link href="/cart" className="women-header-icon" aria-label="سلتي">
                <CartIcon />
                {cartCount > 0 && <span className="badge-count">{cartCount}</span>}
              </Link>
              <Link href="/profile?tab=following" className="women-header-icon" aria-label="أتابعه">
                <HeartIcon />
              </Link>
              <Link
                href="/account"
                className="women-header-icon"
                aria-label="حسابي"
                onClick={(event) => {
                  event.preventDefault();
                  openAccount();
                }}
              >
                <UserIcon />
              </Link>
              <Link href="/discovery" className="women-header-icon" aria-label="البحث">
                <SearchIcon />
              </Link>
            </div>
           <div className="women-header-nav">
  <form
    className="women-search-bar"
    role="search"
    onSubmit={(e) => {
      e.preventDefault();

      const formData = new FormData(e.currentTarget);
      const query = String(formData.get("q") ?? "").trim();

      if (query) {
        router.push(`/discovery?q=${encodeURIComponent(query)}`);
      }
    }}
  >
    <input
      type="search"
      name="q"
      placeholder="ابحثي عن منتجات، ماركات أو متاجر..."
      aria-label="البحث في Via"
    />

    <button type="submit" aria-label="بحث">
      <svg
        width="21"
        height="21"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-4-4" />
      </svg>
    </button>
  </form>
</div>

            <Link href="/" className="women-header-brand" aria-label="Via - الصفحة الرئيسية">
  <Image src="/images/via-brand-mark.png" alt="" width={512} height={346} priority unoptimized />
            </Link>
          </div>
        ) : (
        <div className="app-header-inner">
          <Link href="/" className="app-logo" aria-label={`${isViaExperience ? "Via" : "FINALPRO"} - ${t("nav.home")}`}>
            <span className="app-logo-mark" aria-hidden="true">
              {isViaExperience ? "V" : "F"}
            </span>
            <span>{isViaExperience ? "VIA" : "FINALPRO"}</span>
          </Link>

          <nav className="app-nav" aria-label={t("appshell.nav.primary_aria")}>
            {links.map((l) => (
              <Link
                key={l.key}
                href={l.href}
                className={isActivePath(pathname, l.href) || (l.key === "discover" && pathname === "/women") ? "active" : ""}
                aria-current={isActivePath(pathname, l.href) || (l.key === "discover" && pathname === "/women") ? "page" : undefined}
              >
                {NAV_LABELS[lang][l.key]}
                {l.key === "cart" && cartCount > 0 && (
                  <span className="badge-count">{cartCount}</span>
                )}
              </Link>
            ))}
          </nav>

          <form className="app-search" role="search" onSubmit={onSearch}>
            <input
              type="search"
              aria-label={t("appshell.search.placeholder")}
              placeholder={t("appshell.search.placeholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button type="submit" aria-label={t("appshell.search.submit_aria")}>
              <SearchIcon />
            </button>
          </form>

          <div className="app-header-actions">
            {workspaceMenu}
            {token && (
              <Link href={notificationsPagePath(pathname)} className="icon-button" aria-label={t("appshell.notifications_aria")}>
                <BellIcon />
                {unreadCount > 0 && <span className="badge-count">{unreadCount}</span>}
              </Link>
            )}

            <Link
              href="/profile?tab=following"
              className="icon-button mobile-only"
              aria-label={NAV_LABELS[lang].following}
            >
              <HeartIcon />
            </Link>

            {token ? (
              <div className="account-menu" ref={menuRef}>
                <button
                  className="icon-button desktop-only"
                  aria-haspopup="dialog"
                  aria-expanded={accountModalOpen}
                  aria-label={t("appshell.account_menu_aria")}
                  onClick={() => openAccount()}
                >
                  <UserIcon />
                </button>
                {menuOpen && (
                  <div className="account-menu-panel" role="menu">
                    <div className="account-menu-title">{t("appshell.workspaces_title")}</div>
                    {workspaces === null && (
                      <div className="account-menu-title">{t("common.loading")}</div>
                    )}
                    {workspaces?.map((w, i) => {
                      const entry = workspaceEntry(w);
                      return (
                        <button
                          key={entry.id}
                          role="menuitem"
                          className={`menu-item${isActiveWorkspace(i) ? " active" : ""}`}
                          disabled={entry.disabled}
                          style={entry.disabled ? { opacity: 0.6, cursor: "not-allowed" } : undefined}
                          onClick={() => void switchTo(i)}
                        >
                          <span>
                            <strong>{entry.label}</strong>
                            <br />
                            <small>{entry.subtitle}</small>
                          </span>
                          {entry.disabled ? (
                            <span className="badge">{t("appshell.badge.suspended")}</span>
                          ) : (
                            isActiveWorkspace(i) && <span className="badge badge-active">{t("appshell.badge.active")}</span>
                          )}
                        </button>
                      );
                    })}
                    <div className="menu-divider" />
                    <Link
                      href="/account"
                      role="menuitem"
                      className="menu-item"
                      onClick={(event) => {
                        event.preventDefault();
                        openAccount();
                      }}
                    >
                      {NAV_LABELS[lang].account}
                    </Link>
                    <button role="menuitem" className="menu-item" onClick={() => void signOut()}>
                      {t("appshell.sign_out")}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <></>                // add it later sign in and sign up buttons in a _
            )}
          </div>
        </div>
        )}
      </header>
      )}

      <main className={`app-main${usesViaHeader ? " home-main" : ""}${isWomenPage ? " women-main" : ""}${isKidsPage ? " kids-main" : ""}${isMenPage ? " men-main" : ""}${isAccountPage ? " account-main" : ""}${usesTrendChrome ? " trend-main" : ""}`}>{pageContent}</main>

      <nav className={`bottom-nav${usesViaHeader ? " home-bottom-nav" : ""}`} aria-label={t("appshell.nav.bottom_aria")}>
        {tabs.map((tab) => {
          const activeTab =
            tab.key === "account"
              ? isActivePath(pathname, "/account") ||
                isActivePath(pathname, "/login") ||
                isActivePath(pathname, "/workspaces")
              : isActivePath(pathname, tab.href) || (tab.key === "discover" && pathname === "/women");
          return (
            <Link
              key={tab.key}
              href={tab.href}
              className={activeTab ? "active" : ""}
              aria-current={activeTab ? "page" : undefined}
              onClick={tab.key === "account" ? (event) => {
                event.preventDefault();
                openAccount();
              } : undefined}
            >
              {TAB_ICONS[tab.key]}
              <span>{NAV_LABELS[lang][tab.key]}</span>
              {tab.key === "cart" && cartCount > 0 && (
                <span className="badge-count">{cartCount}</span>
              )}
            </Link>
          );
        })}
      </nav>

<footer className="app-footer">
  <button
    type="button"
    className="icon-button lang-switch"
    aria-label={lang === "ar" ? "التبديل إلى الإنجليزية" : "Switch to Arabic"}
    onClick={toggleLanguage}
  >
    {lang === "ar" ? "EN" : "AR"}
  </button>
</footer>
      {accountModalOpen && (
        <div
          className="account-modal-overlay"
          role="presentation"
          onMouseDown={() => setAccountModalOpen(false)}
        >
          <section
            className="account-modal-panel"
            role="dialog"
            aria-modal="true"
            aria-label={NAV_LABELS[lang].account}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <iframe className="account-modal-frame" src="/account?embed=account" title={NAV_LABELS[lang].account} />
          </section>
        </div>
      )}
 </>
);
}

/** Visual pass: the workspace menu's icons (same line style as the header's). */
function WorkspaceIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 9.5 5.5 4h13L20 9.5M4 9.5a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0M5.5 12v8h13v-8M10 20v-5h4v5" />
    </svg>
  );
}
function LeaveIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon-flip-rtl">
      <path d="M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3M10 8l-4 4 4 4M6 12h10" />
    </svg>
  );
}
