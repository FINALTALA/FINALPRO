"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { isUnauthorized } from "@/lib/apiErrors";
import { registerTranslations } from "@/lib/i18n";
import { useT } from "@/lib/useLang";
import { useSessionExpiredRedirect } from "@/lib/useSessionExpiredRedirect";

registerTranslations({
  ar: {
    "mystatus.title": "حالة المتجر",
    "mystatus.publish": "النشر",
    "mystatus.published": "منشور - يظهر للعملاء",
    "mystatus.unpublished": "غير منشور - لا يظهر للعملاء بعد",
    "mystatus.verification": "التحقق",
    "mystatus.v.approved": "معتمد",
    "mystatus.v.pending": "قيد المراجعة",
    "mystatus.v.none": "لم يُقدَّم دليل تحقق بعد",
    "mystatus.v.rejected": "مرفوض نهائياً - يمكن تقديم طلب جديد مصحَّح من الحساب",
    "mystatus.v.suspended": "المتجر معلَّق - مخفي ولا يقبل طلبات جديدة",
    "mystatus.action": "يحتاج إجراء",
    "mystatus.action.resubmit": "{name}: مطلوب إعادة إرسال الدليل بعد تصحيحه",
    "mystatus.action.rejected": "{name}: رُفض الدليل - راجع ملاحظة المراجع",
    "mystatus.warehouse": "عنوان المستودع",
    "mystatus.details": "عرض تفاصيل التحقق",
    "mystatus.failed": "تعذّر تحميل حالة التحقق.",
  },
  en: {
    "mystatus.title": "Store status",
    "mystatus.publish": "Publishing",
    "mystatus.published": "Published - customers can see it",
    "mystatus.unpublished": "Not published - customers cannot see it yet",
    "mystatus.verification": "Verification",
    "mystatus.v.approved": "Approved",
    "mystatus.v.pending": "Under review",
    "mystatus.v.none": "No verification evidence submitted yet",
    "mystatus.v.rejected": "Finally rejected - a corrected new application can be made from the account",
    "mystatus.v.suspended": "The store is suspended - hidden and not taking new orders",
    "mystatus.action": "Needs action",
    "mystatus.action.resubmit": "{name}: send the evidence again after correcting it",
    "mystatus.action.rejected": "{name}: the evidence was rejected - see the reviewer's note",
    "mystatus.warehouse": "Warehouse address",
    "mystatus.details": "View verification details",
    "mystatus.failed": "Could not load the verification status.",
  },
});

interface StatusDto {
  vendor: { status: string };
  branches: { id: string; name: string; status: string; evidence_submitted: boolean }[];
  warehouse: { status: string } | null;
  suspension: { reason_code: string } | null;
}
const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? "");

/**
 * «حالة المتجر» inside «صفحتي» (2026-11-23, replacing the «حالة التحقق»
 * card): publishing, the verification state in one line, and what needs
 * the owner's action - read from the same owner-only API as the
 * verification page (GET /vendors/:id/verification-status). «عرض تفاصيل
 * التحقق» opens that page unchanged (every note and status), pushed in the
 * same window so «رجوع» returns to «صفحتي».
 */
export default function StoreStatusSection({ vendorId, published }: { vendorId: string; published: boolean }) {
  const t = useT();
  const onExpired = useSessionExpiredRedirect();
  const [status, setStatus] = useState<StatusDto | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    apiFetch<StatusDto>(`/vendors/${vendorId}/verification-status`).then(
      (s) => alive && setStatus(s),
      (err: unknown) => {
        if (!alive) return;
        if (isUnauthorized(err)) return onExpired();
        setFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [vendorId, onExpired]);

  const items = status ? [...status.branches.map((b) => ({ name: b.name, status: b.status, submitted: b.evidence_submitted })), ...(status.warehouse ? [{ name: t("mystatus.warehouse"), status: status.warehouse.status, submitted: true }] : [])] : [];
  const actions = items.filter((i) => i.submitted && (i.status === "RESUBMISSION_REQUESTED" || i.status === "REJECTED"));
  const verification = !status
    ? null
    : status.suspension
      ? { key: "mystatus.v.suspended", tone: "warn" }
      : status.vendor.status === "REJECTED"
        ? { key: "mystatus.v.rejected", tone: "warn" }
        : items.filter((i) => i.submitted).length === 0
          ? { key: "mystatus.v.none", tone: "quiet" }
          : items.some((i) => i.submitted && i.status === "PENDING")
            ? { key: "mystatus.v.pending", tone: "quiet" }
            : actions.length === 0
              ? { key: "mystatus.v.approved", tone: "ok" }
              : null;

  return (
    <section className="mystatus" aria-labelledby="mystatus-title" data-testid="mystatus">
      <h2 id="mystatus-title" className="mystatus-title">{t("mystatus.title")}</h2>
      <dl className="mystatus-facts">
        <div>
          <dt>{t("mystatus.publish")}</dt>
          <dd data-testid="mystatus-publish" className={published ? "is-ok" : "is-quiet"}>{published ? t("mystatus.published") : t("mystatus.unpublished")}</dd>
        </div>
        <div>
          <dt>{t("mystatus.verification")}</dt>
          <dd data-testid="mystatus-verification" className={verification ? `is-${verification.tone}` : "is-warn"}>
            {failed ? t("mystatus.failed") : !status ? "…" : verification ? t(verification.key) : t("mystatus.action")}
          </dd>
        </div>
      </dl>
      {actions.length > 0 && (
        <div className="mystatus-actions" role="status" data-testid="mystatus-actions">
          <strong>{t("mystatus.action")}:</strong>
          <ul>
            {actions.map((a) => (
              <li key={a.name} dir="auto">{fill(t(a.status === "REJECTED" ? "mystatus.action.rejected" : "mystatus.action.resubmit"), { name: a.name })}</li>
            ))}
          </ul>
        </div>
      )}
      <Link href={`/vendor/${vendorId}/verification`} className="mystatus-link" data-testid="mystatus-details">
        {t("mystatus.details")}
      </Link>
    </section>
  );
}
