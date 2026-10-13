"use client";

import Link from "next/link";
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

// Sprint 13: the one app shell every page renders inside - a sticky
// header on desktop (logo, search, main links, account/workspace menu)
// and a bottom navigation on mobile. Pure presentation: it only reads
// the session to decide what to SHOW; backend authorization is the
// real protection for every route it links to.
export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isViaExperience = pathname === "/" || pathname === "/women";
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
  const menuRef = useRef<HTMLDivElement>(null);

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

  return (
    <>
      <LangEffect />
      <header className={`app-header${isViaExperience ? " home-header" : ""}`}>
        {isViaExperience && <div className="home-announcement">{t("appshell.announcement")}</div>}
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
            <button
              type="button"
              className="icon-button lang-switch"
              aria-label={lang === "ar" ? "التبديل إلى الإنجليزية" : "Switch to Arabic"}
              onClick={toggleLanguage}
            >
              {lang === "ar" ? "EN" : "AR"}
            </button>

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
              <span className="desktop-only" style={{ display: "flex", gap: 8 }}>
                <Link href="/login" className="button-link">
                  {t("appshell.sign_in")}
                </Link>
                <Link href="/register" className="button">
                  {t("appshell.sign_up")}
                </Link>
              </span>
            )}
          </div>
        </div>
      </header>

      <main className={`app-main${isViaExperience ? " home-main" : ""}`}>{children}</main>

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
    </>
  );
}
