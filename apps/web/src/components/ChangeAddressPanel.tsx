"use client";

import { useState } from "react";
import { ErrorBanner } from "./States";
import { SavedAddress } from "./AddressForm";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { registerTranslations } from "@/lib/i18n";
import { useT } from "@/lib/useLang";

registerTranslations({
  ar: {
    "order.change_address.open": "تغيير عنوان التوصيل",
    "order.change_address.pick_title": "اختاري العنوان الجديد",
    "order.change_address.no_addresses": "لا توجد عناوين أخرى محفوظة.",
    "order.change_address.submit": "تأكيد العنوان الجديد",
    "order.change_address.submitting": "جارٍ التغيير...",
    "order.change_address.cancel": "إلغاء",
    "order.change_address.load_failed": "تعذّر تحميل العناوين",
    "order.change_address.failed": "تعذّر تغيير العنوان",
    "order.change_address.unsupported.FEE_WOULD_CHANGE": "رسوم التوصيل لهذا العنوان مختلفة، ولا يمكن تحصيل فرق أو إعادته. اختاري أحد الخيارات:",
    "order.change_address.unsupported.ZONE_NOT_SERVED": "المتجر لا يوصّل لهذه المنطقة. اختاري أحد الخيارات:",
    "order.change_address.unsupported.ZONE_MISSING": "هذا العنوان بدون منطقة توصيل محددة. اختاري أحد الخيارات:",
    "order.change_address.unsupported.BELOW_MINIMUM_ORDER_VALUE": "طلبك أقل من الحد الأدنى للتوصيل لهذا العنوان. اختاري أحد الخيارات:",
    "order.change_address.action.cancel_order": "إلغاء الطلب",
    "order.change_address.action.convert_to_pickup": "التحويل إلى استلام من المحل",
    "order.change_address.action.retry": "تجربة عنوان آخر",
    "order.change_address.converting": "جارٍ التحويل...",
    "order.change_address.convert_failed": "تعذّر التحويل إلى استلام من المحل",
  },
  en: {
    "order.change_address.open": "Change delivery address",
    "order.change_address.pick_title": "Choose the new address",
    "order.change_address.no_addresses": "No other saved addresses.",
    "order.change_address.submit": "Confirm new address",
    "order.change_address.submitting": "Changing...",
    "order.change_address.cancel": "Cancel",
    "order.change_address.load_failed": "Couldn't load addresses",
    "order.change_address.failed": "Couldn't change the address",
    "order.change_address.unsupported.FEE_WOULD_CHANGE": "This address has a different delivery fee, and the difference can't be charged or refunded. Choose one:",
    "order.change_address.unsupported.ZONE_NOT_SERVED": "The store doesn't deliver to this zone. Choose one:",
    "order.change_address.unsupported.ZONE_MISSING": "This address has no delivery zone set. Choose one:",
    "order.change_address.unsupported.BELOW_MINIMUM_ORDER_VALUE": "Your order is below the delivery minimum for this address. Choose one:",
    "order.change_address.action.cancel_order": "Cancel the order",
    "order.change_address.action.convert_to_pickup": "Switch to store pickup",
    "order.change_address.action.retry": "Try another address",
    "order.change_address.converting": "Converting...",
    "order.change_address.convert_failed": "Couldn't switch to store pickup",
  },
});

type Mode = "closed" | "picking" | "unsupported";

// Sprint 22 (PDR-029): a PLACED delivery order's own "change address"
// flow - picking a saved address, and, when the new address turns out
// to be unsupported (ANY delivery-fee difference, or a zone the store
// doesn't serve), the customer's own explicit 3-way choice: cancel,
// convert to pickup, or try another address. Never automatic.
export default function ChangeAddressPanel({
  branchOrderId,
  onCancelOrder,
  onChanged,
}: {
  branchOrderId: string;
  onCancelOrder: () => void;
  onChanged: () => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<Mode>("closed");
  const [addresses, setAddresses] = useState<SavedAddress[] | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [unsupportedReason, setUnsupportedReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function openPicker() {
    setMode("picking");
    setError(null);
    setUnsupportedReason(null);
    if (!addresses) {
      try {
        const list = await apiFetch<SavedAddress[]>("/customers/me/addresses");
        setAddresses(list);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : t("order.change_address.load_failed"));
      }
    }
  }

  async function submitNewAddress() {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/customers/me/orders/${branchOrderId}/change-address`, {
        method: "POST",
        idempotencyKey: newIdempotencyKey("change-address"),
        body: { address_id: selectedId },
      });
      setMode("closed");
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.code === "ADDRESS_CHANGE_UNSUPPORTED") {
        const reason = (err.details[0] as { reason?: string } | undefined)?.reason;
        setUnsupportedReason(reason ?? "FEE_WOULD_CHANGE");
        setMode("unsupported");
      } else {
        setError(err instanceof ApiError ? err.message : t("order.change_address.failed"));
      }
    } finally {
      setBusy(false);
    }
  }

  async function convertToPickup() {
    setBusy(true);
    setError(null);
    try {
      // No local success message here: converting away from DELIVERY
      // unmounts this whole panel the moment onChanged()'s reload
      // lands (this component only renders while
      // fulfilment_method === "DELIVERY") - the order card's own
      // existing pickup_code display is what the customer actually
      // sees afterward.
      await apiFetch(
        `/customers/me/orders/${branchOrderId}/change-address/convert-to-pickup`,
        { method: "POST", idempotencyKey: newIdempotencyKey("convert-to-pickup") },
      );
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("order.change_address.convert_failed"));
    } finally {
      setBusy(false);
    }
  }

  if (mode === "closed") {
    return (
      <button className="button-link" onClick={() => void openPicker()}>
        {t("order.change_address.open")}
      </button>
    );
  }

  return (
    <div className="card" style={{ maxWidth: "none", marginTop: 10 }}>
      {error && <ErrorBanner message={error} />}

      {mode === "picking" && (
        <>
          <div className="muted" style={{ marginBottom: 8 }}>{t("order.change_address.pick_title")}</div>
          {!addresses && <div className="skeleton" style={{ height: 40 }} />}
          {addresses && addresses.length === 0 && (
            <p className="muted">{t("order.change_address.no_addresses")}</p>
          )}
          {addresses && addresses.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
              {addresses.map((a) => (
                <label key={a.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input
                    type="radio"
                    name={`addr-${branchOrderId}`}
                    value={a.id}
                    checked={selectedId === a.id}
                    onChange={() => setSelectedId(a.id)}
                  />
                  <span>
                    {a.label ?? ""} {a.landmark_note ? `— ${a.landmark_note}` : ""}
                  </span>
                </label>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 10 }}>
            <button className="button" disabled={busy || !selectedId} onClick={() => void submitNewAddress()}>
              {busy ? t("order.change_address.submitting") : t("order.change_address.submit")}
            </button>
            <button className="button-link" disabled={busy} onClick={() => setMode("closed")}>
              {t("order.change_address.cancel")}
            </button>
          </div>
        </>
      )}

      {mode === "unsupported" && (
        <>
          <div className="muted" style={{ marginBottom: 10 }}>
            {t(`order.change_address.unsupported.${unsupportedReason}`)}
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="button button-secondary" disabled={busy} onClick={onCancelOrder}>
              {t("order.change_address.action.cancel_order")}
            </button>
            <button className="button" disabled={busy} onClick={() => void convertToPickup()}>
              {busy ? t("order.change_address.converting") : t("order.change_address.action.convert_to_pickup")}
            </button>
            <button className="button-link" disabled={busy} onClick={() => setMode("picking")}>
              {t("order.change_address.action.retry")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
