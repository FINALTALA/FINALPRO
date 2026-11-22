"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiErrors";
import "@/lib/offerWizardText";
import { useLang, useT } from "@/lib/useLang";
import { IconEdit } from "./wizardIcons";

/** What the button needs to know about a product (GET .../offers). */
export interface EditableOffer {
  id: string;
  status: "DRAFT" | "ACTIVE" | "INACTIVE" | "ARCHIVED";
  /** classified (it has the wizard's audience / category / sizes) */
  price_is_offer_level?: boolean;
  /** published and classified: its content changes only through «تعديل المنتج» */
  edit_via_draft?: boolean;
}

/**
 * Edit drafts: «تعديل المنتج» opens the product's one shared edit draft (the
 * same draft for the whole store team) in the wizard. An unclassified
 * product keeps its direct editing and says why the wizard is not offered;
 * a product never published is completed on its own page as before.
 */
export function EditProductButton({
  vendorId,
  offer,
  onOpen,
  className = "button-link",
}: {
  vendorId: string;
  offer: EditableOffer;
  onOpen: (draftId: string) => void;
  className?: string;
}) {
  const t = useT();
  const lang = useLang();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (offer.status === "ARCHIVED") return null;
  if (!offer.price_is_offer_level) {
    return (
      <span className="muted wz-edit-classify" data-testid={`offer-edit-classify-${offer.id}`}>
        {t("edit.classify_first")}
      </span>
    );
  }
  if (!offer.edit_via_draft) return null;

  async function open() {
    setBusy(true);
    setError(null);
    try {
      const d = await apiFetch<{ id: string }>(`/vendors/${vendorId}/offer-drafts/edit-of/${offer.id}`, { method: "POST" });
      onOpen(d.id);
    } catch (err) {
      setError(apiErrorMessage(err, lang === "en" ? "en" : "ar"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className={className} disabled={busy} onClick={() => void open()} title={t("edit.button")} data-testid={`offer-edit-${offer.id}`}>
        <IconEdit /> <span className="owner-label">{busy ? t("edit.opening") : t("edit.button")}</span>
      </button>
      {error && (
        <span className="error-text" role="alert">
          {" "}
          {error}
        </span>
      )}
    </>
  );
}
