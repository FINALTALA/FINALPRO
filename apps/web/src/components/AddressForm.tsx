"use client";

import { FormEvent, useState } from "react";
import { ErrorBanner } from "./States";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import {
  AddressFormValues,
  zoneOptions,
  formatCoordinate,
  validateAddress,
} from "@/lib/address";
import { useLang, useT } from "@/lib/useLang";
import { registerTranslations } from "@/lib/i18n";

registerTranslations({
  ar: {
    "address.geo.unsupported": "المتصفح لا يدعم تحديد الموقع - أدخلي الإحداثيات يدوياً.",
    "address.geo.filled": "تمت تعبئة الإحداثيات من موقعك. راجعيها ثم اضغطي «حفظ العنوان» - لم يُحفظ شيء بعد.",
    "address.geo.denied": "تعذّر تحديد موقعك (رُفض الإذن أو غير متاح) - أدخلي الإحداثيات يدوياً.",
    "address.geo.locating": "جارٍ تحديد الموقع...",
    "address.geo.use_my_location": "استخدمي موقعي الحالي (اختياري)",
    "address.save_failed": "تعذّر حفظ العنوان",
    "address.save_new": "حفظ العنوان",
    "address.form.new_aria": "عنوان جديد",
    "address.form.edit_aria": "تعديل العنوان",
    "address.field.label": "اسم العنوان (اختياري)",
    "address.field.label_placeholder": "البيت، العمل...",
    "address.field.zone": "منطقة التوصيل",
    "address.field.zone_placeholder": "اختاري المنطقة",
    "address.field.landmark": "وصف الموقع / أقرب معلم",
    "address.field.landmark_placeholder": "بجانب الدوار الرئيسي، الطابق الثاني",
    "address.field.lat": "خط العرض (lat)",
    "address.field.lng": "خط الطول (lng)",
    "address.field.phone1": "رقم الهاتف",
    "address.field.phone2": "رقم هاتف ثانٍ (اختياري)",
    "address.field.is_default": "اجعلي هذا العنوان الافتراضي",
  },
  en: {
    "address.geo.unsupported": "Your browser doesn't support location - enter the coordinates manually.",
    "address.geo.filled": "Coordinates filled from your location. Review them, then press \"Save address\" - nothing is saved yet.",
    "address.geo.denied": "Couldn't determine your location (permission denied or unavailable) - enter the coordinates manually.",
    "address.geo.locating": "Locating...",
    "address.geo.use_my_location": "Use my current location (optional)",
    "address.save_failed": "Couldn't save the address",
    "address.save_new": "Save address",
    "address.form.new_aria": "New address",
    "address.form.edit_aria": "Edit address",
    "address.field.label": "Address name (optional)",
    "address.field.label_placeholder": "Home, Work...",
    "address.field.zone": "Delivery zone",
    "address.field.zone_placeholder": "Choose the zone",
    "address.field.landmark": "Location description / nearest landmark",
    "address.field.landmark_placeholder": "Next to the main roundabout, 2nd floor",
    "address.field.lat": "Latitude (lat)",
    "address.field.lng": "Longitude (lng)",
    "address.field.phone1": "Phone number",
    "address.field.phone2": "Second phone number (optional)",
    "address.field.is_default": "Make this my default address",
  },
});

export interface SavedAddress {
  id: string;
  label: string | null;
  lat: number;
  lng: number;
  landmark_note: string | null;
  phone_number_1: string;
  phone_number_2: string | null;
  zone: string | null;
  // Sprint 22 (FR-AUTH-008): present on every address the API returns
  // from this sprint onward.
  is_default: boolean;
}

const EMPTY: AddressFormValues = {
  label: "",
  lat: "",
  lng: "",
  landmark: "",
  phone1: "",
  phone2: "",
  zone: "",
};

function toFormValues(a: SavedAddress): AddressFormValues {
  return {
    label: a.label ?? "",
    lat: String(a.lat),
    lng: String(a.lng),
    landmark: a.landmark_note ?? "",
    phone1: a.phone_number_1,
    phone2: a.phone_number_2 ?? "",
    zone: (a.zone ?? "") as AddressFormValues["zone"],
  };
}

// Sprint 14: create a delivery address. No map provider (by decision):
// the customer types the coordinates and landmark, or - optionally -
// taps "use my location", which ONLY fills lat/lng. Nothing is saved
// until "حفظ العنوان" is pressed (PDR-029's explicit-save rule).
//
// Sprint 22 (FR-AUTH-008, PDR-029): gained an edit mode (`address`
// present -> PATCH instead of POST, plus an is_default toggle) and
// full bilingual text - this component is shared between the pre-S22
// /account page (create-only, via `onCreated`) and the new S22
// addresses screen (create AND edit, via `onCreated`/`onSaved`).
export default function AddressForm({
  onCreated,
  onSaved,
  onCancel,
  address,
}: {
  onCreated?: (address: SavedAddress) => void;
  onSaved?: (address: SavedAddress) => void;
  onCancel?: () => void;
  address?: SavedAddress;
}) {
  const lang = useLang();
  const t = useT();
  const isEdit = Boolean(address);
  const [values, setValues] = useState<AddressFormValues>(address ? toFormValues(address) : EMPTY);
  const [isDefault, setIsDefault] = useState(address?.is_default ?? false);
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<keyof AddressFormValues, string>>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [saving, setSaving] = useState(false);

  function set<K extends keyof AddressFormValues>(key: K, value: AddressFormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function useMyLocation() {
    setHint(null);
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setHint(t("address.geo.unsupported"));
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setValues((prev) => ({
          ...prev,
          lat: formatCoordinate(pos.coords.latitude),
          lng: formatCoordinate(pos.coords.longitude),
        }));
        setHint(t("address.geo.filled"));
        setLocating(false);
      },
      () => {
        setHint(t("address.geo.denied"));
        setLocating(false);
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setError(null);
    const result = validateAddress(values, lang);
    if (!result.ok) {
      setFieldErrors(result.errors);
      return;
    }
    setFieldErrors({});
    setSaving(true);
    try {
      if (isEdit && address) {
        const updated = await apiFetch<SavedAddress>(`/customers/me/addresses/${address.id}`, {
          method: "PATCH",
          idempotencyKey: newIdempotencyKey("address-update"),
          body: { ...result.body, is_default: isDefault },
        });
        onSaved?.(updated);
      } else {
        const created = await apiFetch<SavedAddress>("/customers/me/addresses", {
          method: "POST",
          body: result.body,
        });
        onCreated?.(created);
        setValues(EMPTY);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("address.save_failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="address-form" onSubmit={onSubmit} noValidate aria-label={t(isEdit ? "address.form.edit_aria" : "address.form.new_aria")}>
      {error && <ErrorBanner message={error} />}

      <div className="field">
        <label htmlFor="addr-label">{t("address.field.label")}</label>
        <input id="addr-label" value={values.label} onChange={(e) => set("label", e.target.value)} placeholder={t("address.field.label_placeholder")} />
      </div>

      <div className="field">
        <label htmlFor="addr-zone">{t("address.field.zone")}</label>
        <select id="addr-zone" value={values.zone} onChange={(e) => set("zone", e.target.value as AddressFormValues["zone"])} aria-invalid={Boolean(fieldErrors.zone)}>
          <option value="">{t("address.field.zone_placeholder")}</option>
          {zoneOptions(lang).map((z) => (
            <option key={z.value} value={z.value}>
              {z.label}
            </option>
          ))}
        </select>
        {fieldErrors.zone && <span className="field-error">{fieldErrors.zone}</span>}
      </div>

      <div className="field">
        <label htmlFor="addr-landmark">{t("address.field.landmark")}</label>
        <input id="addr-landmark" value={values.landmark} onChange={(e) => set("landmark", e.target.value)} placeholder={t("address.field.landmark_placeholder")} />
      </div>

      <div className="form-row">
        <div className="field">
          <label htmlFor="addr-lat">{t("address.field.lat")}</label>
          <input id="addr-lat" dir="ltr" inputMode="decimal" value={values.lat} onChange={(e) => set("lat", e.target.value)} placeholder="31.9038" aria-invalid={Boolean(fieldErrors.lat)} />
          {fieldErrors.lat && <span className="field-error">{fieldErrors.lat}</span>}
        </div>
        <div className="field">
          <label htmlFor="addr-lng">{t("address.field.lng")}</label>
          <input id="addr-lng" dir="ltr" inputMode="decimal" value={values.lng} onChange={(e) => set("lng", e.target.value)} placeholder="35.2034" aria-invalid={Boolean(fieldErrors.lng)} />
          {fieldErrors.lng && <span className="field-error">{fieldErrors.lng}</span>}
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <button type="button" className="button-link" onClick={useMyLocation} disabled={locating}>
          {locating ? t("address.geo.locating") : t("address.geo.use_my_location")}
        </button>
        {hint && (
          <p className="muted" role="status" style={{ margin: "8px 0 0" }}>
            {hint}
          </p>
        )}
      </div>

      <div className="form-row">
        <div className="field">
          <label htmlFor="addr-phone1">{t("address.field.phone1")}</label>
          <input id="addr-phone1" type="tel" dir="ltr" value={values.phone1} onChange={(e) => set("phone1", e.target.value)} placeholder="+970591234567" aria-invalid={Boolean(fieldErrors.phone1)} />
          {fieldErrors.phone1 && <span className="field-error">{fieldErrors.phone1}</span>}
        </div>
        <div className="field">
          <label htmlFor="addr-phone2">{t("address.field.phone2")}</label>
          <input id="addr-phone2" type="tel" dir="ltr" value={values.phone2} onChange={(e) => set("phone2", e.target.value)} placeholder="+970561234567" aria-invalid={Boolean(fieldErrors.phone2)} />
          {fieldErrors.phone2 && <span className="field-error">{fieldErrors.phone2}</span>}
        </div>
      </div>

      {isEdit && (
        <div className="field" style={{ flexDirection: "row", alignItems: "center", display: "flex", gap: 8 }}>
          <input
            id="addr-default"
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
            style={{ width: "auto" }}
          />
          <label htmlFor="addr-default" style={{ margin: 0 }}>{t("address.field.is_default")}</label>
        </div>
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button className="button" type="submit" disabled={saving}>
          {saving ? t("common.saving") : t(isEdit ? "common.save" : "address.save_new")}
        </button>
        {onCancel && (
          <button type="button" className="button-link" onClick={onCancel} disabled={saving}>
            {t("common.cancel")}
          </button>
        )}
      </div>
    </form>
  );
}
