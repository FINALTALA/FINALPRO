"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { EmptyState } from "@/components/States";
import StoreSkeleton from "@/components/store/StoreSkeleton";
import { workspaceEntry } from "@/lib/nav";
import { useFetch } from "@/lib/useFetch";
import { useHydrated, useSessionToken, useWorkspaces } from "@/lib/useSession";
import { loginRedirectHref } from "@/lib/loginRedirect";

interface OwnerStorefrontDto {
  slug: string;
  display_name: string;
  is_published: boolean;
}

// The owner's public storefront is now the management entry point. The
// management cards appear only after the owner opens its in-page control;
// this route remains as a safe redirect for old links and bookmarks.
export default function OwnerHubPage() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const workspaces = useWorkspaces(token);
  const membership = workspaces?.find(
    (w) => w.type === "vendor" && w.vendor_id === params.vendorId,
  );
  const isOwner = membership?.type === "vendor" && membership.role === "OWNER";
  const storefront = useFetch<OwnerStorefrontDto>(
    isOwner ? `/vendors/${params.vendorId}/storefront` : null,
    true,
  );
  useEffect(() => {
    if (!hydrated) return;
    if (!token) {
      router.replace(loginRedirectHref());
      return;
    }
    if (membership?.type === "vendor" && membership.role === "BRANCH_EMPLOYEE") {
      router.replace(workspaceEntry(membership).href);
    }
  }, [hydrated, token, membership, params.vendorId, router]);

  useEffect(() => {
    if (isOwner && storefront.data) {
      router.replace(`/store/${storefront.data.slug}`);
    }
  }, [isOwner, router, storefront.data]);

  // 2026-11-24: the wait looks like the store page it opens (its own
  // skeleton, no other header) - never the legacy bar or an empty page
  if (!hydrated || !token || workspaces === null) return <StoreSkeleton />;

  if (!membership) {
    return (
      <div className="page-shell">
        <EmptyState title="لا تملكين صلاحية على هذا المتجر" actionHref="/account" actionLabel="حسابي" />
      </div>
    );
  }
  if (!isOwner) {
    return (
      <div className="page-shell">
        <p className="muted">جارٍ التحويل إلى طلبات فرعك...</p>
      </div>
    );
  }

  return <StoreSkeleton />;
}
