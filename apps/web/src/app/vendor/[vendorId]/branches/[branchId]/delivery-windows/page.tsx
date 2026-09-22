"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { clearSession, getSessionToken } from "@/lib/session";

const DAY_LABELS = [
  "الأحد",
  "الاثنين",
  "الثلاثاء",
  "الأربعاء",
  "الخميس",
  "الجمعة",
  "السبت",
];

interface ExceptionDto {
  id: string;
  exception_date: string;
  is_closed: boolean;
  capacity_override: number | null;
}

interface WindowDto {
  id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  capacity: number;
  exceptions: ExceptionDto[];
}

interface NewWindowForm {
  day_of_week: number;
  start_time: string;
  end_time: string;
  capacity: number;
}

const EMPTY_FORM: NewWindowForm = {
  day_of_week: 0,
  start_time: "09:00",
  end_time: "17:00",
  capacity: 5,
};

interface NewExceptionForm {
  exception_date: string;
  kind: "closed" | "capacity";
  capacity_override: number;
}

const EMPTY_EXCEPTION_FORM: NewExceptionForm = {
  exception_date: "",
  kind: "closed",
  capacity_override: 1,
};

// Sprint 9 (RB-FUL-001, PDR-022/024): owner-only setup for one branch's
// weekly delivery-slot calendar - recurring windows plus dated
// exceptions (closures or capacity overrides). Deliberately setup-only:
// no customer-facing slot picker and no reservation hold here (both are
// Sprint 10's checkout). Backend authorization
// (VendorMembershipGuard + @RequireVendorRole('OWNER')) is the real
// boundary - a BRANCH_EMPLOYEE reaching this page by URL is refused
// server-side on every request.
export default function DeliveryWindowsCalendarPage() {
  const params = useParams<{ vendorId: string; branchId: string }>();
  const router = useRouter();
  const [windows, setWindows] = useState<WindowDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<NewWindowForm>(EMPTY_FORM);
  const [exceptionForms, setExceptionForms] = useState<
    Record<string, NewExceptionForm>
  >({});

  function basePath() {
    return `/vendors/${params.vendorId}/branches/${params.branchId}/delivery-windows`;
  }

  function load() {
    apiFetch<WindowDto[]>(basePath())
      .then(setWindows)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          router.replace("/login");
          return;
        }
        setError(err instanceof ApiError ? err.message : "تعذّر تحميل التقويم");
      });
  }

  useEffect(() => {
    if (!getSessionToken()) {
      router.replace("/login");
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.vendorId, params.branchId, router]);

  function exceptionFormFor(windowId: string): NewExceptionForm {
    return exceptionForms[windowId] ?? EMPTY_EXCEPTION_FORM;
  }

  function updateExceptionForm(
    windowId: string,
    patch: Partial<NewExceptionForm>,
  ) {
    setExceptionForms((prev) => ({
      ...prev,
      [windowId]: { ...exceptionFormFor(windowId), ...patch },
    }));
  }

  async function createWindow() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(basePath(), {
        method: "POST",
        body: {
          day_of_week: form.day_of_week,
          start_time: form.start_time,
          end_time: form.end_time,
          capacity: form.capacity,
        },
      });
      setForm(EMPTY_FORM);
      setNotice("تمت إضافة النافذة");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر إنشاء النافذة");
    } finally {
      setBusy(false);
    }
  }

  async function updateWindow(w: WindowDto, patch: Partial<NewWindowForm>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`${basePath()}/${w.id}`, {
        method: "PUT",
        body: {
          day_of_week: patch.day_of_week ?? w.day_of_week,
          start_time: patch.start_time ?? w.start_time,
          end_time: patch.end_time ?? w.end_time,
          capacity: patch.capacity ?? w.capacity,
        },
      });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر تعديل النافذة");
    } finally {
      setBusy(false);
    }
  }

  async function deleteWindow(windowId: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`${basePath()}/${windowId}`, { method: "DELETE" });
      setNotice("تم حذف النافذة واستثناءاتها");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر حذف النافذة");
    } finally {
      setBusy(false);
    }
  }

  async function createException(windowId: string) {
    const f = exceptionFormFor(windowId);
    if (!f.exception_date) {
      setError("اختاري تاريخاً للاستثناء");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`${basePath()}/${windowId}/exceptions`, {
        method: "POST",
        body:
          f.kind === "closed"
            ? { exception_date: f.exception_date, is_closed: true }
            : {
                exception_date: f.exception_date,
                capacity_override: f.capacity_override,
              },
      });
      setExceptionForms((prev) => ({ ...prev, [windowId]: EMPTY_EXCEPTION_FORM }));
      setNotice("تمت إضافة الاستثناء");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر إضافة الاستثناء");
    } finally {
      setBusy(false);
    }
  }

  async function deleteException(windowId: string, exceptionId: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`${basePath()}/${windowId}/exceptions/${exceptionId}`, {
        method: "DELETE",
      });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر حذف الاستثناء");
    } finally {
      setBusy(false);
    }
  }

  if (error && !windows) {
    return (
      <div className="page-shell">
        <div className="error-banner" style={{ maxWidth: 640 }}>{error}</div>
      </div>
    );
  }

  if (!windows) {
    return (
      <div className="page-shell">
        <p className="muted">جارٍ التحميل...</p>
      </div>
    );
  }

  const byDay = DAY_LABELS.map((label, day) => ({
    day,
    label,
    windows: windows
      .filter((w) => w.day_of_week === day)
      .sort((a, b) => a.start_time.localeCompare(b.start_time)),
  }));

  return (
    <div className="page-shell">
      <div className="top-bar">
        <div className="brand" style={{ margin: 0 }}>
          تقويم نوافذ التوصيل
        </div>
        <Link
          href={`/vendor/${params.vendorId}/delivery-windows`}
          className="button-link"
        >
          العودة لاختيار الفرع
        </Link>
      </div>

      {error && <div className="error-banner" style={{ maxWidth: 640 }}>{error}</div>}
      {notice && <p className="muted" style={{ maxWidth: 640 }}>{notice}</p>}

      <div className="card" style={{ maxWidth: 640 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>إضافة نافذة جديدة</div>
        <div className="field">
          <label>اليوم</label>
          <select
            value={form.day_of_week}
            onChange={(e) =>
              setForm({ ...form, day_of_week: Number(e.target.value) })
            }
          >
            {DAY_LABELS.map((label, day) => (
              <option key={day} value={day}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>من الساعة</label>
            <input
              type="time"
              value={form.start_time}
              onChange={(e) => setForm({ ...form, start_time: e.target.value })}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>إلى الساعة</label>
            <input
              type="time"
              value={form.end_time}
              onChange={(e) => setForm({ ...form, end_time: e.target.value })}
            />
          </div>
        </div>
        <div className="field">
          <label>السعة (عدد الطلبات المتاحة لهذه النافذة)</label>
          <input
            type="number"
            min={1}
            value={form.capacity}
            onChange={(e) =>
              setForm({ ...form, capacity: Number(e.target.value) })
            }
          />
        </div>
        <button className="button" onClick={createWindow} disabled={busy}>
          إضافة النافذة
        </button>
      </div>

      <div style={{ maxWidth: 640, width: "100%", display: "flex", flexDirection: "column", gap: 16, marginTop: 16 }}>
        {byDay.map(({ day, label, windows: dayWindows }) => (
          <div key={day} className="card">
            <div style={{ fontWeight: 600, marginBottom: 8 }}>{label}</div>
            {dayWindows.length === 0 && (
              <p className="muted">لا توجد نوافذ لهذا اليوم.</p>
            )}
            {dayWindows.map((w) => (
              <div
                key={w.id}
                style={{
                  border: "1px solid var(--border-color, #333)",
                  borderRadius: 8,
                  padding: 10,
                  marginBottom: 10,
                }}
              >
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <input
                    type="time"
                    defaultValue={w.start_time}
                    onBlur={(e) =>
                      e.target.value !== w.start_time &&
                      updateWindow(w, { start_time: e.target.value })
                    }
                  />
                  <span className="muted">إلى</span>
                  <input
                    type="time"
                    defaultValue={w.end_time}
                    onBlur={(e) =>
                      e.target.value !== w.end_time &&
                      updateWindow(w, { end_time: e.target.value })
                    }
                  />
                  <span className="muted">السعة</span>
                  <input
                    type="number"
                    min={1}
                    defaultValue={w.capacity}
                    style={{ width: 70 }}
                    onBlur={(e) =>
                      Number(e.target.value) !== w.capacity &&
                      updateWindow(w, { capacity: Number(e.target.value) })
                    }
                  />
                  <button
                    className="button-link"
                    disabled={busy}
                    onClick={() => deleteWindow(w.id)}
                  >
                    حذف النافذة
                  </button>
                </div>

                {w.exceptions.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div className="muted">الاستثناءات:</div>
                    {w.exceptions.map((ex) => (
                      <div
                        key={ex.id}
                        style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}
                      >
                        <span>{ex.exception_date}</span>
                        <span className="muted">
                          {ex.is_closed
                            ? "مغلق"
                            : `سعة خاصة: ${ex.capacity_override}`}
                        </span>
                        <button
                          className="button-link"
                          disabled={busy}
                          onClick={() => deleteException(w.id, ex.id)}
                        >
                          حذف
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
                  <input
                    type="date"
                    value={exceptionFormFor(w.id).exception_date}
                    onChange={(e) =>
                      updateExceptionForm(w.id, { exception_date: e.target.value })
                    }
                  />
                  <select
                    value={exceptionFormFor(w.id).kind}
                    onChange={(e) =>
                      updateExceptionForm(w.id, {
                        kind: e.target.value as "closed" | "capacity",
                      })
                    }
                  >
                    <option value="closed">إغلاق كامل</option>
                    <option value="capacity">تعديل السعة</option>
                  </select>
                  {exceptionFormFor(w.id).kind === "capacity" && (
                    <input
                      type="number"
                      min={1}
                      style={{ width: 70 }}
                      value={exceptionFormFor(w.id).capacity_override}
                      onChange={(e) =>
                        updateExceptionForm(w.id, {
                          capacity_override: Number(e.target.value),
                        })
                      }
                    />
                  )}
                  <button
                    className="button-link"
                    disabled={busy}
                    onClick={() => createException(w.id)}
                  >
                    إضافة استثناء
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
