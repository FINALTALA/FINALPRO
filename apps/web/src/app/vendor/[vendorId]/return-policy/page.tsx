"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorBanner } from "@/components/States";
import { apiFetch, newIdempotencyKey } from "@/lib/api";
import { formatDateTime, returnErrorMessage } from "@/lib/returns";
import { useHydrated, useSessionToken, useWorkspaces } from "@/lib/useSession";

type ReturnMode = "NO_RETURN" | "REFUND_ONLY" | "EXCHANGE_ONLY" | "BOTH";

interface PolicyDto {
  mode: ReturnMode;
  window_days: number | null;
  fee_ils: number | null;
  exchange_fee_ils: number | null;
  updated_at: string | null;
}

// Sprint 21/21b (PDR-030): the LATER-update half of the return policy -
// the initial selection happens at vendor registration
// (CreateVendorDto). EXCHANGE_ONLY/BOTH are real as of Sprint 21b -
// exchange within the store's own real branches only, no PickupPoint.
export default function ReturnPolicyPage() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const workspaces = useWorkspaces(token);
  const membership = workspaces?.find(
    (w) => w.type === "vendor" && w.vendor_id === params.vendorId,
  );
  const isOwner = membership?.type === "vendor" && membership.role === "OWNER";

  const [policy, setPolicy] = useState<PolicyDto | null>(null);
  const [mode, setMode] = useState<ReturnMode>("NO_RETURN");
  const [windowDays, setWindowDays] = useState<number | "">("");
  const [feeIls, setFeeIls] = useState<number | "">("");
  const [exchangeFeeIls, setExchangeFeeIls] = useState<number | "">("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const needsWindow = mode !== "NO_RETURN";
  const needsReturnFee = mode === "REFUND_ONLY" || mode === "BOTH";
  const needsExchangeFee = mode === "EXCHANGE_ONLY" || mode === "BOTH";

  function load() {
    apiFetch<PolicyDto>(`/vendors/${params.vendorId}/return-policy`)
      .then((res) => {
        setPolicy(res);
        setMode(res.mode);
        setWindowDays(res.window_days ?? "");
        setFeeIls(res.fee_ils ?? "");
        setExchangeFeeIls(res.exchange_fee_ils ?? "");
      })
      .catch((err) => setError(returnErrorMessage(err)));
  }

  useEffect(() => {
    if (!hydrated) return;
    if (!token) {
      router.replace(`/login?next=/vendor/${params.vendorId}/return-policy`);
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, token, params.vendorId]);

  async function save() {
    if (needsWindow && windowDays === "") {
      setError("حدّدي عدد أيام مهلة الإرجاع/التبديل");
      return;
    }
    if (needsReturnFee && feeIls === "") {
      setError("حدّدي رسوم الإرجاع");
      return;
    }
    if (needsExchangeFee && exchangeFeeIls === "") {
      setError("حدّدي رسوم التبديل");
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/vendors/${params.vendorId}/return-policy`, {
        method: "PUT",
        body: {
          mode,
          ...(needsWindow ? { window_days: Number(windowDays) } : {}),
          ...(needsReturnFee ? { fee_ils: Number(feeIls) } : {}),
          ...(needsExchangeFee
            ? { exchange_fee_ils: Number(exchangeFeeIls) }
            : {}),
        },
        idempotencyKey: newIdempotencyKey("return-policy-update"),
      });
      setNotice("تم الحفظ");
      load();
    } catch (err) {
      setError(returnErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (!hydrated || !token) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 560 }} />
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="top-bar">
        <h1 className="page-title" style={{ margin: 0 }}>سياسة الإرجاع والتبديل</h1>
        <Link href={`/vendor/${params.vendorId}`} className="button-link">لوحة المتجر</Link>
      </div>
      {error && <ErrorBanner message={error} />}
      {notice && <p className="muted">{notice}</p>}

      {!policy && !error && (
        <div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 560 }} />
      )}

      {policy && (
        <div className="card" style={{ maxWidth: 560 }}>
          <p className="muted" style={{ marginTop: 0 }}>
            يمكن تعديل السياسة مرة واحدة كل ستة أشهر فقط. سياسة الطلب تُثبَّت وقت الشراء، فأي
            تعديل هنا لا يغيّر حقوق طلب سابق. التبديل يتم داخل فروعكم الفعلية فقط.
          </p>
          <div className="field">
            <label>السياسة</label>
            <select
              value={mode}
              disabled={!isOwner}
              onChange={(e) => setMode(e.target.value as ReturnMode)}
            >
              <option value="NO_RETURN">لا يوجد إرجاع ولا تبديل</option>
              <option value="REFUND_ONLY">إرجاع مقابل استرداد المبلغ فقط</option>
              <option value="EXCHANGE_ONLY">تبديل فقط</option>
              <option value="BOTH">إرجاع أو تبديل (العميل يختار)</option>
            </select>
          </div>
          {needsWindow && (
            <div className="field">
              <label>مهلة الإرجاع/التبديل (أيام)</label>
              <input
                type="number"
                min={1}
                disabled={!isOwner}
                value={windowDays}
                onChange={(e) => setWindowDays(e.target.value === "" ? "" : Number(e.target.value))}
              />
            </div>
          )}
          {needsReturnFee && (
            <div className="field">
              <label>رسوم الإرجاع (₪)</label>
              <input
                type="number"
                min={0}
                disabled={!isOwner}
                value={feeIls}
                onChange={(e) => setFeeIls(e.target.value === "" ? "" : Number(e.target.value))}
              />
            </div>
          )}
          {needsExchangeFee && (
            <div className="field">
              <label>رسوم التبديل (₪) - تُطبَّق دائماً، رداً أو تحصيلاً</label>
              <input
                type="number"
                min={0}
                disabled={!isOwner}
                value={exchangeFeeIls}
                onChange={(e) =>
                  setExchangeFeeIls(e.target.value === "" ? "" : Number(e.target.value))
                }
              />
            </div>
          )}
          <div className="muted">آخر تعديل: {formatDateTime(policy.updated_at)}</div>
          {isOwner && (
            <button className="button" disabled={saving} onClick={save} style={{ marginTop: 10 }}>
              {saving ? "جارٍ الحفظ..." : "حفظ"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
