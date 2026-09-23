"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch, ApiError, newIdempotencyKey } from "@/lib/api";
import { clearSession, getSessionToken } from "@/lib/session";

// Sprint 8 (RB-STOREF-004, PDR-013).
type ApplicableCategory = "WOMEN" | "MEN" | "KIDS" | "ACCESSORIES";
const APPLICABLE_CATEGORIES: { value: ApplicableCategory; label: string }[] = [
  { value: "WOMEN", label: "نسائي" },
  { value: "MEN", label: "رجالي" },
  { value: "KIDS", label: "أطفال" },
  { value: "ACCESSORIES", label: "إكسسوارات" },
];

interface OwnerStorefrontDto {
  vendor_id: string;
  slug: string;
  display_name: string;
  logo_url: string | null;
  bio: string | null;
  cover_image_url: string | null;
  cover_color: string | null;
  instagram_url: string | null;
  facebook_url: string | null;
  whatsapp_url: string | null;
  is_published: boolean;
}

type FormState = {
  display_name: string;
  logo_url: string;
  bio: string;
  cover_image_url: string;
  cover_color: string;
  instagram_url: string;
  facebook_url: string;
  whatsapp_url: string;
};

function toForm(dto: OwnerStorefrontDto): FormState {
  return {
    display_name: dto.display_name ?? "",
    logo_url: dto.logo_url ?? "",
    bio: dto.bio ?? "",
    cover_image_url: dto.cover_image_url ?? "",
    cover_color: dto.cover_color ?? "",
    instagram_url: dto.instagram_url ?? "",
    facebook_url: dto.facebook_url ?? "",
    whatsapp_url: dto.whatsapp_url ?? "",
  };
}

// Sprint 7 (RB-STOREF-001): the owner's basic dashboard for editing
// storefront info - deliberately simple (no image upload widget, just
// a URL field, matching how OfferVariantMedia/StoreBranch.
// verificationPhotoUrl already work in this codebase: no upload
// pipeline exists anywhere yet). Backend authorization
// (VendorMembershipGuard + @RequireVendorRole('OWNER')) is the real
// boundary - a BRANCH_EMPLOYEE reaching this page by URL still gets
// refused server-side on every request; this page does not attempt
// its own role check beyond "is there a session at all."
export default function StorefrontSettingsPage() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const [dto, setDto] = useState<OwnerStorefrontDto | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [categories, setCategories] = useState<ApplicableCategory[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!getSessionToken()) {
      router.replace("/login");
      return;
    }
    apiFetch<OwnerStorefrontDto>(`/vendors/${params.vendorId}/storefront`)
      .then((res) => {
        setDto(res);
        setForm(toForm(res));
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          router.replace("/login");
          return;
        }
        setError(
          err instanceof ApiError ? err.message : "تعذّر تحميل إعدادات المتجر",
        );
      });
    apiFetch<{ categories: ApplicableCategory[] }>(
      `/vendors/${params.vendorId}/applicable-categories`,
    )
      .then((res) => setCategories(res.categories))
      .catch(() => {
        // Non-fatal to the page - the storefront-settings fetch above
        // already surfaces auth/not-found errors for this same vendor.
      });
  }, [params.vendorId, router]);

  function toggleCategory(value: ApplicableCategory) {
    setCategories((prev) => {
      const current = prev ?? [];
      return current.includes(value)
        ? current.filter((c) => c !== value)
        : [...current, value];
    });
  }

  async function saveCategories() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch<{ categories: ApplicableCategory[] }>(
        `/vendors/${params.vendorId}/applicable-categories`,
        { method: "PUT", body: { categories: categories ?? [] } },
      );
      setCategories(res.categories);
      setNotice("تم حفظ الأنواع المطبّقة على المتجر");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "فشل حفظ الأنواع");
    } finally {
      setSaving(false);
    }
  }

  function updateField(field: keyof FormState, value: string) {
    setForm((prev) => (prev ? { ...prev, [field]: value } : prev));
  }

  async function save() {
    if (!form) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const body: Record<string, string> = {};
      for (const [key, value] of Object.entries(form)) {
        if (value.trim() !== "") body[key] = value.trim();
      }
      const updated = await apiFetch<OwnerStorefrontDto>(
        `/vendors/${params.vendorId}/storefront`,
        { method: "PUT", body },
      );
      setDto(updated);
      setForm(toForm(updated));
      setNotice("تم حفظ التغييرات");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "فشل حفظ التغييرات");
    } finally {
      setSaving(false);
    }
  }

  async function togglePublish() {
    if (!dto) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const action = dto.is_published ? "unpublish" : "publish";
      const updated = await apiFetch<OwnerStorefrontDto>(
        `/vendors/${params.vendorId}/storefront/${action}`,
        { method: "POST", idempotencyKey: newIdempotencyKey(action) },
      );
      setDto(updated);
      setNotice(updated.is_published ? "تم نشر المتجر" : "تم إلغاء نشر المتجر");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر تنفيذ العملية");
    } finally {
      setSaving(false);
    }
  }

  if (error && !dto) {
    return (
      <div className="page-shell">
        <div className="error-banner" style={{ maxWidth: 560, width: "100%" }}>
          {error}
        </div>
      </div>
    );
  }

  if (!dto || !form) {
    return (
      <div className="page-shell">
        <p className="muted">جارٍ التحميل...</p>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="top-bar">
        <div className="brand" style={{ margin: 0 }}>
          إعدادات صفحة المتجر
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className={`badge${dto.is_published ? " badge-active" : ""}`}>
            {dto.is_published ? "منشور" : "غير منشور"}
          </span>
          <Link href={`/vendor/${params.vendorId}`} className="button-link">
            لوحة المتجر
          </Link>
          <Link href={`/store/${dto.slug}`} className="button-link">
            عرض الصفحة العامة
          </Link>
        </div>
      </div>

      {/* Sprint 13: live preview of the logo/cover as entered below.
          Links only - there is no upload backend; a broken URL simply
          shows no image here before it is ever saved. */}
      {form && (
        <div className="preview-box" style={{ maxWidth: 560, width: "100%" }} aria-label="معاينة">
          <div
            className="preview-cover"
            style={{
              backgroundColor: form.cover_color || undefined,
              backgroundImage: form.cover_image_url ? `url(${form.cover_image_url})` : undefined,
            }}
          />
          {form.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={form.logo_url} alt="معاينة الشعار" className="preview-logo" />
          ) : (
            <div className="preview-logo" />
          )}
          <div style={{ padding: "0 16px 14px", fontWeight: 700 }}>{form.display_name}</div>
        </div>
      )}

      {error && <div className="error-banner" style={{ maxWidth: 560, width: "100%" }}>{error}</div>}
      {notice && <p className="muted" style={{ maxWidth: 560, width: "100%" }}>{notice}</p>}

      <div className="card" style={{ maxWidth: 560 }}>
        <div className="field">
          <label>اسم المتجر الظاهر للعملاء</label>
          <input
            value={form.display_name}
            onChange={(e) => updateField("display_name", e.target.value)}
          />
        </div>
        <div className="field">
          <label>نبذة عن المتجر</label>
          <input value={form.bio} onChange={(e) => updateField("bio", e.target.value)} />
        </div>
        <div className="field">
          <label>رابط الشعار (logo)</label>
          <input
            value={form.logo_url}
            onChange={(e) => updateField("logo_url", e.target.value)}
          />
        </div>
        <div className="field">
          <label>رابط صورة الغلاف</label>
          <input
            value={form.cover_image_url}
            onChange={(e) => updateField("cover_image_url", e.target.value)}
          />
        </div>
        <div className="field">
          <label>لون الغلاف (اختياري بدل الصورة)</label>
          <input
            value={form.cover_color}
            onChange={(e) => updateField("cover_color", e.target.value)}
            placeholder="#4338ca"
          />
        </div>
        <div className="field">
          <label>رابط إنستغرام</label>
          <input
            value={form.instagram_url}
            onChange={(e) => updateField("instagram_url", e.target.value)}
          />
        </div>
        <div className="field">
          <label>رابط فيسبوك</label>
          <input
            value={form.facebook_url}
            onChange={(e) => updateField("facebook_url", e.target.value)}
          />
        </div>
        <div className="field">
          <label>رابط واتساب</label>
          <input
            value={form.whatsapp_url}
            onChange={(e) => updateField("whatsapp_url", e.target.value)}
          />
        </div>

        <button className="button" onClick={save} disabled={saving}>
          حفظ التغييرات
        </button>
        <div style={{ height: 10 }} />
        <button className="button" onClick={togglePublish} disabled={saving}>
          {dto.is_published ? "إلغاء نشر المتجر" : "نشر المتجر"}
        </button>
      </div>

      {/* Sprint 8 (RB-STOREF-004, PDR-013): required (>=1) before
          publish - see StorefrontController.publish()'s own check. */}
      <div className="card" style={{ maxWidth: 560, marginTop: 16 }}>
        <div className="field">
          <label>الأنواع المطبّقة على المتجر (لصفحات الاكتشاف)</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {APPLICABLE_CATEGORIES.map((c) => (
              <label
                key={c.value}
                style={{ display: "flex", alignItems: "center", gap: 6 }}
              >
                <input
                  type="checkbox"
                  checked={(categories ?? []).includes(c.value)}
                  onChange={() => toggleCategory(c.value)}
                />
                {c.label}
              </label>
            ))}
          </div>
        </div>
        <button className="button" onClick={saveCategories} disabled={saving}>
          حفظ الأنواع
        </button>
      </div>

      <div style={{ maxWidth: 560, width: "100%", marginTop: 16 }}>
        <Link href={`/vendor/${params.vendorId}/sections`} className="button-link">
          إدارة أقسام المتجر ←
        </Link>
        <div style={{ height: 8 }} />
        <Link href={`/vendor/${params.vendorId}/delivery-windows`} className="button-link">
          تقويم نوافذ التوصيل ←
        </Link>
        <div style={{ height: 8 }} />
        <Link href={`/vendor/${params.vendorId}/delivery-zones`} className="button-link">
          مناطق ورسوم التوصيل ←
        </Link>
        <div style={{ height: 8 }} />
        <Link href={`/vendor/${params.vendorId}/orders`} className="button-link">
          طلبات جميع الفروع ←
        </Link>
      </div>
    </div>
  );
}
