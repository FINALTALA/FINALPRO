"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch, newIdempotencyKey } from "@/lib/api";
import { adminErrorMessage, formatDateTime, isForbidden } from "@/lib/admin";
import {
  AdminSizeGuideDetail,
  AUDIENCE_LABEL_AR,
  formatMeasure,
  MEASURE_KEYS,
  MEASURE_LABEL_AR,
  SizeGuideContent,
  SizeMeasureKey,
  sizeGuideAdminError,
} from "@/lib/sizeGuides";
import { useTaxonomy } from "@/lib/taxonomy";
import { useAdminGate } from "@/lib/useAdminGate";

const VERSION_STATUS_LABEL = { DRAFT: "مسودة", PUBLISHED: "منشور", RETIRED: "متقاعد" } as const;

interface DraftForm {
  basis: "BODY" | "GARMENT";
  notes_ar: string;
  notes_en: string;
  measurements: { key: SizeMeasureKey; is_range: boolean }[];
  rows: { size_code: string; values: Partial<Record<SizeMeasureKey, { min: string; max: string }>> }[];
}

interface Pair {
  category_code: string;
  audience: string;
  is_default: boolean;
}

function toForm(d: SizeGuideContent): DraftForm {
  return {
    basis: d.basis,
    notes_ar: d.notes_ar ?? "",
    notes_en: d.notes_en ?? "",
    measurements: d.measurements.map((m) => ({ key: m.key, is_range: m.is_range })),
    rows: d.rows.map((r) => ({
      size_code: r.size_code,
      values: Object.fromEntries(
        Object.entries(r.values).map(([k, v]) => [k, { min: v ? String(v.min) : "", max: v && v.max !== null ? String(v.max) : "" }]),
      ),
    })),
  };
}

/** Empty cells are left out (a draft may be incomplete); publishing checks completeness. */
function toBody(f: DraftForm) {
  const keys = new Map(f.measurements.map((m) => [m.key, m.is_range]));
  return {
    basis: f.basis,
    notes_ar: f.notes_ar.trim() || null,
    notes_en: f.notes_en.trim() || null,
    measurements: f.measurements,
    rows: f.rows.map((r) => ({
      size_code: r.size_code,
      values: Object.fromEntries(
        Object.entries(r.values)
          .filter(([k, v]) => keys.has(k as SizeMeasureKey) && v && v.min.trim() !== "")
          .map(([k, v]) => {
            const max = keys.get(k as SizeMeasureKey) && v!.max.trim() !== "" ? Number(v!.max) : undefined;
            return [k, max === undefined ? { min: Number(v!.min) } : { min: Number(v!.min), max }];
          }),
      ),
    })),
  };
}

// PD-4: one guide - rename, where it applies (standard guides), the
// draft table editor (the administrator types every value, in cm), and
// publish/retire with version history. A published version is never
// edited: changes go into a new draft copied from it.
export default function AdminSizeGuidePage() {
  const params = useParams<{ id: string }>();
  const gate = useAdminGate("ADMIN");
  const taxonomy = useTaxonomy();
  const [guide, setGuide] = useState<AdminSizeGuideDetail | null>(null);
  const [form, setForm] = useState<DraftForm | null>(null);
  const [dirty, setDirty] = useState(false);
  const [names, setNames] = useState({ name_ar: "", name_en: "" });
  const [pairs, setPairs] = useState<Pair[]>([]);
  const [newSize, setNewSize] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState(false);

  function adopt(g: AdminSizeGuideDetail) {
    setGuide(g);
    setNames({ name_ar: g.name_ar, name_en: g.name_en });
    setPairs(g.applicability.map((p) => ({ ...p })));
    setForm(g.draft ? toForm(g.draft) : null);
    setDirty(false);
  }

  useEffect(() => {
    if (gate.status !== "ok") return;
    apiFetch<AdminSizeGuideDetail>(`/admin/size-guides/${params.id}`)
      .then(adopt)
      .catch((err) => {
        if (isForbidden(err)) setForbidden(true);
        setError(adminErrorMessage(err));
      });
  }, [gate.status, params.id]);

  async function call(path: string, method: "POST" | "PUT", body: unknown, done: string, label: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      adopt(await apiFetch<AdminSizeGuideDetail>(`/admin/size-guides/${params.id}${path}`, { method, body, idempotencyKey: newIdempotencyKey(label) }));
      setNotice(done);
    } catch (err) {
      setError(sizeGuideAdminError(err));
    } finally {
      setBusy(false);
    }
  }

  const sizes = taxonomy.data?.sizes ?? [];
  const sizeLabel = (code: string) => sizes.find((s) => s.code === code)?.label ?? code;
  const usedSizes = new Set(form?.rows.map((r) => r.size_code) ?? []);
  const sizeOrder = new Map(sizes.map((s) => [s.code, s.sort_order]));

  function update(next: (f: DraftForm) => DraftForm) {
    setForm((f) => (f ? next(f) : f));
    setDirty(true);
  }

  function toggleMeasurement(key: SizeMeasureKey, on: boolean) {
    update((f) => ({
      ...f,
      measurements: on
        ? MEASURE_KEYS.filter((k) => k === key || f.measurements.some((m) => m.key === k)).map(
            (k) => f.measurements.find((m) => m.key === k) ?? { key: k, is_range: k !== "LENGTH" && k !== "FOOT_LENGTH" && k !== "HEIGHT" },
          )
        : f.measurements.filter((m) => m.key !== key),
    }));
  }

  function setCell(sizeCode: string, key: SizeMeasureKey, end: "min" | "max", value: string) {
    update((f) => ({
      ...f,
      rows: f.rows.map((r) =>
        r.size_code !== sizeCode
          ? r
          : { ...r, values: { ...r.values, [key]: { min: "", max: "", ...r.values[key], [end]: value } } },
      ),
    }));
  }

  function addSize() {
    if (!newSize) return;
    update((f) => ({
      ...f,
      rows: [...f.rows, { size_code: newSize, values: {} }].sort((a, b) => (sizeOrder.get(a.size_code) ?? 0) - (sizeOrder.get(b.size_code) ?? 0)),
    }));
    setNewSize("");
  }

  // TB-3: forbidden first - a non-admin never loads the guide, so "still
  // loading" must not be decided from the missing data alone.
  if (gate.status === "forbidden" || forbidden) {
    return (
      <div className="page-shell">
        <EmptyState title="هذه الصفحة لمدير المنصة فقط" actionHref="/account" actionLabel="حسابي" />
      </div>
    );
  }
  if (gate.status === "loading" || (!guide && !error)) {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 1000 }} />
      </div>
    );
  }
  if (!guide) {
    return (
      <div className="page-shell">
        <ErrorBanner message={error ?? "تعذّر تحميل الدليل"} />
        <Link href="/admin/size-guides" className="button-link">أدلة المقاسات</Link>
      </div>
    );
  }

  // Only categories a size guide can describe (the API refuses the rest).
  const categories = (taxonomy.data?.categories ?? []).filter((c) => c.size_guide !== false);
  const categoryName = (code: string) => taxonomy.data?.categories.find((c) => c.code === code)?.name_ar ?? code;

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 1100 }}>
        <div className="top-bar">
          <div>
            <h1 className="page-title" style={{ margin: 0 }}>{guide.name_ar}</h1>
            <span className="muted" dir="ltr">{guide.code}</span>{" "}
            <span className="badge">{guide.kind === "STANDARD" ? "قياسي" : `دليل منتج: ${guide.canonical_product?.name ?? ""}`}</span>{" "}
            {guide.published_version ? (
              <span className="badge badge-active">منشور - الإصدار {guide.published_version.version}</span>
            ) : (
              <span className="badge">غير منشور</span>
            )}
          </div>
          <Link href="/admin/size-guides" className="button-link">أدلة المقاسات</Link>
        </div>

        {error && <ErrorBanner message={error} />}
        {notice && <p className="muted" role="status">{notice}</p>}

        <section className="card" style={{ maxWidth: 560, marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>الاسم</h3>
          <div className="field">
            <label htmlFor="sg-name-ar">بالعربية</label>
            <input id="sg-name-ar" maxLength={120} value={names.name_ar} onChange={(e) => setNames({ ...names, name_ar: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="sg-name-en">بالإنجليزية</label>
            <input id="sg-name-en" dir="ltr" maxLength={120} value={names.name_en} onChange={(e) => setNames({ ...names, name_en: e.target.value })} />
          </div>
          <button
            className="button button-secondary"
            disabled={busy || (names.name_ar === guide.name_ar && names.name_en === guide.name_en)}
            onClick={() => call("", "PUT", { name_ar: names.name_ar.trim(), name_en: names.name_en.trim() }, "تم حفظ الاسم", "size-guide-rename")}
          >
            حفظ الاسم
          </button>
        </section>

        {guide.kind === "STANDARD" && (
          <section className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ marginTop: 0 }}>يطبَّق على</h3>
            <p className="muted">
              التصنيف والفئة اللذان يظهر لهما هذا الدليل. «افتراضي» يعني أنه يُستخدم لكل عرض في هذا التصنيف ما لم يختر المالك دليلاً آخر
              متاحاً.
            </p>
            {pairs.length === 0 && <p className="muted">لا يوجد ربط بعد - لن يظهر الدليل لأي عرض.</p>}
            <div className="admin-sg-pairs">
              {pairs.map((p, i) => {
                const cat = categories.find((c) => c.code === p.category_code);
                return (
                  <div key={i} className="admin-sg-pair">
                    <select
                      aria-label="التصنيف"
                      value={p.category_code}
                      onChange={(e) => {
                        const c = categories.find((x) => x.code === e.target.value);
                        setPairs(pairs.map((x, j) => (j === i ? { ...x, category_code: e.target.value, audience: c?.audiences.includes(x.audience) ? x.audience : c?.audiences[0] ?? "" } : x)));
                      }}
                    >
                      {categories.map((c) => (
                        <option key={c.code} value={c.code}>{c.name_ar}</option>
                      ))}
                    </select>
                    <select aria-label="الفئة" value={p.audience} onChange={(e) => setPairs(pairs.map((x, j) => (j === i ? { ...x, audience: e.target.value } : x)))}>
                      {(cat?.audiences ?? []).map((a) => (
                        <option key={a} value={a}>{AUDIENCE_LABEL_AR[a] ?? a}</option>
                      ))}
                    </select>
                    <label className="admin-sg-check">
                      <input type="checkbox" checked={p.is_default} onChange={(e) => setPairs(pairs.map((x, j) => (j === i ? { ...x, is_default: e.target.checked } : x)))} />
                      افتراضي
                    </label>
                    <button type="button" className="button-link" onClick={() => setPairs(pairs.filter((_, j) => j !== i))}>حذف</button>
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
              <button
                type="button"
                className="button-link"
                disabled={categories.length === 0}
                onClick={() => setPairs([...pairs, { category_code: categories[0].code, audience: categories[0].audiences[0] ?? "", is_default: false }])}
              >
                + ربط تصنيف
              </button>
              <button className="button" disabled={busy} onClick={() => call("/applicability", "PUT", { pairs }, "تم حفظ الربط", "size-guide-applicability")}>
                حفظ الربط
              </button>
            </div>
            {guide.applicability.length > 0 && (
              <p className="muted" style={{ fontSize: 13 }}>
                المحفوظ: {guide.applicability.map((p) => `${categoryName(p.category_code)} - ${AUDIENCE_LABEL_AR[p.audience] ?? p.audience}${p.is_default ? " (افتراضي)" : ""}`).join("، ")}
              </p>
            )}
          </section>
        )}

        <section className="card" style={{ marginBottom: 16 }}>
          <div className="top-bar" style={{ marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>{form ? `المسودة - الإصدار ${guide.draft_version?.version}` : "لا توجد مسودة"}</h3>
            {!form && (
              <button className="button button-secondary" disabled={busy} onClick={() => call("/versions", "POST", {}, "تم إنشاء مسودة من الإصدار المنشور", "size-guide-new-draft")}>
                إصدار جديد (نسخة من المنشور)
              </button>
            )}
          </div>
          {form && (
            <>
              <p className="muted">
                كل القيم بالسنتيمتر وبخانة عشرية واحدة على الأكثر. الخانات الفارغة تُحفظ في المسودة، لكن النشر يحتاج كل الخانات.
              </p>
              {guide.kind === "PRODUCT" ? (
                <div className="field" style={{ maxWidth: 320 }}>
                  <label htmlFor="sg-basis">أساس القياس</label>
                  <select id="sg-basis" value={form.basis} onChange={(e) => update((f) => ({ ...f, basis: e.target.value as DraftForm["basis"] }))}>
                    <option value="BODY">قياسات الجسم</option>
                    <option value="GARMENT">قياسات القطعة</option>
                  </select>
                </div>
              ) : (
                <p className="muted">أساس القياس: قياسات الجسم (الأدلة القياسية).</p>
              )}

              <fieldset className="admin-sg-measures">
                <legend>الأعمدة</legend>
                {MEASURE_KEYS.map((key) => {
                  const m = form.measurements.find((x) => x.key === key);
                  return (
                    <div key={key} className="admin-sg-measure">
                      <label className="admin-sg-check">
                        <input type="checkbox" checked={!!m} onChange={(e) => toggleMeasurement(key, e.target.checked)} />
                        {MEASURE_LABEL_AR[key]}
                      </label>
                      {m && (
                        <label className="admin-sg-check muted">
                          <input
                            type="checkbox"
                            checked={m.is_range}
                            onChange={(e) =>
                              update((f) => ({ ...f, measurements: f.measurements.map((x) => (x.key === key ? { ...x, is_range: e.target.checked } : x)) }))
                            }
                          />
                          مدى (من - إلى)
                        </label>
                      )}
                    </div>
                  );
                })}
              </fieldset>

              <div style={{ overflowX: "auto", marginTop: 12 }}>
                <table className="data-table admin-sg-editor">
                  <thead>
                    <tr>
                      <th>المقاس</th>
                      {form.measurements.map((m) => (
                        <th key={m.key}>{MEASURE_LABEL_AR[m.key]}{m.is_range ? " (من - إلى)" : ""}</th>
                      ))}
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {form.rows.map((r) => (
                      <tr key={r.size_code}>
                        <th scope="row">{sizeLabel(r.size_code)}</th>
                        {form.measurements.map((m) => {
                          const v = r.values[m.key];
                          const label = `${sizeLabel(r.size_code)} - ${MEASURE_LABEL_AR[m.key]}`;
                          return (
                            <td key={m.key}>
                              <span className="admin-sg-cell" dir="ltr">
                                <input inputMode="decimal" aria-label={m.is_range ? `${label} من` : label} value={v?.min ?? ""} onChange={(e) => setCell(r.size_code, m.key, "min", e.target.value)} />
                                {m.is_range && (
                                  <>
                                    <span aria-hidden="true">–</span>
                                    <input inputMode="decimal" aria-label={`${label} إلى`} value={v?.max ?? ""} onChange={(e) => setCell(r.size_code, m.key, "max", e.target.value)} />
                                  </>
                                )}
                              </span>
                            </td>
                          );
                        })}
                        <td>
                          <button type="button" className="button-link" onClick={() => update((f) => ({ ...f, rows: f.rows.filter((x) => x.size_code !== r.size_code) }))}>
                            حذف
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
                <select aria-label="إضافة مقاس" value={newSize} onChange={(e) => setNewSize(e.target.value)}>
                  <option value="">— إضافة مقاس —</option>
                  <optgroup label="البالغين">
                    {sizes.filter((s) => s.group === "ADULT" && !usedSizes.has(s.code)).map((s) => (
                      <option key={s.code} value={s.code}>{s.label}</option>
                    ))}
                  </optgroup>
                  <optgroup label="أعمار الأطفال">
                    {sizes.filter((s) => s.group === "KIDS_AGE" && !usedSizes.has(s.code)).map((s) => (
                      <option key={s.code} value={s.code}>{s.label}</option>
                    ))}
                  </optgroup>
                </select>
                <button type="button" className="button-link" disabled={!newSize} onClick={addSize}>إضافة</button>
              </div>

              <div className="field" style={{ marginTop: 12 }}>
                <label htmlFor="sg-notes-ar">طريقة القياس (تظهر للعميل)</label>
                <textarea id="sg-notes-ar" rows={3} maxLength={1000} value={form.notes_ar} onChange={(e) => update((f) => ({ ...f, notes_ar: e.target.value }))} />
              </div>
              <div className="field">
                <label htmlFor="sg-notes-en">طريقة القياس بالإنجليزية</label>
                <textarea id="sg-notes-en" dir="ltr" rows={3} maxLength={1000} value={form.notes_en} onChange={(e) => update((f) => ({ ...f, notes_en: e.target.value }))} />
              </div>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  className="button button-secondary"
                  disabled={busy || !dirty}
                  onClick={() => call(`/versions/${guide.draft_version!.id}`, "PUT", toBody(form), "تم حفظ المسودة", "size-guide-draft")}
                >
                  حفظ المسودة
                </button>
                <button
                  className="button"
                  disabled={busy || dirty}
                  title={dirty ? "احفظي المسودة أولاً" : undefined}
                  onClick={() => call(`/versions/${guide.draft_version!.id}/publish`, "POST", {}, "تم نشر الإصدار", "size-guide-publish")}
                >
                  نشر هذا الإصدار
                </button>
                {dirty && <span className="muted">تغييرات غير محفوظة</span>}
              </div>
            </>
          )}
        </section>

        {guide.published && (
          <section className="card" style={{ marginBottom: 16 }}>
            <div className="top-bar" style={{ marginBottom: 8 }}>
              <h3 style={{ margin: 0 }}>المنشور حالياً - الإصدار {guide.published.version}</h3>
              <button
                className="button-link"
                disabled={busy}
                onClick={() => {
                  if (window.confirm("إيقاف الدليل يخفيه عن العملاء فوراً. متابعة؟")) {
                    void call("/retire", "POST", {}, "تم إيقاف الدليل", "size-guide-retire");
                  }
                }}
              >
                إيقاف النشر
              </button>
            </div>
            <p className="muted">
              {guide.published.basis === "BODY" ? "قياسات الجسم" : "قياسات القطعة"} · سم · نُشر {guide.published.published_at ? formatDateTime(guide.published.published_at) : ""}
            </p>
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>المقاس</th>
                    {guide.published.measurements.map((m) => <th key={m.key}>{m.label_ar}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {guide.published.rows.map((r) => (
                    <tr key={r.size_code}>
                      <td>{r.size_label}</td>
                      {guide.published!.measurements.map((m) => <td key={m.key} dir="ltr">{formatMeasure(r.values[m.key], "cm")}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {guide.published.notes_ar && <p style={{ whiteSpace: "pre-line" }}>{guide.published.notes_ar}</p>}
          </section>
        )}

        <section className="card">
          <h3 style={{ marginTop: 0 }}>الإصدارات</h3>
          <ul>
            {guide.versions.map((v) => (
              <li key={v.id}>
                الإصدار {v.version} - {VERSION_STATUS_LABEL[v.status]}
                {v.published_at && <span className="muted"> (نُشر {formatDateTime(v.published_at)})</span>}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
