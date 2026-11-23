"use client";

import { useEffect, useRef, useState } from "react";
import { ErrorBanner } from "@/components/States";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import "@/lib/branchesText";
import { useT } from "@/lib/useLang";

/** The anchor the old `/branches/:id/minimum-order` address opens. */
export const MINIMUM_ORDER_ANCHOR = "minimum-order";

/**
 * «الحد الأدنى للطلب» inside «إعدادات الفرع» (moved from its own tab; same
 * API and rule - Sprint 20b, FR-PRICE-006 / FR-CART-003): the branch's own
 * minimum, items only (never the delivery fee), for every pickup order and
 * for delivery when the zone has no minimum of its own. Owner only - the
 * settings page itself is owner only.
 */
export default function BranchMinimumOrderSection({ vendorId, branchId }: { vendorId: string; branchId: string }) {
  const t = useT();
  const url = `/vendors/${vendorId}/branches/${branchId}/minimum-order`;
  const [loaded, setLoaded] = useState(false);
  const [none, setNone] = useState(true);
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const noneRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    apiFetch<{ minimum_order_value: number | null }>(url).then(
      (res) => {
        if (!alive) return;
        setNone(res.minimum_order_value === null);
        setAmount(res.minimum_order_value === null ? "" : String(res.minimum_order_value));
        setLoaded(true);
      },
      (err: unknown) => {
        if (alive) setError(err instanceof ApiError && err.message ? err.message : t("br.min.load_failed"));
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // the old address: bring this section into view and focus its field
  useEffect(() => {
    if (!loaded || window.location.hash !== `#${MINIMUM_ORDER_ANCHOR}`) return;
    sectionRef.current?.scrollIntoView({ block: "start" });
    (none ? noneRef.current : inputRef.current)?.focus({ preventScroll: true });
    // only once, when the value first arrives
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  async function save() {
    setError(null);
    setNotice(null);
    const value = none ? null : Number(amount);
    if (value !== null && (amount.trim() === "" || !Number.isFinite(value) || value < 0)) {
      setError(t("br.min.invalid"));
      inputRef.current?.focus();
      return;
    }
    setSaving(true);
    try {
      await apiFetch(url, { method: "PUT", body: { minimum_order_value: value }, idempotencyKey: newIdempotencyKey("branch-minimum-order") });
      setNotice(t("br.min.saved"));
    } catch (err) {
      setError(err instanceof ApiError && err.message ? err.message : t("br.min.save_failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section ref={sectionRef} id={MINIMUM_ORDER_ANCHOR} className="br-card br-min" aria-labelledby="br-min-title" data-testid="br-minimum-order">
      <h2 id="br-min-title">{t("br.min.title")}</h2>
      <p className="muted br-min-lead">{t("br.min.lead")}</p>
      {error && <ErrorBanner message={error} />}
      {!loaded && !error && <div className="skeleton" style={{ height: 44, width: "100%", maxWidth: 320 }} />}
      {loaded && (
        <form
          className="br-min-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="br-min-none">
            <input
              ref={noneRef}
              type="checkbox"
              checked={none}
              onChange={(e) => {
                setNone(e.target.checked);
                setNotice(null);
              }}
              data-testid="br-min-none"
            />
            {t("br.min.none")}
          </label>
          <div className="field br-min-field">
            <label htmlFor="br-min-amount">{t("br.min.amount")}</label>
            <div className="br-min-input">
              <input
                ref={inputRef}
                id="br-min-amount"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                dir="ltr"
                value={none ? "" : amount}
                disabled={none}
                placeholder={none ? t("br.min.none") : "0"}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setNotice(null);
                }}
                data-testid="br-min-amount"
              />
              <span aria-hidden="true">₪</span>
            </div>
          </div>
          <button type="submit" className="button" disabled={saving} aria-busy={saving} data-testid="br-min-save">
            {t("br.min.save")}
          </button>
          {notice && <p className="muted br-min-notice" role="status" data-testid="br-min-notice">{notice}</p>}
        </form>
      )}
    </section>
  );
}
