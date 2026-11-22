"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ApiError, apiFetch } from "./api";
import { loginHref as safeLoginHref } from "./loginRedirect";
import { clearSession } from "./session";
import type { ComparisonCardDto } from "./types";
import { useSessionToken } from "./useSession";
import { type Lang, registerTranslations, translate } from "./i18n";
import { apiErrorMessage } from "./apiErrors";
import { useLang } from "./useLang";

registerTranslations({
  ar: { "fav.load_failed": "تعذّر تحميل المفضلة", "fav.update_failed": "تعذّر تحديث المفضلة" },
  en: { "fav.load_failed": "Couldn't load your favourites", "fav.update_failed": "Couldn't update your favourites" },
});

/** TB-25: a favourites failure in the interface language (never the server's own text). */
function favoritesErrorText(failure: unknown, lang: Lang, fallbackKey: string): string | null {
  if (failure === null || failure === undefined) return null;
  return failure instanceof ApiError ? apiErrorMessage(failure, lang) : translate(lang, fallbackKey);
}

interface FavoriteDto {
  id: string;
  target_type: "PRODUCT" | "OFFER";
  canonical_product_id: string | null;
}

/** Where a signed-out visitor goes to sign in, coming back to `returnPath`
 * (TB-34: built and checked by lib/loginRedirect.ts only). */
export function loginHref(returnPath: string): string {
  return safeLoginHref(returnPath);
}

/** What a heart needs from a product (a listing card or the compare page). */
type FavoriteTarget = Pick<ComparisonCardDto, "canonical_product_id">;

/**
 * The product hearts of the department listings (/men, /women, /kids)
 * and the compare page:
 * the signed-in user's PRODUCT favourites, add/remove with an immediate
 * heart update. Any signed-in account - customer, branch employee or
 * store owner - favourites as a shopper. Only a visitor without a token
 * is sent to /login, and only when they press a heart. A token the
 * server no longer accepts (401) is cleared - silently while browsing,
 * then sign-in on an action - so the header never shows a dead session.
 */
export function useProductFavorites(returnPath: string) {
  const router = useRouter();
  const token = useSessionToken();
  // Keyed by token: another account (or signing out) never shows the
  // previous account's hearts.
  const [state, setState] = useState<{
    token: string;
    rows: FavoriteDto[] | null;
    error: unknown;
  } | null>(null);
  const [favoritePendingIds, setFavoritePendingIds] = useState<Set<string>>(new Set());
  const [favoriteFailure, setFavoriteError] = useState<unknown>(null);
  const lang = useLang();

  const current = state?.token === token ? state : null;
  const favoriteRows = useMemo(() => current?.rows ?? [], [current]);
  const favoriteLoadError = favoritesErrorText(current?.error ?? null, lang, "fav.load_failed");
  const favoriteError = favoritesErrorText(favoriteFailure, lang, "fav.update_failed");
  const favoritesLoading = Boolean(token) && !current;
  const favoriteIds = useMemo(
    () =>
      new Set(
        favoriteRows.flatMap((favorite) =>
          favorite.target_type === "PRODUCT" && favorite.canonical_product_id ? [favorite.canonical_product_id] : [],
        ),
      ),
    [favoriteRows],
  );

  const sessionExpired = useCallback(() => {
    clearSession();
    router.push(loginHref(returnPath));
  }, [router, returnPath]);

  const load = useCallback(
    async (forToken: string) => {
      try {
        const rows = await apiFetch<FavoriteDto[]>("/favorites");
        // Keyed by token, so a reply for an account that has since
        // signed out is simply never shown.
        setState({ token: forToken, rows, error: null });
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          sessionExpired();
          return;
        }
        setState({
          token: forToken,
          rows: null,
          error: error ?? new Error("favourites failed"),
        });
      }
    },
    [sessionExpired],
  );

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    apiFetch<FavoriteDto[]>("/favorites")
      .then((rows) => {
        if (!cancelled) setState({ token, rows, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // Only browsing: the visitor quietly becomes a guest; an action
        // (a heart) is what sends them to sign in.
        if (error instanceof ApiError && error.status === 401) {
          clearSession();
          return;
        }
        setState({ token, rows: null, error: error ?? new Error("favourites failed") });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function toggleFavorite(card: FavoriteTarget) {
    if (!token) {
      router.push(loginHref(returnPath));
      return;
    }
    const id = card.canonical_product_id;
    if (favoritesLoading || favoritePendingIds.has(id)) return;
    setFavoriteError(null);
    setFavoritePendingIds((previous) => new Set(previous).add(id));
    try {
      // A failed first load is retried here rather than leaving the heart dead.
      const rows = favoriteLoadError ? await apiFetch<FavoriteDto[]>("/favorites") : favoriteRows;
      const existing = rows.find((favorite) => favorite.target_type === "PRODUCT" && favorite.canonical_product_id === id);
      if (existing) {
        await apiFetch(`/favorites/${existing.id}`, { method: "DELETE" });
        // Functional update: a concurrent toggle of another card keeps its result.
        setState((previous) =>
          previous?.token === token
            ? { token, rows: (previous.rows ?? rows).filter((favorite) => favorite.id !== existing.id), error: null }
            : previous,
        );
      } else {
        await apiFetch("/favorites", {
          method: "POST",
          body: { target_type: "PRODUCT", canonical_product_id: id },
        });
        await load(token);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        sessionExpired();
        return;
      }
      setFavoriteError(error ?? new Error("favourites update failed"));
    } finally {
      setFavoritePendingIds((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
    }
  }

  // A stable callback, so the memoized cards don't re-render on every
  // page append - and never run a stale toggle that still sees the
  // pre-hydration (signed-out) token.
  const toggleRef = useRef(toggleFavorite);
  useLayoutEffect(() => {
    toggleRef.current = toggleFavorite;
  });
  const onToggleFavorite = useCallback((card: FavoriteTarget) => toggleRef.current(card), []);

  return { favoriteIds, favoritePendingIds, favoritesLoading, favoriteLoadError, favoriteError, onToggleFavorite };
}
