"use client";

import { apiFetch } from "./api";
import { rememberWorkspace, type WorkspaceRef } from "./workspaceSession";

/**
 * TB-26: enters a workspace in this tab - the API issues a workspace token
 * (after checking the membership / platform role) and it is kept in the
 * tab's sessionStorage. Used by the explicit choices only: the entry
 * confirmation page's button, the confirmation panel of «إدارة هذا المتجر»
 * on the public store page (phase A+), and a workspace card in «حسابي» /
 * the account menu (choosing a card IS the explicit step). A direct link
 * to a workspace page goes through the confirmation page.
 */
export async function enterWorkspaceNow(ref: WorkspaceRef): Promise<void> {
  const res = await apiFetch<{ workspace_token: string }>("/me/workspace-sessions", {
    method: "POST",
    body: ref.type === "platform" ? { type: "platform" } : { type: "vendor", vendor_id: ref.vendor_id },
  });
  rememberWorkspace(ref, res.workspace_token);
}
