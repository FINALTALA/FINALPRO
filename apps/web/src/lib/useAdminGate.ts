"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import type { PlatformRoleName } from "./nav";
import { useHydrated, useSessionToken, useWorkspacesResult } from "./useSession";
import { loginRedirectHref } from "@/lib/loginRedirect";

export type AdminGateState =
  | { status: "loading" }
  | { status: "forbidden" }
  | { status: "ok"; role: PlatformRoleName };

/** TB-16.1: the gate's state for a page that asked to see read failures. */
export type AdminGateStateWithError = AdminGateState | { status: "error"; error: unknown };

/**
 * Sprint 16: UX gate for the /admin pages. It only decides what to SHOW
 * (skeleton, forbidden message, or the page) - every /admin API call is
 * authorized by PlatformRoleGuard on the server, so a user who bypasses
 * this gate simply gets 403 from the API.
 *
 * `require: "ADMIN"` is for pages only a PLATFORM_ADMIN may use; a
 * VERIFICATION_REVIEWER then sees the forbidden state.
 *
 * TB-16.1: a 401 on the workspaces read clears the session, which sends
 * the user to sign in (below). With `{ reportErrors: true }` any other
 * failure (429, 5xx, network) is returned as `error` - never as
 * "forbidden". Without it (every other admin page, unchanged for now) such
 * a failure still reads as "forbidden".
 */
export function useAdminGate(require?: "ANY" | "ADMIN"): AdminGateState;
export function useAdminGate(
  require: "ANY" | "ADMIN",
  options: { reportErrors: true },
): AdminGateStateWithError;
export function useAdminGate(
  require: "ANY" | "ADMIN" = "ANY",
  options?: { reportErrors?: boolean },
): AdminGateStateWithError {
  const router = useRouter();
  const pathname = usePathname();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const result = useWorkspacesResult(token);

  useEffect(() => {
    if (hydrated && !token) {
      router.replace(loginRedirectHref());
    }
  }, [hydrated, token, pathname, router]);

  if (!hydrated || !token || result.status === "loading") return { status: "loading" };
  if (result.status === "error") {
    return options?.reportErrors ? { status: "error", error: result.error } : { status: "forbidden" };
  }
  const platform = result.list.find((w) => w.type === "platform");
  if (!platform || platform.type !== "platform") return { status: "forbidden" };
  if (require === "ADMIN" && platform.role !== "PLATFORM_ADMIN") {
    return { status: "forbidden" };
  }
  return { status: "ok", role: platform.role };
}
