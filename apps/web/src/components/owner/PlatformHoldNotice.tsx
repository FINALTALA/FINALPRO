"use client";

import "@/lib/offerModerationText";
import { useCallback, useEffect, useState } from "react";
import { apiFetch, ApiError, newIdempotencyKey } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiErrors";
import { fill } from "@/lib/offerModerationText";
import { useLang, useT } from "@/lib/useLang";

// VIA phase 2C: the store owner's view of a platform hold on one product -
// the reason, and (for «changes requested») submitting the CURRENT content
// revision as the correction. Editing and republishing stay on the existing
// screens; neither lifts the hold. Renders nothing when there is no hold or
// the hold read is unavailable.

interface OwnerHold {
  id: string;
  action: "HIDE" | "REQUEST_CHANGES";
  reason: string;
  placed_at: string;
  current_revision: number;
  can_submit_correction: boolean;
  correction: { revision: number; note: string | null; submitted_at: string; stale: boolean } | null;
  last_return: { note: string; returned_at: string } | null;
}

export default function PlatformHoldNotice({ vendorId, offerId }: { vendorId: string; offerId: string }) {
  const t = useT();
  const lang = useLang();
  const [hold, setHold] = useState<OwnerHold | null>(null);
  const [nonce, setNonce] = useState(0);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ hold: OwnerHold | null }>(`/vendors/${vendorId}/offers/${offerId}/platform-hold`)
      .then((r) => {
        if (!cancelled) setHold(r.hold);
      })
      .catch(() => {
        if (!cancelled) setHold(null);
      });
    return () => {
      cancelled = true;
    };
  }, [vendorId, offerId, nonce]);

  const submit = useCallback(async () => {
    if (!hold) return;
    setBusy(true);
    setMessage(null);
    try {
      await apiFetch(`/vendors/${vendorId}/offers/${offerId}/platform-hold/correction`, {
        method: "POST",
        body: { offer_revision: hold.current_revision, ...(note.trim() ? { note: note.trim() } : {}) },
        idempotencyKey: newIdempotencyKey("hold-correction"),
      });
      setNote("");
      setMessage({ tone: "ok", text: t("ph.sent") });
      setNonce((n) => n + 1);
    } catch (err) {
      const changed = err instanceof ApiError && err.code === "OFFER_REVISION_CHANGED";
      setMessage({ tone: "error", text: changed ? t("ph.changed") : apiErrorMessage(err, lang) });
      if (changed) setNonce((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }, [hold, vendorId, offerId, note, t, lang]);

  if (!hold) return null;
  const time = (iso: string) =>
    new Date(iso).toLocaleString(lang === "ar" ? "ar" : "en-GB", { dateStyle: "medium", timeStyle: "short" });

  return (
    <section className="warning-banner platform-hold-notice" role="status" data-testid="platform-hold-notice" style={{ maxWidth: 720 }}>
      <strong style={{ display: "block", fontSize: 16 }}>{t(`ph.title.${hold.action}`)}</strong>
      <p style={{ margin: "6px 0" }}>{t(`ph.lead.${hold.action}`)}</p>
      <p style={{ margin: "6px 0" }}>
        <strong>{t("ph.reason")}:</strong> {hold.reason}
        <span style={{ opacity: 0.75 }}> · {fill(t("ph.since"), { time: time(hold.placed_at) })}</span>
      </p>
      {hold.last_return && <p style={{ margin: "6px 0" }}>{fill(t("ph.returned"), { note: hold.last_return.note })}</p>}
      {hold.correction && !hold.correction.stale && (
        <p style={{ margin: "6px 0" }} data-testid="platform-hold-submitted">
          {fill(t("ph.submitted"), { rev: hold.correction.revision })}
        </p>
      )}
      {hold.correction?.stale && <p style={{ margin: "6px 0" }}>{t("ph.stale")}</p>}
      {hold.can_submit_correction && (!hold.correction || hold.correction.stale) && (
        <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor={`ph-note-${offerId}`}>{t("ph.note")}</label>
            <input
              id={`ph-note-${offerId}`}
              type="text"
              maxLength={1000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <div>
            <button type="button" className="button" disabled={busy} onClick={() => void submit()} data-testid="platform-hold-submit">
              {busy ? t("ph.submitting") : t("ph.submit")}
            </button>
          </div>
        </div>
      )}
      {message && (
        <p style={{ margin: "8px 0 0", fontWeight: 700 }} role={message.tone === "error" ? "alert" : "status"}>
          {message.text}
        </p>
      )}
    </section>
  );
}
