"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect } from "react";
import { isUnauthorized } from "./apiErrors";
import { loginRedirectHref } from "./loginRedirect";
import { clearSession } from "./session";
import { useHydrated, useSessionToken } from "./useSession";

/**
 * TB-34 for a page that needs a session: with none, it goes to sign-in
 * with `next` = this page (and its query); the returned function does the
 * same for a 401 from any of the page's calls (the session is cleared as
 * lost) and says whether it did. Any other failure is left to the page.
 */
export function useSignInGuard(): (err: unknown) => boolean {
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  useEffect(() => {
    if (hydrated && !token) router.replace(loginRedirectHref());
  }, [hydrated, token, router]);
  return useCallback(
    (err: unknown) => {
      if (!isUnauthorized(err)) return false;
      clearSession();
      router.replace(loginRedirectHref());
      return true;
    },
    [router],
  );
}
