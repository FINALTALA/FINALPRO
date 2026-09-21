"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { clearSession, getSessionToken } from "@/lib/session";

interface StoreSectionDto {
  id: string;
  name: string;
  sort_order: number;
  offer_ids: string[];
}

interface VendorOfferDto {
  id: string;
  title_ar: string;
  title_en: string;
  status: string;
}

// Sprint 8 (RB-STOREF-002, PDR-012): owner-only dashboard for the up-to-
// 20 custom sections - create/rename/reorder/delete, and assigning this
// vendor's own offers into a section (a product may be in several).
// Fixed All and the automatic New arrivals/Discounts sections are never
// editable here - they only ever appear on the public store page (see
// StoreOffersPublicController). Backend authorization
// (VendorMembershipGuard + @RequireVendorRole('OWNER')) is the real
// boundary, the same as every other owner-only page in this codebase.
export default function StoreSectionsPage() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const [sections, setSections] = useState<StoreSectionDto[] | null>(null);
  const [offers, setOffers] = useState<VendorOfferDto[] | null>(null);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function load() {
    apiFetch<StoreSectionDto[]>(`/vendors/${params.vendorId}/sections`)
      .then(setSections)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          router.replace("/login");
          return;
        }
        setError(err instanceof ApiError ? err.message : "تعذّر تحميل الأقسام");
      });
    apiFetch<VendorOfferDto[]>(`/vendors/${params.vendorId}/offers`)
      .then(setOffers)
      .catch(() => {
        // Non-fatal - the sections list above already surfaces
        // auth/not-found errors for this same vendor.
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

  async function createSection() {
    if (!newName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/vendors/${params.vendorId}/sections`, {
        method: "POST",
        body: { name: newName.trim() },
      });
      setNewName("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر إنشاء القسم");
    } finally {
      setBusy(false);
    }
  }

  async function renameSection(id: string, name: string) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/vendors/${params.vendorId}/sections/${id}`, {
        method: "PUT",
        body: { name },
      });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر تعديل الاسم");
    } finally {
      setBusy(false);
    }
  }

  async function deleteSection(id: string) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/vendors/${params.vendorId}/sections/${id}`, {
        method: "DELETE",
      });
      setNotice("تم حذف القسم (المنتجات نفسها لم تُحذف)");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر حذف القسم");
    } finally {
      setBusy(false);
    }
  }

  async function move(id: string, direction: -1 | 1) {
    if (!sections) return;
    const index = sections.findIndex((s) => s.id === id);
    const swapWith = index + direction;
    if (swapWith < 0 || swapWith >= sections.length) return;
    const reordered = [...sections];
    [reordered[index], reordered[swapWith]] = [
      reordered[swapWith],
      reordered[index],
    ];
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/vendors/${params.vendorId}/sections/reorder`, {
        method: "POST",
        body: { section_ids: reordered.map((s) => s.id) },
      });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر إعادة الترتيب");
    } finally {
      setBusy(false);
    }
  }

  async function toggleOfferInSection(
    sectionId: string,
    offerId: string,
    checked: boolean,
  ) {
    setBusy(true);
    setError(null);
    try {
      if (checked) {
        await apiFetch(
          `/vendors/${params.vendorId}/sections/${sectionId}/offers/${offerId}`,
          { method: "PUT" },
        );
      } else {
        await apiFetch(
          `/vendors/${params.vendorId}/sections/${sectionId}/offers/${offerId}`,
          { method: "DELETE" },
        );
      }
      // Reflect the server's own state (GET :vendorId/sections' offer_ids)
      // rather than assuming the call succeeded exactly as requested -
      // reloading keeps this page as the source of truth it already is
      // for the sections list itself.
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر تحديث القسم");
    } finally {
      setBusy(false);
    }
  }

  if (error && !sections) {
    return (
      <div className="page-shell">
        <div className="error-banner" style={{ maxWidth: 560 }}>{error}</div>
      </div>
    );
  }

  if (!sections) {
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
          أقسام المتجر
        </div>
        <Link href={`/vendor/${params.vendorId}/storefront`} className="button-link">
          العودة لإعدادات المتجر
        </Link>
      </div>

      {error && <div className="error-banner" style={{ maxWidth: 560 }}>{error}</div>}
      {notice && <p className="muted" style={{ maxWidth: 560 }}>{notice}</p>}
      <p className="muted" style={{ maxWidth: 560 }}>
        قسم &quot;الكل&quot; ثابت دائماً، و&quot;وصل حديثاً&quot; و&quot;تخفيضات&quot;
        تلقائيان - لا يمكن تعديلهما هنا. يمكن إنشاء حتى 20 قسماً مخصصاً.
      </p>

      <div className="card" style={{ maxWidth: 560 }}>
        <div className="field">
          <label>اسم قسم جديد</label>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} />
        </div>
        <button className="button" onClick={createSection} disabled={busy}>
          إضافة قسم
        </button>
      </div>

      <div style={{ maxWidth: 560, width: "100%", display: "flex", flexDirection: "column", gap: 12, marginTop: 16 }}>
        {sections.length === 0 && <p className="muted">لا توجد أقسام مخصصة بعد.</p>}
        {sections.map((section, index) => (
          <div key={section.id} className="card">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                defaultValue={section.name}
                onBlur={(e) => {
                  if (e.target.value.trim() && e.target.value !== section.name) {
                    renameSection(section.id, e.target.value.trim());
                  }
                }}
                style={{ flex: 1 }}
              />
              <button
                className="button-link"
                disabled={busy || index === 0}
                onClick={() => move(section.id, -1)}
              >
                ↑
              </button>
              <button
                className="button-link"
                disabled={busy || index === sections.length - 1}
                onClick={() => move(section.id, 1)}
              >
                ↓
              </button>
              <button
                className="button-link"
                disabled={busy}
                onClick={() => deleteSection(section.id)}
              >
                حذف
              </button>
            </div>

            {offers && offers.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div className="muted">المنتجات في هذا القسم:</div>
                {offers.map((offer) => (
                  <label
                    key={offer.id}
                    style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}
                  >
                    <input
                      type="checkbox"
                      checked={section.offer_ids.includes(offer.id)}
                      onChange={(e) =>
                        toggleOfferInSection(section.id, offer.id, e.target.checked)
                      }
                    />
                    {offer.title_ar}
                  </label>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
