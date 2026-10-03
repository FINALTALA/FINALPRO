"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { useHydrated, useSessionToken, useWorkspaces } from "@/lib/useSession";

interface HoursEntry {
  day_of_week: number;
  open_minute: number;
  close_minute: number;
}

interface ClosureDto {
  id: string;
  starts_at: string;
  ends_at: string;
  reason: string | null;
  created_at: string;
}

const DAY_LABELS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

function minuteToTime(minute: number): string {
  const h = Math.floor(minute / 60)
    .toString()
    .padStart(2, "0");
  const m = (minute % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

function timeToMinute(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

// Sprint 18b (FR-VEND-006/FR-VPORTAL-009, informational only - product
// decision): hours never gate checkout - only closures do. Owner-only
// writes; any member may read (matches the backend's own ALLOW
// classification for reads).
export default function BranchHoursPage() {
  const params = useParams<{ vendorId: string; branchId: string }>();
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const workspaces = useWorkspaces(token);
  const membership = workspaces?.find(
    (w) => w.type === "vendor" && w.vendor_id === params.vendorId,
  );
  const isOwner = membership?.type === "vendor" && membership.role === "OWNER";

  const [dayOpen, setDayOpen] = useState<Record<number, boolean>>({});
  const [dayFrom, setDayFrom] = useState<Record<number, string>>({});
  const [dayTo, setDayTo] = useState<Record<number, string>>({});
  const [closures, setClosures] = useState<ClosureDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [closureStart, setClosureStart] = useState("");
  const [closureEnd, setClosureEnd] = useState("");
  const [closureReason, setClosureReason] = useState("");
  const [addingClosure, setAddingClosure] = useState(false);

  function loadHours() {
    apiFetch<{ hours: HoursEntry[] }>(
      `/vendors/${params.vendorId}/branches/${params.branchId}/operating-hours`,
    )
      .then((res) => {
        const nextOpen: Record<number, boolean> = {};
        const nextFrom: Record<number, string> = {};
        const nextTo: Record<number, string> = {};
        for (const h of res.hours) {
          nextOpen[h.day_of_week] = true;
          nextFrom[h.day_of_week] = minuteToTime(h.open_minute);
          nextTo[h.day_of_week] = minuteToTime(h.close_minute);
        }
        setDayOpen(nextOpen);
        setDayFrom(nextFrom);
        setDayTo(nextTo);
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "تعذّر تحميل ساعات العمل");
      });
  }

  function loadClosures() {
    apiFetch<{ items: ClosureDto[] }>(
      `/vendors/${params.vendorId}/branches/${params.branchId}/closures`,
    )
      .then((res) => setClosures(res.items))
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "تعذّر تحميل الإغلاقات");
      });
  }

  useEffect(() => {
    if (!hydrated) return;
    if (!token) {
      router.replace(
        `/login?next=/vendor/${params.vendorId}/branches/${params.branchId}/hours`,
      );
      return;
    }
    loadHours();
    loadClosures();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, token, params.vendorId, params.branchId]);

  async function saveHours() {
    setSaving(true);
    setError(null);
    try {
      const hours: HoursEntry[] = [];
      for (let day = 0; day < 7; day++) {
        if (!dayOpen[day]) continue;
        const from = dayFrom[day] ?? "09:00";
        const to = dayTo[day] ?? "17:00";
        hours.push({
          day_of_week: day,
          open_minute: timeToMinute(from),
          close_minute: timeToMinute(to),
        });
      }
      await apiFetch(
        `/vendors/${params.vendorId}/branches/${params.branchId}/operating-hours`,
        { method: "PUT", body: { hours } },
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر حفظ ساعات العمل");
    } finally {
      setSaving(false);
    }
  }

  async function addClosure() {
    if (!closureStart || !closureEnd) {
      setError("تاريخا البداية والنهاية مطلوبان");
      return;
    }
    setAddingClosure(true);
    setError(null);
    try {
      await apiFetch(`/vendors/${params.vendorId}/branches/${params.branchId}/closures`, {
        method: "POST",
        body: {
          starts_at: new Date(closureStart).toISOString(),
          ends_at: new Date(closureEnd).toISOString(),
          ...(closureReason.trim() ? { reason: closureReason.trim() } : {}),
        },
        idempotencyKey: newIdempotencyKey("closure-add"),
      });
      setClosureStart("");
      setClosureEnd("");
      setClosureReason("");
      loadClosures();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر إضافة الإغلاق");
    } finally {
      setAddingClosure(false);
    }
  }

  if (!hydrated || !token) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 1000 }} />
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 1000 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>ساعات العمل والإغلاقات</h1>
          <Link href={`/vendor/${params.vendorId}/branches`} className="button-link">الفروع</Link>
        </div>
        {error && <ErrorBanner message={error} />}

        <div className="card" style={{ marginBottom: 16 }}>
          <p className="muted" style={{ margin: "0 0 8px" }}>
            معلوماتية فقط - لا تؤثر على إمكانية الحجز؛ الإغلاق المؤقت أدناه هو ما يمنع الحجوزات الجديدة.
          </p>
          {DAY_LABELS.map((label, day) => (
            <div key={day} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
              <label style={{ minWidth: 80 }}>
                <input
                  type="checkbox"
                  checked={!!dayOpen[day]}
                  disabled={!isOwner}
                  onChange={(e) => setDayOpen((prev) => ({ ...prev, [day]: e.target.checked }))}
                />{" "}
                {label}
              </label>
              {dayOpen[day] && (
                <>
                  <input
                    type="time"
                    value={dayFrom[day] ?? "09:00"}
                    disabled={!isOwner}
                    onChange={(e) => setDayFrom((prev) => ({ ...prev, [day]: e.target.value }))}
                  />
                  <span>إلى</span>
                  <input
                    type="time"
                    value={dayTo[day] ?? "17:00"}
                    disabled={!isOwner}
                    onChange={(e) => setDayTo((prev) => ({ ...prev, [day]: e.target.value }))}
                  />
                </>
              )}
            </div>
          ))}
          {isOwner && (
            <button className="button" disabled={saving} onClick={saveHours} style={{ marginTop: 8 }}>
              حفظ الساعات
            </button>
          )}
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>الإغلاقات المؤقتة</h3>
          {isOwner && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 12 }}>
              <div className="field" style={{ margin: 0 }}>
                <label>من</label>
                <input
                  type="datetime-local"
                  value={closureStart}
                  onChange={(e) => setClosureStart(e.target.value)}
                />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label>إلى</label>
                <input
                  type="datetime-local"
                  value={closureEnd}
                  onChange={(e) => setClosureEnd(e.target.value)}
                />
              </div>
              <div className="field" style={{ margin: 0, flex: 1, minWidth: 160 }}>
                <label>السبب (اختياري)</label>
                <input value={closureReason} onChange={(e) => setClosureReason(e.target.value)} />
              </div>
              <button className="button" disabled={addingClosure} onClick={addClosure}>
                إضافة إغلاق
              </button>
            </div>
          )}
          {!closures && !error && (
            <div className="skeleton" style={{ height: 80, width: "100%" }} />
          )}
          {closures && closures.length === 0 && <EmptyState title="لا توجد إغلاقات مسجَّلة" />}
          {closures && closures.length > 0 && (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "right" }}>من</th>
                  <th style={{ textAlign: "right" }}>إلى</th>
                  <th style={{ textAlign: "right" }}>السبب</th>
                </tr>
              </thead>
              <tbody>
                {closures.map((c) => (
                  <tr key={c.id}>
                    <td>{new Date(c.starts_at).toLocaleString("ar")}</td>
                    <td>{new Date(c.ends_at).toLocaleString("ar")}</td>
                    <td>{c.reason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
