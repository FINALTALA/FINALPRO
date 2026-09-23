"use client";

import { FormEvent, useState } from "react";
import { ErrorBanner } from "./States";
import { ApiError, apiFetch } from "@/lib/api";
import {
  AddressFormValues,
  ZONES,
  formatCoordinate,
  validateAddress,
} from "@/lib/address";

export interface SavedAddress {
  id: string;
  label: string | null;
  lat: number;
  lng: number;
  landmark_note: string | null;
  phone_number_1: string;
  phone_number_2: string | null;
  zone: string | null;
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

// Sprint 14: create a delivery address. No map provider (by decision):
// the customer types the coordinates and landmark, or - optionally -
// taps "use my location", which ONLY fills lat/lng. Nothing is saved
// until "حفظ العنوان" is pressed (PDR-029's explicit-save rule).
export default function AddressForm({
  onCreated,
  onCancel,
}: {
  onCreated: (address: SavedAddress) => void;
  onCancel?: () => void;
}) {
  const [values, setValues] = useState<AddressFormValues>(EMPTY);
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
      setHint("المتصفح لا يدعم تحديد الموقع - أدخلي الإحداثيات يدوياً.");
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
        setHint("تمت تعبئة الإحداثيات من موقعك. راجعيها ثم اضغطي «حفظ العنوان» - لم يُحفظ شيء بعد.");
        setLocating(false);
      },
      () => {
        setHint("تعذّر تحديد موقعك (رُفض الإذن أو غير متاح) - أدخلي الإحداثيات يدوياً.");
        setLocating(false);
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setError(null);
    const result = validateAddress(values);
    if (!result.ok) {
      setFieldErrors(result.errors);
      return;
    }
    setFieldErrors({});
    setSaving(true);
    try {
      const created = await apiFetch<SavedAddress>("/customers/me/addresses", {
        method: "POST",
        body: result.body,
      });
      onCreated(created);
      setValues(EMPTY);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر حفظ العنوان");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="address-form" onSubmit={onSubmit} noValidate aria-label="عنوان جديد">
      {error && <ErrorBanner message={error} />}

      <div className="field">
        <label htmlFor="addr-label">اسم العنوان (اختياري)</label>
        <input id="addr-label" value={values.label} onChange={(e) => set("label", e.target.value)} placeholder="البيت، العمل..." />
      </div>

      <div className="field">
        <label htmlFor="addr-zone">منطقة التوصيل</label>
        <select id="addr-zone" value={values.zone} onChange={(e) => set("zone", e.target.value as AddressFormValues["zone"])} aria-invalid={Boolean(fieldErrors.zone)}>
          <option value="">اختاري المنطقة</option>
          {ZONES.map((z) => (
            <option key={z.value} value={z.value}>
              {z.label}
            </option>
          ))}
        </select>
        {fieldErrors.zone && <span className="field-error">{fieldErrors.zone}</span>}
      </div>

      <div className="field">
        <label htmlFor="addr-landmark">وصف الموقع / أقرب معلم</label>
        <input id="addr-landmark" value={values.landmark} onChange={(e) => set("landmark", e.target.value)} placeholder="بجانب الدوار الرئيسي، الطابق الثاني" />
      </div>

      <div className="form-row">
        <div className="field">
          <label htmlFor="addr-lat">خط العرض (lat)</label>
          <input id="addr-lat" dir="ltr" inputMode="decimal" value={values.lat} onChange={(e) => set("lat", e.target.value)} placeholder="31.9038" aria-invalid={Boolean(fieldErrors.lat)} />
          {fieldErrors.lat && <span className="field-error">{fieldErrors.lat}</span>}
        </div>
        <div className="field">
          <label htmlFor="addr-lng">خط الطول (lng)</label>
          <input id="addr-lng" dir="ltr" inputMode="decimal" value={values.lng} onChange={(e) => set("lng", e.target.value)} placeholder="35.2034" aria-invalid={Boolean(fieldErrors.lng)} />
          {fieldErrors.lng && <span className="field-error">{fieldErrors.lng}</span>}
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <button type="button" className="button-link" onClick={useMyLocation} disabled={locating}>
          {locating ? "جارٍ تحديد الموقع..." : "استخدمي موقعي الحالي (اختياري)"}
        </button>
        {hint && (
          <p className="muted" role="status" style={{ margin: "8px 0 0" }}>
            {hint}
          </p>
        )}
      </div>

      <div className="form-row">
        <div className="field">
          <label htmlFor="addr-phone1">رقم الهاتف</label>
          <input id="addr-phone1" type="tel" dir="ltr" value={values.phone1} onChange={(e) => set("phone1", e.target.value)} placeholder="+970591234567" aria-invalid={Boolean(fieldErrors.phone1)} />
          {fieldErrors.phone1 && <span className="field-error">{fieldErrors.phone1}</span>}
        </div>
        <div className="field">
          <label htmlFor="addr-phone2">رقم هاتف ثانٍ (اختياري)</label>
          <input id="addr-phone2" type="tel" dir="ltr" value={values.phone2} onChange={(e) => set("phone2", e.target.value)} placeholder="+970561234567" aria-invalid={Boolean(fieldErrors.phone2)} />
          {fieldErrors.phone2 && <span className="field-error">{fieldErrors.phone2}</span>}
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button className="button" type="submit" disabled={saving}>
          {saving ? "جارٍ الحفظ..." : "حفظ العنوان"}
        </button>
        {onCancel && (
          <button type="button" className="button-link" onClick={onCancel} disabled={saving}>
            إلغاء
          </button>
        )}
      </div>
    </form>
  );
}
