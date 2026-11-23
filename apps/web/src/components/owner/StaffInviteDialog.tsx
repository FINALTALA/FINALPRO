"use client";

import { useRef, useState } from "react";
import DwDialog from "@/components/branch-delivery/DwDialog";
import "@/components/branch-delivery/deliveryBoard.css";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { apiErrorMessage, isUnauthorized } from "@/lib/apiErrors";
import { branchLabel, fillSt } from "@/lib/staffText";
import { useLang, useT } from "@/lib/useLang";
import { useSessionExpiredRedirect } from "@/lib/useSessionExpiredRedirect";

export interface StaffInviteDto {
  id: string;
  vendor_id: string;
  branch_id: string;
  phone: string;
  status: string;
  expires_at: string;
}
/** The invite API's own refusals, in words the owner can act on. */
const KNOWN = ["ALREADY_VENDOR_MEMBER", "EMPLOYEE_ALREADY_ASSIGNED", "STAFF_INVITE_ALREADY_PENDING", "BRANCH_NOT_AVAILABLE_FOR_STAFF", "PHONE_INVALID"];

/**
 * «إضافة موظفة» (2026-11-23): the existing owner-only invite
 * (POST /vendors/:id/branches/:branchId/staff-invites, body { phone } only)
 * for the branch the dashboard shows - no second branch choice here: the
 * header's picker changes it. The API texts a verification code to that
 * phone; the invite is pending until accepted (7 days). A dialog on a
 * computer, a bottom sheet on a phone (DwDialog).
 */
export default function StaffInviteDialog({ vendorId, branchId, branchName, onClose, onSent }: {
  vendorId: string;
  branchId: string;
  branchName: string;
  onClose: () => void;
  onSent: (invite: StaffInviteDto) => void;
}) {
  const t = useT();
  const lang = useLang();
  const onExpired = useSessionExpiredRedirect();
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<StaffInviteDto | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = "st-invite-error";

  async function send() {
    setError(null);
    if (!phone.trim()) {
      setError(t("st.invite.phone_required"));
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const invite = await apiFetch<StaffInviteDto>(`/vendors/${vendorId}/branches/${branchId}/staff-invites`, {
        method: "POST",
        body: { phone: phone.trim() },
        idempotencyKey: newIdempotencyKey(`staff-invite-${branchId}`),
      });
      setSent(invite);
      onSent(invite);
    } catch (err) {
      if (isUnauthorized(err)) return onExpired();
      const code = err instanceof ApiError ? err.code : "";
      setError(KNOWN.includes(code) ? t(`st.invite.err.${code}`) : apiErrorMessage(err, lang));
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  const until = (iso: string) => new Date(iso).toLocaleDateString(lang === "en" ? "en-GB" : "ar", { day: "numeric", month: "long", timeZone: "Asia/Hebron" });
  return (
    <DwDialog title={fillSt(t("st.invite.title"), { branch: branchLabel(branchName, lang) })} onClose={onClose} busy={busy} testId="st-invite-dialog">
      {sent ? (
        <div className="dw-form">
          <p className="notice-banner" role="status" data-testid="st-invite-sent">
            {fillSt(t("st.invite.sent"), { phone: `⁦${sent.phone}⁩`, branch: branchLabel(branchName, lang) })}{" "}
            {fillSt(t("st.invite.sent_until"), { date: until(sent.expires_at) })}
          </p>
          <div className="dw-dialog-actions">
            <button type="button" className="dw-btn" onClick={onClose} data-testid="st-invite-done">{t("st.invite.done")}</button>
          </div>
        </div>
      ) : (
        <form
          className="dw-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <p className="dw-muted">{t("st.invite.lead")}</p>
          {error && <div className="error-banner" role="alert" id={errorId} data-testid="st-invite-error">{error}</div>}
          <label className="dw-field">
            {t("st.invite.phone")}
            <input
              ref={inputRef}
              className="dw-input"
              type="tel"
              inputMode="tel"
              autoComplete="off"
              dir="ltr"
              placeholder="+97059…"
              value={phone}
              maxLength={20}
              disabled={busy}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(e) => setPhone(e.target.value)}
              data-testid="st-invite-phone"
            />
          </label>
          <div className="dw-dialog-actions">
            <button type="submit" className="dw-btn" disabled={busy} aria-busy={busy} data-testid="st-invite-send">{t("st.invite.send")}</button>
            <button type="button" className="dw-btn dw-btn-quiet" onClick={onClose} disabled={busy}>{t("st.invite.cancel")}</button>
          </div>
        </form>
      )}
    </DwDialog>
  );
}
