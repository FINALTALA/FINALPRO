"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import SafeImage from "@/components/SafeImage";
import { apiFetch, ApiError, IMAGE_UPLOAD_ACCEPT, newIdempotencyKey, uploadVendorImage } from "@/lib/api";
import { clearSession, getSessionToken } from "@/lib/session";
import StoreCoverControls from "@/components/StoreCoverControls";
import { loginRedirectHref } from "@/lib/loginRedirect";
import {
  coverLookBody,
  coverLookFromDto,
  coverLookProblem,
  type CoverLook,
  type StorefrontCoverDto,
} from "@/lib/storeCover";

// Sprint 8 (RB-STOREF-004, PDR-013).
type ApplicableCategory = "WOMEN" | "MEN" | "KIDS" | "ACCESSORIES";
const APPLICABLE_CATEGORIES: { value: ApplicableCategory; label: string }[] = [
  { value: "WOMEN", label: "نسائي" },
  { value: "MEN", label: "رجالي" },
  { value: "KIDS", label: "أطفال" },
  { value: "ACCESSORIES", label: "إكسسوارات" },
];

interface OwnerStorefrontDto extends StorefrontCoverDto {
  vendor_id: string;
  slug: string;
  display_name: string;
  hero_title: string | null;
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
  hero_title: string;
  logo_url: string;
  bio: string;
  cover_image_url: string;
  instagram_url: string;
  facebook_url: string;
  whatsapp_url: string;
};

function toForm(dto: OwnerStorefrontDto): FormState {
  return {
    display_name: dto.display_name ?? "",
    hero_title: dto.hero_title ?? "",
    logo_url: dto.logo_url ?? "",
    bio: dto.bio ?? "",
    cover_image_url: dto.cover_image_url ?? "",
    instagram_url: dto.instagram_url ?? "",
    facebook_url: dto.facebook_url ?? "",
    whatsapp_url: dto.whatsapp_url ?? "",
  };
}

// Sprint 7 (RB-STOREF-001): the owner's basic dashboard for editing
// storefront info. Sprint 26: logo/cover can be uploaded from the
// owner's device (POST /vendors/:id/uploads) or still pasted as a
// URL. Backend authorization
// (VendorMembershipGuard + @RequireVendorRole('OWNER')) is the real
// boundary - a BRANCH_EMPLOYEE reaching this page by URL still gets
// refused server-side on every request; this page does not attempt
// its own role check beyond "is there a session at all."
export default function StorefrontSettingsPage() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isManagementEmbed = searchParams.get("embed") === "management";
  const [dto, setDto] = useState<OwnerStorefrontDto | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  // The cover's layers (colour, strength, on/off) - the same controls as
  // the cover pencil on the public store page.
  const [look, setLook] = useState<CoverLook | null>(null);
  const [categories, setCategories] = useState<ApplicableCategory[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!getSessionToken()) {
      router.replace(loginRedirectHref());
      return;
    }
    apiFetch<OwnerStorefrontDto>(`/vendors/${params.vendorId}/storefront`)
      .then((res) => {
        setDto(res);
        setForm(toForm(res));
        setLook(coverLookFromDto(res));
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          router.replace(loginRedirectHref());
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

  function cancelEdits() {
    if (!dto) return;
    setForm(toForm(dto));
    setLook(coverLookFromDto(dto));
    setError(null);
    setNotice(null);
  }

  async function save() {
    if (!form || !dto) return;
    // Send only the fields the owner actually changed. Demo stores keep
    // relative asset paths (/demo-assets/...) that the API's URL
    // validation rightly rejects as user input - re-sending an
    // untouched value would make every save fail. Sprint 26: a field
    // emptied by the owner is sent as "" - the API's explicit "remove
    // this" (it then disappears from the public store page too).
    const original = toForm(dto);
    const body: Record<string, string | number | boolean> = {};
    for (const key of Object.keys(form) as (keyof FormState)[]) {
      const value = form[key].trim();
      if (value !== original[key].trim()) body[key] = value;
    }
    // The cover layers: only the settings that changed, like the rest.
    if (look) {
      const problem = coverLookProblem(look);
      if (problem) {
        setNotice(null);
        setError(problem);
        return;
      }
      const before = coverLookBody(coverLookFromDto(dto));
      const after = coverLookBody(look);
      for (const key of Object.keys(after) as (keyof typeof after)[]) {
        if (after[key] !== before[key]) body[key] = after[key];
      }
    }
    if (Object.keys(body).length === 0) {
      setError(null);
      setNotice("لا توجد تغييرات للحفظ");
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await apiFetch<OwnerStorefrontDto>(
        `/vendors/${params.vendorId}/storefront`,
        { method: "PUT", body },
      );
      setDto(updated);
      setForm(toForm(updated));
      setLook(coverLookFromDto(updated));
      setNotice("تم حفظ التغييرات");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "فشل حفظ التغييرات");
    } finally {
      setSaving(false);
    }
  }

  // Sprint 26: an image from the owner's device is uploaded and saved
  // to the store right away (no second "save" step to forget); other
  // unsaved edits in the form are kept as they are.
  async function uploadAndSave(field: "logo_url" | "cover_image_url", file: File) {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const { url } = await uploadVendorImage(params.vendorId, file);
      const updated = await apiFetch<OwnerStorefrontDto>(
        `/vendors/${params.vendorId}/storefront`,
        { method: "PUT", body: { [field]: url } },
      );
      setDto(updated);
      setForm((prev) => (prev ? { ...prev, [field]: url } : prev));
      setNotice(field === "logo_url" ? "تم رفع صورة المتجر وحفظها" : "تم رفع صورة الغلاف وحفظها");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر رفع الصورة");
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
    <div className={`page-shell storefront-settings-page${isManagementEmbed ? " storefront-settings-embed" : ""}`}>
      {!isManagementEmbed && (
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
      )}

      {error && <div className="error-banner" style={{ maxWidth: 560, width: "100%" }}>{error}</div>}
      {notice && <p className="muted" style={{ maxWidth: 560, width: "100%" }}>{notice}</p>}

      <div className="card storefront-settings-form" style={{ maxWidth: 560 }}>
        <section className="storefront-form-section storefront-basics-section">
          <div className="storefront-section-heading">
            <div><h2>المعلومات الأساسية</h2><p>معلومات المتجر التي تظهر للعملاء في صفحة المتجر.</p></div>
          </div>
          <div className="storefront-section-fields storefront-basic-fields">
            <div className="field storefront-identity-name">
              <label>اسم المتجر — يظهر في معلومات المتجر</label>
              <input
                value={form.display_name}
                placeholder="مثال: ركن الأناقة التجريبي"
                onChange={(e) => updateField("display_name", e.target.value)}
              />
            </div>
            <div className="field storefront-hero-title">
              <label>العنوان الرئيسي — يظهر بخط كبير</label>
              <input
                value={form.hero_title}
                placeholder="مثال: أناقة تناسب ذوقك"
                onChange={(e) => updateField("hero_title", e.target.value)}
              />
            </div>
            <div className="field storefront-identity-bio">
              <label>الوصف المختصر — يظهر بخط صغير تحت العنوان</label>
              <textarea
                value={form.bio}
                placeholder="مثال: اكتشفي تشكيلة المتجر واختاري ما يناسب ذوقك بسهولة."
                onChange={(e) => updateField("bio", e.target.value)}
                rows={3}
              />
            </div>
          </div>
        </section>

        <section className="storefront-form-section storefront-media-section">
          <div className="storefront-section-heading">
            <div><h2>صورة المتجر وصورة الغلاف</h2><p>ارفعي صورة من جهازك أو أضيفي رابطًا مباشرًا للصورة.</p></div>
          </div>
          <div className="storefront-section-fields storefront-media-fields">
        <div className="field storefront-media-field storefront-logo-field">
          <label>صورة المتجر</label>
          <div className="storefront-upload-row">
            <div className="storefront-image-slot storefront-logo-slot">
              {form.logo_url ? <SafeImage src={form.logo_url} alt="صورة المتجر الحالية" /> : <span>صورة المتجر</span>}
            </div>
            <div className="storefront-upload-area">
              <span>اسحب صورة المتجر هنا أو اضغط للاختيار</span>
          <input
            className="storefront-upload-control"
            type="file"
            accept={IMAGE_UPLOAD_ACCEPT}
            disabled={saving}
            aria-label="رفع صورة المتجر من جهازك"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) uploadAndSave("logo_url", file);
            }}
          />
            </div>
          </div>
          <input
            value={form.logo_url}
            onChange={(e) => updateField("logo_url", e.target.value)}
            placeholder="أو الصقي رابط صورة https://..."
            dir="ltr"
            style={{ marginTop: 6 }}
          />
        </div>
        <div className="field storefront-media-field storefront-cover-field">
          <label>صورة الغلاف</label>
          <div className="storefront-upload-row">
            <div className="storefront-image-slot storefront-cover-slot">
              {form.cover_image_url ? <SafeImage src={form.cover_image_url} alt="صورة الغلاف الحالية" /> : <span>غلاف</span>}
            </div>
            <div className="storefront-upload-area">
              <span>اسحب صورة الغلاف هنا أو اضغط للاختيار</span>
          <input
            className="storefront-upload-control"
            type="file"
            accept={IMAGE_UPLOAD_ACCEPT}
            disabled={saving}
            aria-label="رفع صورة غلاف من جهازك"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) uploadAndSave("cover_image_url", file);
            }}
          />
            </div>
          </div>
          <input
            value={form.cover_image_url}
            onChange={(e) => updateField("cover_image_url", e.target.value)}
            placeholder="أو الصقي رابط صورة https://..."
            dir="ltr"
            style={{ marginTop: 6 }}
          />
          <small className="muted">JPG / PNG / WebP / GIF - حتى 5 ميغابايت. تُحفظ الصورة المرفوعة مباشرة.</small>
        </div>
          </div>
        </section>

        <section className="storefront-form-section storefront-color-section">
          <div className="storefront-section-heading">
            <div><h2>طبقات الغلاف <span>اختياري</span></h2><p>تحكّمي بكل طبقة فوق صورة الغلاف على حدة: إظهارها أو إخفاؤها، لونها وقوتها.</p></div>
          </div>
          {look && (
            <StoreCoverControls
              look={look}
              disabled={saving}
              onChange={(patch) => setLook((prev) => (prev ? { ...prev, ...patch } : prev))}
            />
          )}
        </section>

        <section className="storefront-form-section storefront-social-section">
          <div className="storefront-section-heading">
            <div><h2>روابط التواصل الاجتماعي</h2><p>تظهر الأيقونات للزوار عند إضافة رابط صحيح.</p></div>
          </div>
          <div className="storefront-section-fields storefront-social-fields">
        <div className="field">
          <label>رابط إنستغرام</label>
          <input
            value={form.instagram_url}
            onChange={(e) => updateField("instagram_url", e.target.value)}
            placeholder="https://instagram.com/اسم-المتجر"
            dir="ltr"
          />
        </div>
        <div className="field">
          <label>رابط فيسبوك</label>
          <input
            value={form.facebook_url}
            onChange={(e) => updateField("facebook_url", e.target.value)}
            placeholder="https://facebook.com/اسم-المتجر"
            dir="ltr"
          />
        </div>
        <div className="field">
          <label>رابط واتساب</label>
          <input
            value={form.whatsapp_url}
            onChange={(e) => updateField("whatsapp_url", e.target.value)}
            placeholder="https://wa.me/970591234567"
            dir="ltr"
          />
        </div>
          </div>
        </section>
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          كل ما تدخلينه هنا يظهر للزبائن في صفحة المتجر: صورة المتجر والغلاف والنبذة، وأيقونات
          التواصل لكل رابط موجود (وزر واتساب ثابت على الجوال). امسحي أي حقل واحفظي لإخفائه.
        </p>

        <div className="storefront-form-footer">
          <button className="button storefront-settings-save" onClick={save} disabled={saving}>حفظ التغييرات</button>
          <button className="button storefront-settings-cancel" onClick={cancelEdits} disabled={saving}>إلغاء</button>
          <button className="button storefront-settings-publish" onClick={togglePublish} disabled={saving}>
            {dto.is_published ? "إلغاء نشر المتجر" : "نشر المتجر"}
          </button>
        </div>
      </div>

      {/* Sprint 8 (RB-STOREF-004, PDR-013): required (>=1) before
          publish - see StorefrontController.publish()'s own check. */}
      <div className="card storefront-settings-taxonomy" style={{ maxWidth: 560, marginTop: 16 }}>
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
        <button className="button storefront-settings-categories-save" onClick={saveCategories} disabled={saving}>
          حفظ الأنواع
        </button>
      </div>

      <div className="storefront-settings-links" style={{ maxWidth: 560, width: "100%", marginTop: 16 }}>
        <Link href={`/vendor/${params.vendorId}/offers?open=collections`} className="button-link">
          مجموعات المتجر ←
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
