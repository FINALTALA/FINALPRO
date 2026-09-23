"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import {
  BagIcon,
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
import { clearSession, setActiveWorkspace } from "@/lib/session";
import {
  useActiveWorkspace,
  useCartCount,
  useSessionToken,
  useWorkspaces,
} from "@/lib/useSession";

const TAB_ICONS: Record<NavLink["key"], ReactNode> = {
  home: <HomeIcon />,
  discover: <CompassIcon />,
  cart: <CartIcon />,
  orders: <BagIcon />,
  following: <HeartIcon />,
  account: <UserIcon />,
};

// Sprint 13: the one app shell every page renders inside - a sticky
// header on desktop (logo, search, main links, account/workspace menu)
// and a bottom navigation on mobile. Pure presentation: it only reads
// the session to decide what to SHOW; backend authorization is the
// real protection for every route it links to.
export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const token = useSessionToken();
  const workspaces = useWorkspaces(token);
  const active = useActiveWorkspace();
  const cartCount = useCartCount(token, pathname);
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
    setActiveWorkspace(
      w.type === "customer"
        ? { type: "customer" }
        : { type: "vendor", vendor_id: w.vendor_id, branch_id: w.branch_id },
    );
    setMenuOpen(false);
    router.push(entry.href);
  }

  function logout() {
    clearSession();
    setMenuOpen(false);
    router.replace("/login");
  }

  const isActiveWorkspace = (i: number) => {
    if (!workspaces || !active) return i === 0 && !active;
    const w = workspaces[i];
    if (w.type === "customer") return active.type === "customer";
    return active.type === "vendor" && active.vendor_id === w.vendor_id;
  };

  const links = desktopLinks();
  const tabs = mobileTabs(Boolean(token));

  return (
    <>
      <header className="app-header">
        <div className="app-header-inner">
          <Link href="/" className="app-logo" aria-label="FINALPRO - الرئيسية">
            <span className="app-logo-mark" aria-hidden="true">
              F
            </span>
            <span>FINALPRO</span>
          </Link>

          <nav className="app-nav" aria-label="التنقل الرئيسي">
            {links.map((l) => (
              <Link
                key={l.key}
                href={l.href}
                className={isActivePath(pathname, l.href) ? "active" : ""}
                aria-current={isActivePath(pathname, l.href) ? "page" : undefined}
              >
                {l.label}
                {l.key === "cart" && cartCount > 0 && (
                  <span className="badge-count">{cartCount}</span>
                )}
              </Link>
            ))}
          </nav>

          <form className="app-search" role="search" onSubmit={onSearch}>
            <input
              type="search"
              aria-label="ابحث عن منتج أو متجر"
              placeholder="ابحث عن منتج أو متجر"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button type="submit" aria-label="بحث">
              <SearchIcon />
            </button>
          </form>

          <div className="app-header-actions">
            <Link
              href="/following"
              className="icon-button mobile-only"
              aria-label="أتابعه"
            >
              <HeartIcon />
            </Link>

            {token ? (
              <div className="account-menu" ref={menuRef}>
                <button
                  className="icon-button desktop-only"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  aria-label="الحساب ومساحات العمل"
                  onClick={() => setMenuOpen((v) => !v)}
                >
                  <UserIcon />
                </button>
                {menuOpen && (
                  <div className="account-menu-panel" role="menu">
                    <div className="account-menu-title">مساحات العمل</div>
                    {workspaces === null && (
                      <div className="account-menu-title">جارٍ التحميل...</div>
                    )}
                    {workspaces?.map((w, i) => {
                      const entry = workspaceEntry(w);
                      return (
                        <button
                          key={entry.id}
                          role="menuitem"
                          className={`menu-item${isActiveWorkspace(i) ? " active" : ""}`}
                          onClick={() => switchTo(i)}
                        >
                          <span>
                            <strong>{entry.label}</strong>
                            <br />
                            <small>{entry.subtitle}</small>
                          </span>
                          {isActiveWorkspace(i) && <span className="badge badge-active">نشطة</span>}
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
                      حسابي
                    </Link>
                    <button role="menuitem" className="menu-item" onClick={logout}>
                      تسجيل الخروج
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <span className="desktop-only" style={{ display: "flex", gap: 8 }}>
                <Link href="/login" className="button-link">
                  دخول
                </Link>
                <Link href="/register" className="button">
                  إنشاء حساب
                </Link>
              </span>
            )}
          </div>
        </div>
      </header>

      <main className="app-main">{children}</main>

      <nav className="bottom-nav" aria-label="التنقل السفلي">
        {tabs.map((t) => {
          const activeTab =
            t.key === "account"
              ? isActivePath(pathname, "/account") ||
                isActivePath(pathname, "/login") ||
                isActivePath(pathname, "/workspaces")
              : isActivePath(pathname, t.href);
          return (
            <Link
              key={t.key}
              href={t.href}
              className={activeTab ? "active" : ""}
              aria-current={activeTab ? "page" : undefined}
            >
              {TAB_ICONS[t.key]}
              <span>{t.label}</span>
              {t.key === "cart" && cartCount > 0 && (
                <span className="badge-count">{cartCount}</span>
              )}
            </Link>
          );
        })}
      </nav>
    </>
  );
}
