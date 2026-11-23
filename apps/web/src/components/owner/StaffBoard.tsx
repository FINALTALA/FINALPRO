"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useBranchWorkspace } from "@/components/owner/BranchWorkspace";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch, newIdempotencyKey } from "@/lib/api";
import { apiErrorMessage, isUnauthorized } from "@/lib/apiErrors";
import { branchLabel, fillSt } from "@/lib/staffText";
import { useLang, useT } from "@/lib/useLang";
import { useSessionExpiredRedirect } from "@/lib/useSessionExpiredRedirect";
import StaffInviteDialog from "./StaffInviteDialog";

interface StaffDto {
  id: string;
  phone: string;
  branch_id: string | null;
  branch_name: string | null;
  status: "ACTIVE" | "SUSPENDED";
}
/** GET /vendors/:id/staff-invites (owner only) - read only: there is no cancel or resend endpoint. */
interface InviteSummaryDto {
  id: string;
  branch_id: string;
  branch_name: string;
  phone: string;
  status: "PENDING" | "ACCEPTED";
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
}
interface BranchOptionDto {
  id: string;
  name: string;
  verification_status: string;
  archived_at: string | null;
}

/**
 * «الموظفون» - the owner's tab of «إدارة الفروع» (Sprint 18b G-IN-05 roster,
 * moved from its own store-level page on 2026-11-23, same API and rules):
 * this branch's employees by default, or every branch's (?scope=all, each
 * with its branch); move to another approved branch, suspend, reactivate.
 * Owner only - the API refuses anyone else (403) whatever this screen does.
 * The branch picker in the header changes «this branch».
 * «+ إضافة موظفة» invites to THAT branch (the existing invite endpoint);
 * pending invites are listed quietly (no cancel / resend exists yet).
 */
export default function StaffBoard({ vendorId, branchId }: { vendorId: string; branchId: string }) {
  const t = useT();
  const lang = useLang();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const ws = useBranchWorkspace(vendorId);
  const onExpired = useSessionExpiredRedirect();
  const urlAll = sp.get("scope") === "all";
  // the radios answer at once; the URL (the real state) follows a moment later
  const [pending, setPending] = useState<boolean | null>(null);
  if (pending !== null && pending === urlAll) setPending(null);
  const all = pending ?? urlAll;

  const [staff, setStaff] = useState<StaffDto[] | null>(null);
  const [branches, setBranches] = useState<BranchOptionDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [transferTarget, setTransferTarget] = useState<Record<string, string>>({});
  const [version, setVersion] = useState(0);
  const [invites, setInvites] = useState<InviteSummaryDto[] | null>(null);
  const [inviting, setInviting] = useState(false);
  const inviteOpenRef = useRef<HTMLButtonElement>(null);
  // closing the dialog gives the focus back to «+ إضافة موظفة»
  const closeInvite = () => {
    setInviting(false);
    window.requestAnimationFrame(() => inviteOpenRef.current?.focus());
  };
  const [now] = useState(() => Date.now());

  useEffect(() => {
    if (!ws.isOwner) return;
    let alive = true;
    Promise.all([
      apiFetch<StaffDto[]>(`/vendors/${vendorId}/staff`),
      apiFetch<BranchOptionDto[]>(`/vendors/${vendorId}/branches`),
      apiFetch<InviteSummaryDto[]>(`/vendors/${vendorId}/staff-invites`),
    ]).then(
      ([staffData, branchData, inviteData]) => {
        if (!alive) return;
        setError(null);
        setStaff(staffData);
        setBranches(branchData);
        setInvites(inviteData);
      },
      (err: unknown) => {
        if (!alive) return;
        if (isUnauthorized(err)) return onExpired();
        setError(apiErrorMessage(err, lang));
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorId, ws.isOwner, version, onExpired]);

  async function transfer(vendorUserId: string) {
    const target = transferTarget[vendorUserId];
    if (!target) {
      setError(t("st.pick_branch"));
      return;
    }
    setBusyId(vendorUserId);
    setError(null);
    try {
      await apiFetch(`/vendors/${vendorId}/staff/${vendorUserId}/transfer`, {
        method: "POST",
        body: { branch_id: target },
        idempotencyKey: newIdempotencyKey(`staff-transfer-${vendorUserId}`),
      });
      setVersion((v) => v + 1);
    } catch (err) {
      if (isUnauthorized(err)) return onExpired();
      setError(apiErrorMessage(err, lang));
    } finally {
      setBusyId(null);
    }
  }

  async function toggleSuspend(member: StaffDto) {
    const action = member.status === "ACTIVE" ? "suspend" : "reactivate";
    setBusyId(member.id);
    setError(null);
    try {
      await apiFetch(`/vendors/${vendorId}/staff/${member.id}/${action}`, {
        method: "POST",
        body: {},
        idempotencyKey: newIdempotencyKey(`staff-${action}-${member.id}`),
      });
      setVersion((v) => v + 1);
    } catch (err) {
      if (isUnauthorized(err)) return onExpired();
      setError(apiErrorMessage(err, lang));
    } finally {
      setBusyId(null);
    }
  }

  if (!ws.ready) return <div className="skeleton" style={{ height: 160, width: "100%" }} />;
  if (!ws.isOwner) return <EmptyState title={t("st.owner_only")} actionHref="/account" actionLabel={t("st.my_account")} />;

  const setScope = (toAll: boolean) => {
    setPending(toAll);
    router.replace(toAll ? `${pathname}?scope=all` : pathname, { scroll: false });
  };
  const eligibleBranches = (branches ?? []).filter((b) => b.verification_status === "APPROVED" && !b.archived_at);
  const shown = (staff ?? []).filter((m) => all || m.branch_id === branchId);
  const current = (branches ?? ws.branches ?? []).find((b) => b.id === branchId) ?? null;
  const pendingInvites = (invites ?? []).filter((i) => i.status === "PENDING" && (all || i.branch_id === branchId));
  const until = (iso: string) => new Date(iso).toLocaleDateString(lang === "en" ? "en-GB" : "ar", { day: "numeric", month: "long", timeZone: "Asia/Hebron" });

  return (
    <div className="st" data-testid="staff-board">
      <h2 className="visually-hidden">{t("st.title")}</h2>
      <div className="st-head">
      <fieldset className="st-scope" data-testid="st-scope">
        <legend className="visually-hidden">{t("st.scope")}</legend>
        <label className={`st-scope-opt${!all ? " is-on" : ""}`}>
          <input type="radio" name="st-scope" checked={!all} onChange={() => setScope(false)} data-testid="st-scope-branch" />
          <span>{t("st.scope.branch")}</span>
        </label>
        <label className={`st-scope-opt${all ? " is-on" : ""}`}>
          <input type="radio" name="st-scope" checked={all} onChange={() => setScope(true)} data-testid="st-scope-all" />
          <span>{t("st.scope.all")}</span>
        </label>
      </fieldset>
      {current && !current.archived_at && (
        <button ref={inviteOpenRef} type="button" className="st-invite-open" onClick={() => setInviting(true)} data-testid="st-invite-open">
          <span>{t("st.invite.open")}</span>
          <span className="st-invite-to" dir="auto">{fillSt(t("st.invite.open_to"), { branch: branchLabel(current.name, lang) })}</span>
        </button>
      )}
      </div>
      {inviting && current && (
        <StaffInviteDialog
          vendorId={vendorId}
          branchId={branchId}
          branchName={current.name}
          onClose={closeInvite}
          onSent={() => setVersion((v) => v + 1)}
        />
      )}

      {error && <ErrorBanner message={error} />}
      {!staff && !error && <div className="skeleton" style={{ height: 120, width: "100%" }} />}
      {staff && (
        <p className="muted st-count" role="status" data-testid="st-count">
          {fillSt(t("st.count"), { n: shown.length })}
        </p>
      )}
      {staff && shown.length === 0 && <EmptyState title={t(all ? "st.empty.all" : "st.empty.branch")} />}
      {pendingInvites.length > 0 && (
        <section className="st-invites" aria-labelledby="st-invites-title" data-testid="st-invites">
          <h3 className="st-invites-title" id="st-invites-title">{t("st.invites")}</h3>
          <ul className="st-invites-list">
            {pendingInvites.map((i) => {
              const expired = Date.parse(i.expires_at) <= now;
              return (
                <li key={i.id} className="st-invite" data-testid={`st-invite-${i.id}`}>
                  <span dir="ltr" className="st-phone">{i.phone}</span>
                  {all && <span className="st-branch" dir="auto">{i.branch_name}</span>}
                  <span className="muted">{expired ? t("st.invites.expired") : fillSt(t("st.invites.until"), { date: until(i.expires_at) })}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {staff && shown.length > 0 && (
        <ul className="st-list" data-testid="st-list">
          {shown.map((member) => {
            const selectId = `st-transfer-${member.id}`;
            return (
              <li key={member.id} className="br-card st-member" data-testid={`st-member-${member.id}`} aria-label={fillSt(t("st.member"), { phone: member.phone })}>
                <div className="st-member-head">
                  <strong dir="ltr" className="st-phone">{member.phone}</strong>
                  {all && (
                    <span className="st-branch" data-testid="st-member-branch">
                      <span className="visually-hidden">{t("st.branch")}: </span>
                      <span dir="auto">{member.branch_name ?? t("st.no_branch")}</span>
                    </span>
                  )}
                  <span className={`badge${member.status === "ACTIVE" ? " badge-active" : ""}`} data-testid="st-member-status">
                    {t(`st.status.${member.status}`)}
                  </span>
                </div>
                <div className="st-actions">
                  <div className="field st-field">
                    <label htmlFor={selectId}>{t("st.transfer_to")}</label>
                    <select
                      id={selectId}
                      value={transferTarget[member.id] ?? ""}
                      onChange={(e) => setTransferTarget((prev) => ({ ...prev, [member.id]: e.target.value }))}
                      data-testid="st-transfer-select"
                    >
                      <option value="">{t("st.transfer_pick")}</option>
                      {eligibleBranches
                        .filter((b) => b.id !== member.branch_id)
                        .map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                    </select>
                  </div>
                  <button className="button" disabled={busyId === member.id} onClick={() => void transfer(member.id)} data-testid="st-transfer">
                    {t("st.transfer")}
                  </button>
                  <button className="button-link" disabled={busyId === member.id} onClick={() => void toggleSuspend(member)} data-testid="st-suspend">
                    {member.status === "ACTIVE" ? t("st.suspend") : t("st.reactivate")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
