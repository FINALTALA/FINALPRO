"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { useHydrated, useSessionToken, useWorkspaces } from "@/lib/useSession";

interface StaffDto {
  id: string;
  phone: string;
  branch_id: string | null;
  branch_name: string | null;
  status: "ACTIVE" | "SUSPENDED";
}

interface BranchOptionDto {
  id: string;
  name: string;
  verification_status: string;
  archived_at: string | null;
}

// Sprint 18b (G-IN-05): list/transfer/suspend/reactivate the vendor's
// own BRANCH_EMPLOYEE roster - owner-only, server-enforced regardless
// of this page's own gating (UX only, same as every other page here).
export default function StaffPage() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const workspaces = useWorkspaces(token);
  const membership = workspaces?.find(
    (w) => w.type === "vendor" && w.vendor_id === params.vendorId,
  );
  const isOwner = membership?.type === "vendor" && membership.role === "OWNER";

  const [staff, setStaff] = useState<StaffDto[] | null>(null);
  const [branches, setBranches] = useState<BranchOptionDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [transferTarget, setTransferTarget] = useState<Record<string, string>>({});

  function load() {
    Promise.all([
      apiFetch<StaffDto[]>(`/vendors/${params.vendorId}/staff`),
      apiFetch<BranchOptionDto[]>(`/vendors/${params.vendorId}/branches`),
    ])
      .then(([staffData, branchData]) => {
        setError(null);
        setStaff(staffData);
        setBranches(branchData);
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "تعذّر تحميل الموظفين");
      });
  }

  useEffect(() => {
    if (!hydrated) return;
    if (!token) {
      router.replace(`/login?next=/vendor/${params.vendorId}/staff`);
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, token, params.vendorId]);

  async function transfer(vendorUserId: string) {
    const branchId = transferTarget[vendorUserId];
    if (!branchId) {
      setError("اختر فرعاً للنقل إليه");
      return;
    }
    setBusyId(vendorUserId);
    setError(null);
    try {
      await apiFetch(`/vendors/${params.vendorId}/staff/${vendorUserId}/transfer`, {
        method: "POST",
        body: { branch_id: branchId },
        idempotencyKey: newIdempotencyKey(`staff-transfer-${vendorUserId}`),
      });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر نقل الموظف");
    } finally {
      setBusyId(null);
    }
  }

  async function toggleSuspend(member: StaffDto) {
    const action = member.status === "ACTIVE" ? "suspend" : "reactivate";
    setBusyId(member.id);
    setError(null);
    try {
      await apiFetch(`/vendors/${params.vendorId}/staff/${member.id}/${action}`, {
        method: "POST",
        body: {},
        idempotencyKey: newIdempotencyKey(`staff-${action}-${member.id}`),
      });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر تنفيذ الإجراء");
    } finally {
      setBusyId(null);
    }
  }

  if (!hydrated || !token || workspaces === null) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 1000 }} />
      </div>
    );
  }
  if (!isOwner) {
    return (
      <div className="page-shell">
        <EmptyState title="هذه الصفحة لمالك المتجر فقط" actionHref="/account" actionLabel="حسابي" />
      </div>
    );
  }

  const eligibleBranches = (branches ?? []).filter(
    (b) => b.verification_status === "APPROVED" && !b.archived_at,
  );

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 1000 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>الموظفون</h1>
          <Link href={`/vendor/${params.vendorId}`} className="button-link">لوحة المتجر</Link>
        </div>
        {error && <ErrorBanner message={error} />}

        {!staff && !error && (
          <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 1000 }} />
        )}
        {staff && staff.length === 0 && (
          <EmptyState
            title="لا يوجد موظفو فروع بعد"
            message="يمكنكِ دعوة موظف إلى فرع معتمد من صفحة الفرع نفسها."
          />
        )}
        {staff && staff.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {staff.map((member) => (
              <div key={member.id} className="card" style={{ padding: 16 }}>
                <div className="top-bar" style={{ marginBottom: 8 }}>
                  <div>
                    <strong>{member.phone}</strong>
                    <span className="muted" style={{ marginInlineStart: 8 }}>
                      {member.branch_name ?? "—"}
                    </span>
                  </div>
                  <span className="badge">
                    {member.status === "ACTIVE" ? "نشط" : "معلّق"}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                  <div className="field" style={{ margin: 0 }}>
                    <label>نقل إلى فرع</label>
                    <select
                      value={transferTarget[member.id] ?? ""}
                      onChange={(e) =>
                        setTransferTarget((prev) => ({ ...prev, [member.id]: e.target.value }))
                      }
                    >
                      <option value="">— اختر فرعاً —</option>
                      {eligibleBranches
                        .filter((b) => b.id !== member.branch_id)
                        .map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                    </select>
                  </div>
                  <button className="button" disabled={busyId === member.id} onClick={() => transfer(member.id)}>
                    نقل
                  </button>
                  <button className="button-link" disabled={busyId === member.id} onClick={() => toggleSuspend(member)}>
                    {member.status === "ACTIVE" ? "تعليق" : "إعادة تفعيل"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
