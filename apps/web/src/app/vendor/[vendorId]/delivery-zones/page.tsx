"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { clearSession, getSessionToken } from "@/lib/session";

interface ZoneDto {
  region: "WEST_BANK" | "JERUSALEM" | "INSIDE";
  enabled: boolean;
  fee: number | null;
}

const ZONE_LABELS: Record<ZoneDto["region"], string> = {
  WEST_BANK: "الضفة الغربية",
  JERUSALEM: "القدس",
  INSIDE: "الداخل",
};

// Sprint 10 (RB-ORD-003, PDR-022): owner-only per-zone delivery fee,
// added on top of Sprint 5's own enable/disable toggle
// (RB-STORE-002) - a region stays enabled by default even with no fee
// set yet (Sprint 5's own lazy-default convention, unchanged); until a
// fee is set, checkout simply won't offer delivery in that zone (see
// VendorDeliveryZone's own schema.prisma comment).
export default function DeliveryZonesPage() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const [zones, setZones] = useState<ZoneDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function load() {
    apiFetch<ZoneDto[]>(`/vendors/${params.vendorId}/delivery-zones`)
      .then(setZones)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          router.replace("/login");
          return;
        }
        setError(err instanceof ApiError ? err.message : "تعذّر تحميل مناطق التوصيل");
      });
  }

  useEffect(() => {
    if (!getSessionToken()) {
      router.replace("/login");
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.vendorId, router]);

  async function save(region: ZoneDto["region"], enabled: boolean, fee: number | null) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/vendors/${params.vendorId}/delivery-zones/${region}`, {
        method: "PUT",
        body: fee === null ? { enabled } : { enabled, fee },
      });
      setNotice("تم الحفظ");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر حفظ المنطقة");
    } finally {
      setBusy(false);
    }
  }

  if (error && !zones) {
    return (
      <div className="page-shell">
        <div className="error-banner" style={{ maxWidth: 560 }}>{error}</div>
      </div>
    );
  }

  if (!zones) {
    return (
      <div className="page-shell">
        <p className="muted">جارٍ التحميل...</p>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="top-bar">
        <div className="brand" style={{ margin: 0 }}>مناطق ورسوم التوصيل</div>
        <Link href={`/vendor/${params.vendorId}/storefront`} className="button-link">
          العودة لإعدادات المتجر
        </Link>
      </div>

      {error && <div className="error-banner" style={{ maxWidth: 560 }}>{error}</div>}
      {notice && <p className="muted" style={{ maxWidth: 560 }}>{notice}</p>}
      <p className="muted" style={{ maxWidth: 560 }}>
        المناطق الثلاث مفعّلة افتراضياً، لكن التوصيل لا يُعرض فعلياً في السلة إلا بعد
        تحديد رسوم لكل منطقة تريدين التوصيل إليها.
      </p>

      <div style={{ maxWidth: 560, width: "100%", display: "flex", flexDirection: "column", gap: 12 }}>
        {zones.map((zone) => (
          <div key={zone.region} className="card">
            <div style={{ fontWeight: 600, marginBottom: 8 }}>{ZONE_LABELS[zone.region]}</div>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="checkbox"
                checked={zone.enabled}
                disabled={busy}
                onChange={(e) => save(zone.region, e.target.checked, zone.fee)}
              />
              التوصيل مفعّل لهذه المنطقة
            </label>
            <div className="field">
              <label>رسوم التوصيل (₪)</label>
              <input
                type="number"
                min={0}
                defaultValue={zone.fee ?? ""}
                placeholder="لم تُحدَّد بعد"
                onBlur={(e) => {
                  const value = e.target.value === "" ? null : Number(e.target.value);
                  if (value !== null && value !== zone.fee) {
                    save(zone.region, zone.enabled, value);
                  }
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
