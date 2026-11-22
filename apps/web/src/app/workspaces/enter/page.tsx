"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiErrors";
import type { WorkspaceInfo } from "@/lib/nav";
import { useLang, useT } from "@/lib/useLang";
import { useHydrated, useSessionToken, useWorkspacesResult } from "@/lib/useSession";
import { hasWorkspace, rememberWorkspace, safeWorkspaceNext, type WorkspaceRef } from "@/lib/workspaceSession";
import "@/lib/workspaceText";
import { loginRedirectHref } from "@/lib/loginRedirect";

// TB-26: the one door into a store workspace or the platform workspace.
// Nothing enters on its own - not signing in, not «إدارة هذا المتجر», not a
// direct link, not the back button: each lands here first and only the
// explicit button below asks the API for a workspace token (kept in this
// tab only). `next` is followed only when it is a same-site page of that
// workspace (safeWorkspaceNext); anything else goes to the workspace home.
export default function EnterWorkspacePage() {
  return (
    <Suspense fallback={<div className="page-shell"><div className="skeleton" style={{ height: 160, maxWidth: 560 }} /></div>}>
      <EnterWorkspace />
    </Suspense>
  );
}

function refFromQuery(type: string | null, vendorId: string | null): WorkspaceRef | null {
  if (type === "platform") return { type: "platform" };
  if (type === "vendor" && vendorId) return { type: "vendor", vendor_id: vendorId };
  return null;
}

function EnterWorkspace() {
  const router = useRouter();
  const search = useSearchParams();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const t = useT();
  const lang = useLang();
  const ref = refFromQuery(search.get("type"), search.get("vendor_id"));
  const rawNext = search.get("next");
  const result = useWorkspacesResult(token);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const here = `/workspaces/enter?${search.toString()}`;
  useEffect(() => {
    if (hydrated && !token) router.replace(loginRedirectHref());
  }, [hydrated, token, here, router]);

  const membership: WorkspaceInfo | undefined =
    result.status === "ok" && ref
      ? result.list.find((w) =>
          ref.type === "platform"
            ? w.type === "platform"
            : w.type === "vendor" && w.vendor_id === ref.vendor_id,
        )
      : undefined;
  const slug = membership?.type === "vendor" ? membership.storefront_slug : null;
  const target = ref ? safeWorkspaceNext(rawNext, ref, slug) : "/";

  // Already entered in this tab (e.g. a reload of this page): continue.
  const alreadyIn = hydrated && ref ? hasWorkspace(ref) : false;
  useEffect(() => {
    if (alreadyIn && membership) router.replace(target);
  }, [alreadyIn, membership, target, router]);

  async function enter() {
    if (!ref) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ workspace_token: string }>("/me/workspace-sessions", {
        method: "POST",
        body: ref.type === "platform" ? { type: "platform" } : { type: "vendor", vendor_id: ref.vendor_id },
      });
      rememberWorkspace(ref, res.workspace_token);
      router.replace(target);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const shell = (body: React.ReactNode) => (
    <div className="page-shell workspace-enter-page">
      <section className="card workspace-enter-card" aria-labelledby="ws-enter-title">
        {body}
      </section>
    </div>
  );

  if (!hydrated || !token || result.status === "loading" || (alreadyIn && membership)) {
    return shell(<p className="muted">{t("ws.enter.loading")}</p>);
  }
  if (result.status === "error") {
    // TB-16 rule: the failure's own words in the page language (a rate
    // limit says "wait and retry", never "no access").
    return shell(
      <>
        <p className="error-banner" role="alert">{apiErrorMessage(result.error, lang) || t("ws.enter.load_failed")}</p>
        <Link href="/" className="btn">{t("ws.enter.cancel")}</Link>
      </>,
    );
  }
  if (!ref || !membership) {
    return shell(
      <>
        <p role="alert" data-testid="ws-enter-no-access">{t("ws.enter.no_access")}</p>
        <Link href="/" className="btn">{t("ws.enter.cancel")}</Link>
      </>,
    );
  }
  if (membership.type === "vendor" && membership.status === "SUSPENDED") {
    return shell(
      <>
        <p role="alert">{t("ws.enter.suspended")}</p>
        <Link href="/" className="btn">{t("ws.enter.cancel")}</Link>
      </>,
    );
  }

  const name = membership.type === "vendor" ? membership.vendor_legal_name : null;
  const role = membership.type === "vendor" ? membership.role : membership.type === "platform" ? membership.role : null;
  return shell(
    <>
      <h1 id="ws-enter-title">{t(ref.type === "platform" ? "ws.enter.title.platform" : "ws.enter.title.vendor")}</h1>
      {name && <p className="workspace-enter-name" data-testid="ws-enter-name">{name}</p>}
      {role && <p className="muted">{t(`ws.enter.role.${role}`)}</p>}
      {membership.type === "vendor" && membership.branch_name && (
        <p className="muted">{t("ws.enter.branch").replace("{name}", membership.branch_name)}</p>
      )}
      <p>{t("ws.enter.lead")}</p>
      {error !== null && <p role="alert" className="error-text">{apiErrorMessage(error, lang) || t("ws.enter.failed")}</p>}
      <div className="workspace-enter-actions">
        <button type="button" className="btn btn-primary" onClick={enter} disabled={busy} data-testid="ws-enter-confirm">
          {busy ? t("ws.enter.entering") : t("ws.enter.confirm")}
        </button>
        <Link href="/" className="btn" data-testid="ws-enter-cancel">{t("ws.enter.cancel")}</Link>
      </div>
    </>,
  );
}
