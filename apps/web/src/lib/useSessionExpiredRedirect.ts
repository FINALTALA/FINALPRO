"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { loginRedirectHref } from "./loginRedirect";
import { clearSession } from "./session";

/**
 * TB-16.1 / TB-34: what a page does with a 401 - the stored session is no
 * longer valid, so it is cleared and the user is sent to sign in, coming
 * back to this same page with its query (`next`, built and checked only by
 * lib/loginRedirect.ts). No error text is shown.
 */
export function useSessionExpiredRedirect(): () => void {
  const router = useRouter();
  return useCallback(() => {
    clearSession();
    router.replace(loginRedirectHref());
  }, [router]);
}
