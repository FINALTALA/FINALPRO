"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorBanner } from "@/components/States";
import { apiFetch, newIdempotencyKey } from "@/lib/api";
import {
  RETURN_ITEM_CONDITION_LABEL,
  RETURN_STATUS_LABEL,
  formatDateTime,
  returnErrorMessage,
} from "@/lib/returns";
import { useHydrated, useSessionToken } from "@/lib/useSession";

interface BranchDto {
  id: string;
  name: string;
  archived_at: string | null;
}

interface RedeemResult {
  id: string;
  status: string;
  receiving_branch_id: string;
  received_at: string;
  item_condition: string;
}

// Sprint 21 (PDR-031, review-round point 1/4): deliberately vendor-wide,
// not under a :branchId route - any employee/owner of this vendor can
// redeem a customer's code at whichever branch they're actually
// standing in (see VendorReturnsController's own comment). The
// response is the privacy-safe redeemResultDto() only - never
// reason_note/photo_urls/rejection_reason/code, since the redeeming
// employee may belong to a DIFFERENT branch than the one that
// originally decided this return.
export default function RedeemReturnPage() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();

  const [branches, setBranches] = useState<BranchDto[] | null>(null);
  const [code, setCode] = useState("");
  const [branchId, setBranchId] = useState("");
  const [condition, setCondition] = useState<"RESELLABLE" | "DAMAGED">("RESELLABLE");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RedeemResult | null>(null);

  useEffect(() => {
    if (!hydrated) return;
    if (!token) {
      router.replace(`/login?next=/vendor/${params.vendorId}/returns/redeem`);
      return;
    }
    apiFetch<BranchDto[]>(`/vendors/${params.vendorId}/branches`)
      .then((data) => {
        const active = data.filter((b) => !b.archived_at);
        setBranches(active);
        if (active.length > 0) setBranchId(active[0].id);
      })
      .catch((err) => setError(returnErrorMessage(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, token, params.vendorId]);

  if (!hydrated || !token) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 560 }} />
      </div>
    );
  }

  async function redeem() {
    if (code.trim().length !== 6) {
      setError("الكود مكوَّن من 6 أرقام");
      return;
    }
    if (!branchId) {
      setError("اختاري الفرع المستلِم");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await apiFetch<RedeemResult>(`/vendors/${params.vendorId}/returns/redeem`, {
        method: "POST",
        body: { code: code.trim(), receiving_branch_id: branchId, item_condition: condition },
        idempotencyKey: newIdempotencyKey("return-redeem"),
      });
      setResult(res);
      setCode("");
    } catch (err) {
      setError(returnErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-shell">
      <div className="top-bar">
        <h1 className="page-title" style={{ margin: 0 }}>استبدال كود إرجاع</h1>
        <Link href={`/vendor/${params.vendorId}`} className="button-link">لوحة المتجر</Link>
      </div>
      {error && <ErrorBanner message={error} />}

      {!branches && !error && (
        <div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 560 }} />
      )}

      {branches && (
        <div className="card" style={{ maxWidth: 560 }}>
          <p className="muted" style={{ marginTop: 0 }}>
            يمكن استلام إرجاع في أي فرع من فروع متجركم، بغض النظر عن الفرع الذي اعتمد الطلب
            أصلاً.
          </p>
          <div className="field">
            <label>كود الإرجاع (6 أرقام)</label>
            <input
              value={code}
              disabled={busy}
              maxLength={6}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </div>
          <div className="field">
            <label>الفرع المستلِم</label>
            <select value={branchId} disabled={busy} onChange={(e) => setBranchId(e.target.value)}>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>حالة المنتج</label>
            <select
              value={condition}
              disabled={busy}
              onChange={(e) => setCondition(e.target.value as "RESELLABLE" | "DAMAGED")}
            >
              {Object.entries(RETURN_ITEM_CONDITION_LABEL).map(([v, label]) => (
                <option key={v} value={v}>{label}</option>
              ))}
            </select>
          </div>
          <button className="button" disabled={busy} onClick={redeem}>
            {busy ? "جارٍ الاستبدال..." : "استبدال"}
          </button>
        </div>
      )}

      {result && (
        <div className="notice-banner" style={{ marginTop: 14, maxWidth: 560 }} role="status">
          تم استلام المنتج بنجاح. الحالة: {RETURN_STATUS_LABEL[result.status] ?? result.status}،
          وقت الاستلام: {formatDateTime(result.received_at)}.
        </div>
      )}
    </div>
  );
}
