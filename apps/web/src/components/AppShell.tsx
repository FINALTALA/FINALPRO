"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import {
  BagIcon,
  BellIcon,
  CartIcon,
  CompassIcon,
  HeartIcon,
  HomeIcon,
  SearchIcon,
  UserIcon,
} from "./Icons";
import {
  NavLink,
  desktopLinks,
  isActivePath,
  mobileTabs,
  workspaceEntry,
} from "@/lib/nav";
import { logout } from "@/lib/auth";
import { setActiveWorkspace } from "@/lib/session";
import {
  useActiveWorkspace,
  useCartCount,
  useSessionToken,
  useUnreadNotificationCount,
  useWorkspaces,
} from "@/lib/useSession";
import { newIdempotencyKey, apiFetch } from "@/lib/api";
import { Lang, setLang } from "@/lib/i18n";
import { useLang, useSyncServerLanguagePref, useT } from "@/lib/useLang";
import LangEffect from "./LangEffect";
import homeStyles from "@/app/home-via.module.css";

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
const AUTH_PAGE_PATHS = new Set(["/login", "/register", "/reset-password", "/reactivate"]);

// Sprint 13: the one app shell every page renders inside - a sticky
// header on desktop (logo, search, main links, account/workspace menu)
// and a bottom navigation on mobile. Pure presentation: it only reads
// the session to decide what to SHOW; backend authorization is the
// real protection for every route it links to.
export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isHomePage = pathname === "/";
  // The trend page uses the same campaign header as the homepage.
  const isTrendPage = pathname === "/trending";
  // The ads page shows the homepage header as it is on the homepage (over
  // its full-bleed campaign hero).
  const isAdsPage = pathname === "/ads";
  const usesTrendChrome = isTrendPage;
  const usesHomeHeader = isHomePage || isTrendPage || isAdsPage;
  const isViaExperience = pathname === "/" || pathname === "/women" || isTrendPage || isAdsPage;
  // Store pages carry their own identity bar (logo, name, icon), so the
  // platform header is not rendered on top of them.
  const isStorePage = pathname.startsWith("/store/");
  const isWomenPage = pathname === "/women";
  const router = useRouter();
  const token = useSessionToken();
  const workspaces = useWorkspaces(token);
  const active = useActiveWorkspace();
  const cartCount = useCartCount(token, pathname);
  const unreadCount = useUnreadNotificationCount(token, pathname);
  const lang = useLang();
  const t = useT();
  useSyncServerLanguagePref(token);
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [homeSearchOpen, setHomeSearchOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const homeSearchInputRef = useRef<HTMLInputElement>(null);
  const homeHeaderRef = useRef<HTMLElement>(null);

  // The campaign header belongs to the first screen only. As the visitor
  // leaves that screen, it glides upward and fades instead of staying over
  // the catalogue content below.
  useEffect(() => {
    if (!isHomePage) return;

    let frame = 0;
    const updateHeader = () => {
      frame = 0;
      const hero = document.querySelector<HTMLElement>(`.${homeStyles.hero}`);
      // The campaign fades into the category area before the hero element's
      // literal bottom. Begin the header exit at that visual fade, not after
      // the full element has already scrolled away.
      const heroEnd = hero
        ? hero.getBoundingClientRect().top + window.scrollY + hero.offsetHeight
        : window.innerHeight;
      const fadeStart = heroEnd - Math.min(340, hero?.offsetHeight ? hero.offsetHeight * .34 : 340);
      const progress = Math.min(Math.max((window.scrollY - fadeStart) / 230, 0), 1);
      const header = homeHeaderRef.current;
      if (!header) return;
      header.style.setProperty("--via-home-header-scroll", String(progress));
      header.style.pointerEvents = progress >= 1 ? "none" : "";
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(updateHeader);
    };

    updateHeader();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [isHomePage]);

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

  function onSearch(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    router.push(q ? `/discovery?q=${encodeURIComponent(q)}` : "/discovery");
  }

  function switchTo(index: number) {
    if (!workspaces) return;
    const w = workspaces[index];
    const entry = workspaceEntry(w);
    if (entry.disabled) return;
    setActiveWorkspace(
      w.type === "customer"
        ? { type: "customer" }
        : w.type === "platform"
          ? { type: "platform" }
          : { type: "vendor", vendor_id: w.vendor_id, branch_id: w.branch_id },
    );
    setMenuOpen(false);
    router.push(entry.href);
  }

  async function signOut() {
    setMenuOpen(false);
    await logout();
    router.replace("/login");
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

  const isActiveWorkspace = (i: number) => {
    if (!workspaces || !active) return i === 0 && !active;
    const w = workspaces[i];
    if (w.type === "customer") return active.type === "customer";
    if (w.type === "platform") return active.type === "platform";
    return active.type === "vendor" && active.vendor_id === w.vendor_id;
  };

  const links = desktopLinks();
  const tabs = mobileTabs(Boolean(token));
  // These are standalone, pre-session pages with their own full-bleed
  // design (background photo, glass card) - no header/search/account
  // menu or bottom tab bar belongs on top of them. LangEffect still
  // runs so <html lang/dir> stays correct for whichever page the
  // customer lands on next.
  if (AUTH_PAGE_PATHS.has(pathname)) {
    // Deliberately NOT the shared .app-main class - that reserves
    // header/bottom-nav space (globals.css) neither of which renders
    // here, which would just leave a dead gap under the auth pages'
    // own full-viewport .page layout.
    return (
      <>
        <LangEffect />
        <main>{children}</main>
      </>
    );
  }

  return (
    <>
      <LangEffect />
      {usesHomeHeader ? (
        <header ref={homeHeaderRef} className={`${homeStyles.homeHeader}${usesTrendChrome ? " trend-page-header" : ""}`}>
          <div className={homeStyles.headerInner}>
            <Link href="/" className={homeStyles.brand} aria-label="VIA - الرئيسية">
              <Image className={homeStyles.brandLogo} src="/images/via-logo.svg" alt="" width={70} height={56} priority />
              <span className={homeStyles.brandName}>ViA</span>
            </Link>

            <nav className={homeStyles.homeNav} aria-label="التنقل الرئيسي">
              <Link
                href="/"
                className={`${homeStyles.navLink}${isHomePage ? ` ${homeStyles.navCurrent}` : ""}`}
                aria-current={isHomePage ? "page" : undefined}
              >
                الرئيسية
              </Link>
              <Link href="/following" className={homeStyles.navLink}>أتابعه</Link>
              <Link
                href="/trending"
                className={`${homeStyles.navLink}${isTrendPage ? ` ${homeStyles.navCurrent}` : ""}`}
                aria-current={isTrendPage ? "page" : undefined}
              >
                الترند
              </Link>
              <Link
                href="/ads"
                className={`${homeStyles.navLink}${isAdsPage ? ` ${homeStyles.navCurrent}` : ""}`}
                aria-current={isAdsPage ? "page" : undefined}
              >
                الإعلانات
              </Link>
              <span className={homeStyles.navPending} aria-disabled="true">عن VIA</span>
            </nav>

            {/* via-header-tools: stable hook for page-scoped styling (trend page). */}
            <div className={`${homeStyles.headerTools} via-header-tools`}>
              <form
                className={`${homeStyles.homeSearch}${homeSearchOpen ? ` ${homeStyles.homeSearchOpen}` : ""}`}
                role="search"
                onSubmit={onSearch}
              >
                <input
                  ref={homeSearchInputRef}
                  className={homeStyles.homeSearchInput}
                  type="search"
                  aria-label={t("appshell.search.placeholder")}
                  placeholder={t("appshell.search.placeholder")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setHomeSearchOpen(false);
                  }}
                />
                <button
                  type="button"
                  className={homeStyles.searchToggle}
                  aria-label={t("appshell.search.submit_aria")}
                  aria-expanded={homeSearchOpen}
                  onClick={() => setHomeSearchOpen(true)}
                >
                  <SearchIcon />
                </button>
              </form>
              <Link href="/account" className={homeStyles.toolLink} aria-label={NAV_LABELS[lang].account}>
                <UserIcon />
              </Link>
              <Link href="/account/favorites" className={homeStyles.toolLink} aria-label="المفضلة">
                <HeartIcon />
              </Link>
              <Link href="/cart" className={homeStyles.toolLink} aria-label={NAV_LABELS[lang].cart}>
                <CartIcon />
                {cartCount > 0 && <span className="badge-count">{cartCount}</span>}
              </Link>
            </div>
          </div>
        </header>
      ) : isStorePage ? null : (
      <header className={`app-header${isWomenPage ? " women-header" : ""}`}>
        {isWomenPage ? (
          <div className="women-header-inner">
            <div className="women-header-actions" aria-label="روابط سريعة">
              <Link href="/cart" className="women-header-icon" aria-label="سلتي">
                <CartIcon />
                {cartCount > 0 && <span className="badge-count">{cartCount}</span>}
              </Link>
              <Link href="/following" className="women-header-icon" aria-label="أتابعه">
                <HeartIcon />
              </Link>
              <Link href="/account" className="women-header-icon" aria-label="حسابي">
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
            {token && (
              <Link href="/notifications" className="icon-button" aria-label={t("appshell.notifications_aria")}>
                <BellIcon />
                {unreadCount > 0 && <span className="badge-count">{unreadCount}</span>}
              </Link>
            )}

            <Link
              href="/following"
              className="icon-button mobile-only"
              aria-label={NAV_LABELS[lang].following}
            >
              <HeartIcon />
            </Link>

            {token ? (
              <div className="account-menu" ref={menuRef}>
                <button
                  className="icon-button desktop-only"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  aria-label={t("appshell.account_menu_aria")}
                  onClick={() => setMenuOpen((v) => !v)}
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
                          onClick={() => switchTo(i)}
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
                      onClick={() => setMenuOpen(false)}
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

      <main className={`app-main${isViaExperience ? " home-main" : ""}${isWomenPage ? " women-main" : ""}${usesTrendChrome ? " trend-main" : ""}`}>{children}</main>

      <nav className={`bottom-nav${isViaExperience ? " home-bottom-nav" : ""}`} aria-label={t("appshell.nav.bottom_aria")}>
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
 </>
);
}
