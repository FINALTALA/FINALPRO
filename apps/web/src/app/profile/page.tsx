"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { BackIcon, HeartIcon, StoreManageIcon, UserIcon } from "@/components/Icons";
import SafeImage from "@/components/SafeImage";
import { ErrorBanner } from "@/components/States";
import FavoritesPage from "@/app/account/favorites/page";
import FollowingFeed from "@/components/FollowingFeed";
import UserSettings from "@/components/profile/UserSettings";
import { SETTINGS_HREF } from "@/lib/accountSettingsText";
import { useT } from "@/lib/useLang";
import { clearSession } from "@/lib/session";
import { useFetch } from "@/lib/useFetch";
import { useHydrated, useSessionToken } from "@/lib/useSession";
import { loginHref } from "@/lib/loginRedirect";

interface MeDto {
  phone: string;
  display_name: string | null;
}

interface FavoriteDto {
  id: string;
  name_ar: string | null;
  name_en: string | null;
}

interface FollowingStoreDto {
  slug: string;
  display_name: string;
  logo_url: string | null;
}

type ProfilePanel = "favorites" | "following";

// The page's own loading state - also its Suspense fallback, so the
// prerendered HTML is exactly what the page shows until it hydrates.
function ProfileSkeleton() {
  return <main className="page-shell"><div className="skeleton" style={{ height: 360, width: "100%", maxWidth: 980 }} /></main>;
}

// The whole page follows ?tab= (and its «أتابعه» feed keeps its own state
// in the URL too), so the boundary sits at the page: everything here
// renders from the query string.
export default function ShoppingProfilePage() {
  return (
    <Suspense fallback={<ProfileSkeleton />}>
      <ShoppingProfile />
    </Suspense>
  );
}

// A private shopping profile, not a social network profile: it deliberately
// has no avatar upload, posts, followers or public-facing counts.
function ShoppingProfile() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const me = useFetch<MeDto>(token ? "/customers/me" : null, true);
  const favorites = useFetch<FavoriteDto[]>(token ? "/favorites" : null, true);
  const following = useFetch<{ items: FollowingStoreDto[] }>(
    token ? "/customers/me/following" : null,
    true,
  );
  const followingRailRef = useRef<HTMLDivElement>(null);
  const [followingNeedsScroll, setFollowingNeedsScroll] = useState(false);
  // ?tab= is the single source of truth, so the header's «أحببته» /
  // «أتابعه» links always land on their tab - also when /profile is
  // already open on the other one - and a sign-in returns to it.
  const activePanel: ProfilePanel = searchParams.get("tab") === "following" ? "following" : "favorites";
  // 2026-11-24: «إعدادات المستخدم» is a view of this same page (?view=settings)
  const settingsOpen = searchParams.get("view") === "settings";
  const t = useT();
  const gearRef = useRef<HTMLAnchorElement>(null);
  const settingsHeadingRef = useRef<HTMLHeadingElement>(null);
  // The chosen tab is page state (not always in the URL): its own path, checked by loginHref.
  const loginRedirect = loginHref(settingsOpen ? SETTINGS_HREF : `/profile?tab=${activePanel}`);
  function setActivePanel(panel: ProfilePanel) {
    // Only ?tab= changes: the «أتابعه» feed's selection stays in the URL,
    // so coming back from «أحببته» finds it as it was.
    const next = new URLSearchParams(searchParams.toString());
    next.set("tab", panel);
    router.replace(`/profile?${next.toString()}`, { scroll: false });
  }
  function closeSettings() {
    const next = new URLSearchParams(searchParams.toString());
    next.delete("view");
    router.replace(`/profile${next.toString() ? `?${next.toString()}` : ""}`, { scroll: false });
  }
  function scrollFollowing(direction: "next" | "previous") {
    followingRailRef.current?.scrollBy({
      left: direction === "next" ? -360 : 360,
      behavior: "smooth",
    });
  }

  useEffect(() => {
    if (me.status === 401) {
      clearSession();
      router.replace(loginRedirect);
    }
  }, [me.status, router, loginRedirect]);

  useEffect(() => {
    if (hydrated && !token) router.replace(loginRedirect);
  }, [hydrated, token, router, loginRedirect]);

  const wasSettingsOpen = useRef(settingsOpen);
  useEffect(() => {
    if (settingsOpen && !wasSettingsOpen.current) settingsHeadingRef.current?.focus();
    if (!settingsOpen && wasSettingsOpen.current) gearRef.current?.focus();
    wasSettingsOpen.current = settingsOpen;
  }, [settingsOpen]);

  useEffect(() => {
    if (activePanel !== "following") return;
    const rail = followingRailRef.current;
    if (!rail) return;
    const update = () => setFollowingNeedsScroll(rail.scrollWidth > rail.clientWidth + 1);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(rail);
    return () => observer.disconnect();
  }, [activePanel, following.data?.items?.length]);

  if (!hydrated || !token) {
    return <ProfileSkeleton />;
  }

  const displayName = me.data?.display_name?.trim() || "متسوّق";
  const favoriteItems = favorites.data ?? [];
  const followedStores = following.data?.items ?? [];

  return (
    <main className="shopping-profile page-shell">
      <div className="shopping-profile-hero">
        <section className="shopping-profile-identity wide-shell">
          <div className="shopping-profile-avatar" aria-label="أيقونة الحساب"><UserIcon /></div>
          <div className="shopping-profile-copy">
            <p>مساحة التسوّق</p>
            <h1>{displayName}</h1>
            <span dir="ltr">{me.data?.phone ?? ""}</span>
            <small>حساب خاص للتسوّق والحفظ ومتابعة المتاجر</small>
          </div>
          {!settingsOpen && (
            <Link
              ref={gearRef}
              href={SETTINGS_HREF}
              className="us-open shopping-profile-settings"
              aria-label={t("us.open")}
              onClick={(event) => {
                event.preventDefault();
                const next = new URLSearchParams(searchParams.toString());
                next.set("view", "settings");
                router.replace(`/profile?${next.toString()}`, { scroll: false });
              }}
              data-testid="profile-settings-open"
            >
              <GearIcon />
              <span className="us-open-label">{t("us.open")}</span>
            </Link>
          )}
        </section>

        {me.error && me.status !== 401 && <ErrorBanner message={me.error} />}

        {!settingsOpen && (
        <section className="shopping-profile-panel">
        <div className="shopping-profile-tabs" role="tablist" aria-label="محتوى بروفايل التسوق">
          <button type="button" role="tab" aria-selected={activePanel === "favorites"} className={activePanel === "favorites" ? "active" : ""} onClick={() => setActivePanel("favorites")}>
            <HeartIcon /> أحببته <small>{favoriteItems.length}</small>
          </button>
          <button type="button" role="tab" aria-selected={activePanel === "following"} className={activePanel === "following" ? "active" : ""} onClick={() => setActivePanel("following")}>
            <StoreManageIcon /> أتابعه <small>{followedStores.length}</small>
          </button>
        </div>
        </section>
        )}
      </div>

      {settingsOpen ? (
          <UserSettings phone={me.data?.phone ?? null} onBack={closeSettings} headingRef={settingsHeadingRef} />
        ) : activePanel === "favorites" ? (
          <div className="shopping-profile-list" role="tabpanel">
            <div className="shopping-profile-panel-heading shopping-profile-favorites-heading"><p>المنتجات والعروض التي حفظتها للعودة إليها.</p></div>
            <FavoritesPage embedded />
          </div>
        ) : activePanel === "following" ? (
          <div className="shopping-profile-list" role="tabpanel">
            <section className="following-stores-panel" aria-label="المتاجر المتابعة">
              <div className="following-stores-panel-heading">
                <h2>المتاجر التي اخترت متابعتها حديثاً</h2>
                <p>تابعي آخر المنتجات والكولكشنات من متاجرك المفضلة.</p>
              </div>
              {following.loading ? <div className="skeleton following-stores-skeleton" /> : followedStores.length === 0 ? <p className="shopping-profile-empty following-stores-empty">لا تتابع أي متجر بعد.</p> : (
                <div className="following-store-rail-wrap">
                  {followingNeedsScroll && <button type="button" className="following-store-rail-arrow following-store-rail-arrow-next" onClick={() => scrollFollowing("next")} aria-label="المتاجر التالية"><BackIcon /></button>}
                  <div className="following-store-rail" ref={followingRailRef}>
                    {followedStores.map((store) => (
                      <Link key={store.slug} href={`/store/${store.slug}`} className="following-store-avatar" title={store.display_name}>
                        <span className="following-store-avatar-image"><SafeImage src={store.logo_url} alt={`شعار ${store.display_name}`} /></span>
                        <span>{store.display_name}</span>
                      </Link>
                    ))}
                  </div>
                  {followingNeedsScroll && <button type="button" className="following-store-rail-arrow following-store-rail-arrow-previous" onClick={() => scrollFollowing("previous")} aria-label="المتاجر السابقة"><BackIcon /></button>}
                </div>
              )}
            </section>
            {!following.loading && followedStores.length > 0 && (
              <FollowingFeed storesKey={followedStores.map((store) => store.slug).join(",")} />
            )}
          </div>
        ) : null}
    </main>
  );
}

/** «الإعدادات» - a quiet gear (the app's own line style). */
function GearIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}
