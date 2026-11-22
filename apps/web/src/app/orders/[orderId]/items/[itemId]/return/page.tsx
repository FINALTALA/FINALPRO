"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorBanner } from "@/components/States";
import { apiFetch, newIdempotencyKey } from "@/lib/api";
import { isUnauthorized } from "@/lib/apiErrors";
import { type Lang } from "@/lib/i18n";
import { useLang, useT } from "@/lib/useLang";
import { useSessionExpiredRedirect } from "@/lib/useSessionExpiredRedirect";
import { useHydrated, useSessionToken } from "@/lib/useSession";
import { loginRedirectHref } from "@/lib/loginRedirect";
import {
  RETURN_REASONS,
  type ReturnReason,
  type UiError,
  formatMoney,
  returnReasonLabel,
  uiErrorText,
} from "@/lib/returns";

interface ReturnDto {
  id: string;
}

interface ExchangeOptionBranch {
  branch_id: string;
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

/** The variant's own colour/size values (store data, as written) and its price. */
function variantLabel(v: ExchangeOptionVariant, lang: Lang, fallback: string): string {
  const parts = [v.colour, v.size].filter(Boolean);
  return `${parts.length ? parts.join(" / ") : fallback} — ${formatMoney(v.price, lang)}`;
}

// Sprint 21/21b (FR-RET-001/002, EPIC-RET): the customer's "طلب إرجاع/تبديل"
// form for one specific order item. Eligibility and outcome-vs-policy
// are decided entirely server-side - this page shows whatever error
// comes back rather than duplicating that logic client-side. The
// exchange-options list (GET .../exchange-options) is purely
// indicative for the picker; submit()/approveReturn() under a real
// lock are the only real validation. TB-16.2: Arabic and English.
export default function RequestReturnPage() {
  const params = useParams<{ orderId: string; itemId: string }>();
  const router = useRouter();
  const lang = useLang();
  const t = useT();
  const onExpired = useSessionExpiredRedirect();
  const hydrated = useHydrated();
  const token = useSessionToken();

  const [reason, setReason] = useState<ReturnReason>("DAMAGED");
  const [note, setNote] = useState("");
  const [photoUrlsRaw, setPhotoUrlsRaw] = useState("");
  const [outcome, setOutcome] = useState<"RETURN" | "EXCHANGE">("RETURN");
  const [options, setOptions] = useState<ExchangeOptionsDto | null>(null);
  const [optionsError, setOptionsError] = useState<UiError | null>(null);
  const [replacementVariantId, setReplacementVariantId] = useState("");
  const [replacementBranchId, setReplacementBranchId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
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
      .catch((err) => (isUnauthorized(err) ? onExpired() : setOptionsError({ api: err })));
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
      loginRedirectHref(),
    );
    return null;
  }

  const selectedVariant = options?.variants.find((v) => v.id === replacementVariantId);

  async function submit() {
    if (outcome === "EXCHANGE" && (!replacementVariantId || !replacementBranchId)) {
      setError({ key: "ret.request.choose_replacement" });
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
      if (isUnauthorized(err)) {
        onExpired();
        return;
      }
      setError({ api: err });
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div className="page-shell">
        <div className="card" style={{ maxWidth: 560 }}>
          <div className="notice-banner" role="status">
            {t(`ret.request.sent.${outcome}`)}
          </div>
          <Link href={`/returns/${created.id}`} className="button" style={{ marginTop: 8 }}>
            {t(`ret.request.track.${outcome}`)}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="top-bar">
        <h1 className="page-title" style={{ margin: 0 }}>{t("ret.request.title")}</h1>
        <Link href="/orders" className="button-link">{t("ret.my_orders")}</Link>
      </div>
      {error && <ErrorBanner message={uiErrorText(error, lang)} />}
      <div className="card" style={{ maxWidth: 560 }}>
        <div className="field">
          <label>{t("ret.request.what")}</label>
          <select
            value={outcome}
            disabled={busy}
            onChange={(e) => setOutcome(e.target.value as "RETURN" | "EXCHANGE")}
          >
            <option value="RETURN">{t("ret.request.outcome.RETURN")}</option>
            <option value="EXCHANGE">{t("ret.request.outcome.EXCHANGE")}</option>
          </select>
        </div>
        <div className="field">
          <label>{t("ret.request.reason")}</label>
          <select
            value={reason}
            disabled={busy}
            onChange={(e) => setReason(e.target.value as ReturnReason)}
          >
            {RETURN_REASONS.map((r) => (
              <option key={r} value={r}>
                {returnReasonLabel(r, lang)}
              </option>
            ))}
          </select>
        </div>

        {outcome === "EXCHANGE" && (
          <div className="field">
            <label>{t("ret.request.replacement")}</label>
            {optionsError && <ErrorBanner message={uiErrorText(optionsError, lang)} />}
            {!options && !optionsError && <p className="muted">{t("ret.request.loading_options")}</p>}
            {options && options.variants.length === 0 && (
              <p className="muted">{t("ret.request.no_options")}</p>
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
                      {variantLabel(v, lang, t("ret.request.option_fallback"))}
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
          <label>{t("ret.request.note")}</label>
          <textarea
            rows={3}
            value={note}
            disabled={busy}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <div className="field">
          <label>{t("ret.request.photos")}</label>
          <input
            value={photoUrlsRaw}
            disabled={busy}
            onChange={(e) => setPhotoUrlsRaw(e.target.value)}
            placeholder="https://...,https://..."
          />
        </div>
        <button className="button" disabled={busy} onClick={submit}>
          {busy ? t("ret.request.sending") : t(`ret.request.send.${outcome}`)}
        </button>
      </div>
    </div>
  );
}
