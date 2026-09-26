"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import type { PlatformRoleName } from "./nav";
import { useHydrated, useSessionToken, useWorkspaces } from "./useSession";

export type AdminGateState =
  | { status: "loading" }
  | { status: "forbidden" }
  | { status: "ok"; role: PlatformRoleName };

/**
 * Sprint 16: UX gate for the /admin pages. It only decides what to SHOW
 * (skeleton, forbidden message, or the page) - every /admin API call is
 * authorized by PlatformRoleGuard on the server, so a user who bypasses
 * this gate simply gets 403 from the API.
 *
 * `require: "ADMIN"` is for pages only a PLATFORM_ADMIN may use; a
 * VERIFICATION_REVIEWER then sees the forbidden state.
 */
export function useAdminGate(require: "ANY" | "ADMIN" = "ANY"): AdminGateState {
  const router = useRouter();
  const pathname = usePathname();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const workspaces = useWorkspaces(token);

  useEffect(() => {
    if (hydrated && !token) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
  }, [hydrated, token, pathname, router]);

  if (!hydrated || !token || workspaces === null) return { status: "loading" };
  const platform = workspaces.find((w) => w.type === "platform");
  if (!platform || platform.type !== "platform") return { status: "forbidden" };
  if (require === "ADMIN" && platform.role !== "PLATFORM_ADMIN") {
    return { status: "forbidden" };
  }
  return { status: "ok", role: platform.role };
}
