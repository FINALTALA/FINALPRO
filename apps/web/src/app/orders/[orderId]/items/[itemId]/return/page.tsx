"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorBanner } from "@/components/States";
import { apiFetch, newIdempotencyKey } from "@/lib/api";
import { useHydrated, useSessionToken } from "@/lib/useSession";
import { RETURN_REASON_LABEL, returnErrorMessage } from "@/lib/returns";

interface ReturnDto {
  id: string;
}

interface ExchangeOptionBranch {
  branch_id: string;
  available_quantity: number;
}

interface ExchangeOptionVariant {
  id: string;
  colour: string | null;
  size: string | null;
  price: number;
  available_at_branches: ExchangeOptionBranch[];
}

interface ExchangeOptionsDto {
  variants: ExchangeOptionVariant[];
  branches: { id: string; name: string }[];
}

const REASONS = Object.keys(RETURN_REASON_LABEL) as Array<
  keyof typeof RETURN_REASON_LABEL
>;

function variantLabel(v: ExchangeOptionVariant): string {
  const parts = [v.colour, v.size].filter(Boolean);
  return `${parts.length ? parts.join(" / ") : "بديل"} — ${v.price} ₪`;
}

// Sprint 21/21b (FR-RET-001/002, EPIC-RET): the customer's "طلب إرجاع/تبديل"
// form for one specific order item. Eligibility and outcome-vs-policy
// are decided entirely server-side - this page shows whatever error
// comes back rather than duplicating that logic client-side. The
// exchange-options list (GET .../exchange-options) is purely
// indicative for the picker; submit()/approveReturn() under a real
// lock are the only real validation.
export default function RequestReturnPage() {
  const params = useParams<{ orderId: string; itemId: string }>();
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();

  const [reason, setReason] = useState<keyof typeof RETURN_REASON_LABEL>("DAMAGED");
  const [note, setNote] = useState("");
  const [photoUrlsRaw, setPhotoUrlsRaw] = useState("");
  const [outcome, setOutcome] = useState<"RETURN" | "EXCHANGE">("RETURN");
  const [options, setOptions] = useState<ExchangeOptionsDto | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [replacementVariantId, setReplacementVariantId] = useState("");
  const [replacementBranchId, setReplacementBranchId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<ReturnDto | null>(null);

  useEffect(() => {
    if (!hydrated || !token || outcome !== "EXCHANGE" || options || optionsError) {
      return;
    }
    apiFetch<ExchangeOptionsDto>(
      `/customers/me/orders/${params.orderId}/items/${params.itemId}/exchange-options`,
    )
      .then((res) => {
        setOptions(res);
        if (res.variants.length > 0) {
          setReplacementVariantId(res.variants[0].id);
          const firstBranch = res.variants[0].available_at_branches[0];
          if (firstBranch) setReplacementBranchId(firstBranch.branch_id);
        }
      })
      .catch((err) => setOptionsError(returnErrorMessage(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, token, outcome]);

  if (!hydrated) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 200, width: "100%", maxWidth: 560 }} />
      </div>
    );
  }
  if (!token) {
    router.replace(
      `/login?next=/orders/${params.orderId}/items/${params.itemId}/return`,
    );
    return null;
  }

  const selectedVariant = options?.variants.find((v) => v.id === replacementVariantId);

  async function submit() {
    if (outcome === "EXCHANGE" && (!replacementVariantId || !replacementBranchId)) {
      setError("يرجى اختيار البديل والفرع");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const photo_urls = photoUrlsRaw
        .split(",")
        .map((u) => u.trim())
        .filter(Boolean);
      const result = await apiFetch<ReturnDto>(
        `/customers/me/orders/${params.orderId}/items/${params.itemId}/returns`,
        {
          method: "POST",
          body: {
            reason,
            ...(note.trim() ? { reason_note: note.trim() } : {}),
            ...(photo_urls.length ? { photo_urls } : {}),
            desired_outcome: outcome,
            ...(outcome === "EXCHANGE"
              ? {
                  replacement_offer_variant_id: replacementVariantId,
                  replacement_branch_id: replacementBranchId,
                }
              : {}),
          },
          idempotencyKey: newIdempotencyKey("return-submit"),
        },
      );
      setCreated(result);
    } catch (err) {
      setError(returnErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div className="page-shell">
        <div className="card" style={{ maxWidth: 560 }}>
          <div className="notice-banner" role="status">
            {outcome === "EXCHANGE"
              ? "تم إرسال طلب التبديل. سيراجعه المتجر خلال 48 ساعة."
              : "تم إرسال طلب الإرجاع. سيراجعه المتجر خلال 48 ساعة."}
          </div>
          <Link href={`/returns/${created.id}`} className="button" style={{ marginTop: 8 }}>
            {outcome === "EXCHANGE" ? "تتبّع طلب التبديل" : "تتبّع طلب الإرجاع"}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="top-bar">
        <h1 className="page-title" style={{ margin: 0 }}>طلب إرجاع أو تبديل</h1>
        <Link href="/orders" className="button-link">طلباتي</Link>
      </div>
      {error && <ErrorBanner message={error} />}
      <div className="card" style={{ maxWidth: 560 }}>
        <div className="field">
          <label>المطلوب</label>
          <select
            value={outcome}
            disabled={busy}
            onChange={(e) => setOutcome(e.target.value as "RETURN" | "EXCHANGE")}
          >
            <option value="RETURN">استرداد المبلغ</option>
            <option value="EXCHANGE">تبديل بمقاس/لون آخر</option>
          </select>
        </div>
        <div className="field">
          <label>السبب</label>
          <select
            value={reason}
            disabled={busy}
            onChange={(e) => setReason(e.target.value as keyof typeof RETURN_REASON_LABEL)}
          >
            {REASONS.map((r) => (
              <option key={r} value={r}>
                {RETURN_REASON_LABEL[r]}
              </option>
            ))}
          </select>
        </div>

        {outcome === "EXCHANGE" && (
          <div className="field">
            <label>البديل</label>
            {optionsError && <ErrorBanner message={optionsError} />}
            {!options && !optionsError && <p className="muted">جارٍ تحميل الخيارات...</p>}
            {options && options.variants.length === 0 && (
              <p className="muted">لا تتوفر بدائل أخرى لهذا المنتج حالياً.</p>
            )}
            {options && options.variants.length > 0 && (
              <>
                <select
                  value={replacementVariantId}
                  disabled={busy}
                  onChange={(e) => {
                    setReplacementVariantId(e.target.value);
                    const v = options.variants.find((x) => x.id === e.target.value);
                    const firstBranch = v?.available_at_branches[0];
                    setReplacementBranchId(firstBranch ? firstBranch.branch_id : "");
                  }}
                >
                  {options.variants.map((v) => (
                    <option key={v.id} value={v.id}>
                      {variantLabel(v)}
                    </option>
                  ))}
                </select>
                {selectedVariant && (
                  <select
                    style={{ marginTop: 8 }}
                    value={replacementBranchId}
                    disabled={busy}
                    onChange={(e) => setReplacementBranchId(e.target.value)}
                  >
                    {selectedVariant.available_at_branches.map((b) => {
                      const branch = options.branches.find((x) => x.id === b.branch_id);
                      return (
                        <option key={b.branch_id} value={b.branch_id}>
                          {branch?.name ?? b.branch_id}
                        </option>
                      );
                    })}
                  </select>
                )}
              </>
            )}
          </div>
        )}

        <div className="field">
          <label>ملاحظة (اختياري)</label>
          <textarea
            rows={3}
            value={note}
            disabled={busy}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <div className="field">
          <label>روابط صور (اختياري، مفصولة بفاصلة)</label>
          <input
            value={photoUrlsRaw}
            disabled={busy}
            onChange={(e) => setPhotoUrlsRaw(e.target.value)}
            placeholder="https://...,https://..."
          />
        </div>
        <button className="button" disabled={busy} onClick={submit}>
          {busy ? "جارٍ الإرسال..." : outcome === "EXCHANGE" ? "إرسال طلب التبديل" : "إرسال طلب الإرجاع"}
        </button>
      </div>
    </div>
  );
}
