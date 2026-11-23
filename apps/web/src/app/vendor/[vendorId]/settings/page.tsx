"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useBranchWorkspace } from "@/components/owner/BranchWorkspace";
import { EmptyState } from "@/components/States";
import DeliveryZonesSection from "@/components/store-settings/DeliveryZonesSection";
import ReturnPolicySection from "@/components/store-settings/ReturnPolicySection";
import { loginRedirectHref } from "@/lib/loginRedirect";
import "@/lib/storeSettingsText";
import { useT } from "@/lib/useLang";

const STORE_SETTINGS_SECTIONS = ["delivery", "returns"] as const;

/**
 * «إعدادات المتجر» (owner only): what applies to EVERY branch - delivery
 * zones and fees (with a zone's own minimum) and the return policy. Opened
 * from the gear by the «إدارة الفروع» title; the old store-level addresses
 * (/delivery-zones, /return-policy) open it at their section. Each section
 * keeps its own save (they are separate settings).
 */
export default function StoreSettingsPage() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const t = useT();
  const ws = useBranchWorkspace(params.vendorId);

  useEffect(() => {
    if (ws.hydrated && !ws.token) router.replace(loginRedirectHref());
  }, [ws.hydrated, ws.token, router]);

  // an old address / a jump link: bring its section into view and focus it
  useEffect(() => {
    if (!ws.ready || !ws.isOwner) return;
    const id = window.location.hash.slice(1);
    if (!(STORE_SETTINGS_SECTIONS as readonly string[]).includes(id)) return;
    const h = window.setTimeout(() => {
      const el = document.getElementById(id);
      el?.scrollIntoView({ block: "start" });
      el?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(h);
  }, [ws.ready, ws.isOwner]);

  if (!ws.ready)
    return (
      <div className="page-shell">
        <div
          className="skeleton"
          style={{ height: 200, width: "100%", maxWidth: 900 }}
        />
      </div>
    );
  if (!ws.isOwner)
    return (
      <div className="page-shell">
        <EmptyState title={t("ss.owner_only")} />
      </div>
    );

  return (
    <div className="page-shell sst-shell">
      <div className="br-ws br-dash sst-page-wrap" data-testid="store-settings">
        <header className="sst-head">
          <h1 className="sst-title">{t("ss.title")}</h1>
          <p className="muted sst-page-lead">{t("ss.lead")}</p>
          <nav className="sst-jump" aria-label={t("ss.jump")}>
            <a href="#delivery" data-testid="ss-jump-delivery">
              {t("ss.delivery")}
            </a>
            <a href="#returns" data-testid="ss-jump-returns">
              {t("ss.returns")}
            </a>
          </nav>
        </header>
        <div className="br-pane sst-pane">
          <DeliveryZonesSection vendorId={params.vendorId} />
          <ReturnPolicySection vendorId={params.vendorId} />
        </div>
      </div>
    </div>
  );
}
