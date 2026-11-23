"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useRef, useState } from "react";
import AuthField from "@/components/AuthField";
import AuthLogo from "@/components/AuthLogo";
import { MessageCodeIcon, PhoneIcon } from "@/components/AuthIcons";
import PasswordInput from "@/components/PasswordInput";
import { ErrorBanner } from "@/components/States";
import { normalisePhone } from "@/lib/address";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiErrors";
import { fillJt } from "@/lib/joinTeamText";
import type { WorkspaceInfo } from "@/lib/nav";
import { getSessionToken, setSessionToken } from "@/lib/session";
import { useLang, useT } from "@/lib/useLang";
import { enterWorkspaceNow } from "@/lib/workspaceActions";
import styles from "../auth-pages.module.css";

interface AcceptResponse {
  vendor_id: string;
  branch_id: string;
  role: "BRANCH_EMPLOYEE";
  session_token: string | null;
}
type Done =
  | { kind: "named"; vendorId: string; branchId: string; store: string; branch: string }
  | { kind: "other_account" }
  | { kind: "plain" };

const KNOWN = [
  "OTP_INVALID",
  "OTP_EXPIRED",
  "OTP_SUPERSEDED",
  "PHONE_NOT_VERIFIED",
  "STAFF_INVITE_NOT_FOUND",
  "PASSWORD_REQUIRED",
  "EMPLOYEE_ALREADY_ASSIGNED",
  "ALREADY_VENDOR_MEMBER",
  "BRANCH_NOT_AVAILABLE_FOR_STAFF",
];

/**
 * «انضمام إلى فريق متجر» (2026-11-23): a branch employee accepts the invite
 * the owner sent (the invite itself texted her the code) over the EXISTING
 * APIs - POST /auth/otp/verify (purpose staff_invite) for a one-time
 * verification token, then POST /auth/staff-invites/accept { phone,
 * verification_token, password? } (a password only creates a new account;
 * an existing account is simply given the role). No session is needed.
 * Nothing about the store or the branch is shown before the code is
 * verified and the invite accepted - the names come from the signed-in
 * account's own workspaces afterwards. A wrong code and a wrong phone read
 * the same. «إرسال رمز جديد» is the existing POST /auth/otp/request, which
 * answers the same whether an invite exists or not.
 */
export default function JoinTeamPage() {
  const router = useRouter();
  const t = useT();
  const lang = useLang();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [entering, setEntering] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const errorText = (err: unknown) => {
    const c = err instanceof ApiError ? err.code : "";
    return KNOWN.includes(c) ? t(`jt.err.${c}`) : apiErrorMessage(err, lang);
  };

  async function resend() {
    setError(null);
    setNotice(null);
    if (!phone.trim()) return setError(t("jt.need_phone"));
    setBusy(true);
    try {
      await apiFetch("/auth/otp/request", { method: "POST", auth: false, body: { phone: normalisePhone(phone), purpose: "staff_invite" } });
      setNotice(t("jt.resent"));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function accept(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!phone.trim()) return setError(t("jt.need_phone"));
    if (!/^\d{6}$/.test(code.trim())) return setError(t("jt.need_code"));
    setBusy(true);
    try {
      const p = normalisePhone(phone);
      const verified = await apiFetch<{ session_token: string }>("/auth/otp/verify", {
        method: "POST",
        auth: false,
        idempotencyKey: newIdempotencyKey("join-verify"),
        body: { phone: p, otp_code: code.trim(), purpose: "staff_invite" },
      });
      const res = await apiFetch<AcceptResponse>("/auth/staff-invites/accept", {
        method: "POST",
        auth: false,
        idempotencyKey: newIdempotencyKey("join-accept"),
        body: { phone: p, verification_token: verified.session_token, ...(password ? { password } : {}) },
      });
      // the names: only now, from the signed-in account's own workspaces
      const before = getSessionToken();
      if (!before && res.session_token) setSessionToken(res.session_token);
      let entry: Extract<WorkspaceInfo, { type: "vendor" }> | undefined;
      if (getSessionToken()) {
        try {
          const ws = await apiFetch<{ workspaces: WorkspaceInfo[] }>("/me/workspaces");
          entry = ws.workspaces.find((w): w is Extract<WorkspaceInfo, { type: "vendor" }> => w.type === "vendor" && w.vendor_id === res.vendor_id);
        } catch {
          entry = undefined;
        }
      }
      setDone(
        entry
          ? { kind: "named", vendorId: res.vendor_id, branchId: res.branch_id, store: entry.vendor_legal_name, branch: entry.branch_name ?? "" }
          : before
            ? { kind: "other_account" }
            : { kind: "plain" },
      );
      setCode("");
      setPassword("");
      window.requestAnimationFrame(() => headingRef.current?.focus());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function enter() {
    if (done?.kind !== "named") return;
    setEntering(true);
    try {
      await enterWorkspaceNow({ type: "vendor", vendor_id: done.vendorId });
      router.push(`/vendor/${done.vendorId}/branches/${done.branchId}/orders`);
    } catch (err) {
      setError(errorText(err));
      setEntering(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card} data-testid="join-team">
        <AuthLogo />
        <div className={styles.header}>
          <h1 ref={headingRef} tabIndex={-1}>{t("jt.title")}</h1>
          {!done && <p>{t("jt.lead")}</p>}
        </div>

        {error && <ErrorBanner message={error} />}
        {notice && <p className={styles.helperText} role="status" data-testid="join-notice">{notice}</p>}

        {done ? (
          <div className="notice-banner" role="status" data-testid="join-done">
            {done.kind === "named" ? (
              <>
                <strong>{fillJt(t("jt.done"), { store: done.store, branch: done.branch })}</strong>
                <div style={{ marginTop: 10 }}>
                  <button type="button" className={styles.button} onClick={() => void enter()} disabled={entering} data-testid="join-enter">
                    <span className={styles.buttonArrow}>←</span>
                    {t("jt.enter")}
                  </button>
                </div>
              </>
            ) : done.kind === "other_account" ? (
              <>
                <strong>{t("jt.done_plain")}</strong> <span>{t("jt.other_account")}</span>
              </>
            ) : (
              <>
                <strong>{t("jt.done_plain")}</strong> <span>{t("jt.login_hint")}</span>{" "}
                <Link href="/login" data-testid="join-login">{t("jt.login")}</Link>
              </>
            )}
          </div>
        ) : (
          <form onSubmit={(e) => void accept(e)} noValidate data-testid="join-form">
            <div className={styles.fields}>
              <AuthField
                id="jt-phone"
                label={t("jt.phone")}
                icon={<PhoneIcon />}
                ltr
                type="tel"
                autoComplete="tel"
                placeholder="+970 59 XXX XXXX"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                data-testid="join-phone"
              />
              <AuthField
                id="jt-code"
                label={t("jt.code")}
                icon={<MessageCodeIcon />}
                ltr
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                data-testid="join-code"
              />
              <PasswordInput
                id="jt-password"
                label={t("jt.password")}
                value={password}
                onChange={setPassword}
                autoComplete="new-password"
                minLength={8}
                placeholder=""
              />
              <p className={styles.helperText} id="jt-password-hint">{t("jt.password_hint")}</p>
            </div>
            <button className={styles.button} type="submit" disabled={busy} aria-busy={busy} data-testid="join-submit">
              <span className={styles.buttonArrow}>←</span>
              {busy ? t("jt.submitting") : t("jt.submit")}
            </button>
            <div className={styles.linkRow}>
              <button type="button" className="button-link" onClick={() => void resend()} disabled={busy} data-testid="join-resend">
                {t("jt.resend")}
              </button>
            </div>
          </form>
        )}

        <div className={styles.linkRow}>
          <Link href="/login">{t("jt.back_login")}</Link>
        </div>
      </div>
    </div>
  );
}
