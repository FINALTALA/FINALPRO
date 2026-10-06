"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import SafeImage from "@/components/SafeImage";
import { EmptyState, ErrorBanner } from "@/components/States";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import {
  adminErrorMessage,
  formatDateTime,
  reasonProblem,
} from "@/lib/admin";
import { useAdminGate } from "@/lib/useAdminGate";
import { useFetch } from "@/lib/useFetch";

interface BranchEvidence {
  vendor_id: string;
  branch_id: string;
  evidence_revision: number;
  lat: number;
  lng: number;
  photo_url: string;
  status: string;
  submitted_at: string | null;
}

interface WarehouseEvidence {
  id: string;
  vendor_id: string;
  warehouse_id: string;
  lat: number;
  lng: number;
  address_note: string;
  status: string;
  submitted_at: string;
}

type Decision = "approve" | "reject" | "request_resubmission";

const DECISION_LABEL: Record<Decision, string> = {
  approve: "اعتماد",
  reject: "رفض (يرفض الطلب كاملاً)",
  request_resubmission: "طلب إعادة إرسال الدليل",
};

const DONE_LABEL: Record<Decision, string> = {
  approve: "تم اعتماد الدليل.",
  reject: "تم رفض الدليل ورفض طلب المتجر.",
  request_resubmission: "تم طلب إعادة إرسال الدليل من صاحب المتجر.",
};

const isHttpUrl = (u: string) => /^https?:\/\//i.test(u);

function DecisionForm({
  path,
  buildBody,
  onStale,
}: {
  path: string;
  buildBody: (decision: Decision, reason: string) => Record<string, unknown>;
  onStale: () => void;
}) {
  const [decision, setDecision] = useState<Decision>("approve");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [done, setDone] = useState<Decision | null>(null);
  const needsReason = decision !== "approve";
  const problem = needsReason ? reasonProblem(reason) : null;

  async function submit() {
    if (problem) return;
    setBusy(true);
    setError(null);
    setStale(false);
    try {
      await apiFetch(path, {
        method: "POST",
        body: buildBody(decision, reason),
        idempotencyKey: newIdempotencyKey("verification-decision"),
      });
      setDone(decision);
    } catch (err) {
      setError(adminErrorMessage(err));
      if (
        err instanceof ApiError &&
        (err.code === "BRANCH_EVIDENCE_STALE" || err.code === "WAREHOUSE_EVIDENCE_STALE")
      ) {
        setStale(true);
      }
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="card" style={{ maxWidth: "none" }}>
        <div className="notice-banner" role="status">{DONE_LABEL[done]}</div>
        <Link href="/admin/verification" className="button">العودة إلى الطابور</Link>
      </div>
    );
  }

  return (
    <div className="card" style={{ maxWidth: "none" }}>
      <h2 style={{ marginTop: 0 }}>القرار</h2>
      {error && <ErrorBanner message={error} />}
      {stale && (
        <div style={{ marginBottom: 12 }}>
          <button className="button button-secondary" onClick={onStale}>
            إعادة تحميل الدليل
          </button>
        </div>
      )}
      <fieldset style={{ border: 0, padding: 0, margin: "0 0 12px" }}>
        {(Object.keys(DECISION_LABEL) as Decision[]).map((d) => (
          <label key={d} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
            <input
              type="radio"
              name="decision"
              checked={decision === d}
              disabled={busy}
              onChange={() => setDecision(d)}
            />
            {DECISION_LABEL[d]}
          </label>
        ))}
      </fieldset>
      {needsReason && (
        <div className="field">
          <label htmlFor="reason">السبب (يراه صاحب المتجر)</label>
          <textarea
            id="reason"
            rows={4}
            value={reason}
            disabled={busy}
            onChange={(e) => setReason(e.target.value)}
            aria-invalid={problem !== null && reason.length > 0}
          />
          <span className="muted">{reason.trim().length} / 1000</span>
          {problem && reason.length > 0 && <span className="field-error">{problem}</span>}
        </div>
      )}
      <button className="button" onClick={submit} disabled={busy || problem !== null}>
        {busy ? "جارٍ الإرسال..." : "تأكيد القرار"}
      </button>
    </div>
  );
}

function ReviewInner() {
  const gate = useAdminGate();
  const params = useParams<{ vendorId: string }>();
  const search = useSearchParams();
  const kind = search.get("kind");
  const item = search.get("item");
  const [nonce, setNonce] = useState(0);

  const valid = (kind === "BRANCH" || kind === "WAREHOUSE") && !!item;
  const enabled = gate.status === "ok" && valid;
  const branchPath =
    enabled && kind === "BRANCH"
      ? `/vendors/${params.vendorId}/branches/${item}/verification-evidence?r=${nonce}`
      : null;
  const warehousePath =
    enabled && kind === "WAREHOUSE"
      ? `/vendors/${params.vendorId}/warehouse/verification-evidence?r=${nonce}`
      : null;
  // Each successful load of either path is one AUDITED read on the server.
  const branch = useFetch<BranchEvidence>(branchPath, true);
  const warehouse = useFetch<WarehouseEvidence>(warehousePath, true);
  const evidence = kind === "BRANCH" ? branch : warehouse;

  if (gate.status === "loading") {
    return <div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 800 }} />;
  }
  if (gate.status === "forbidden" || evidence.status === 403) {
    return <EmptyState title="هذه الصفحة لموظفي المنصة فقط" actionHref="/account" actionLabel="حسابي" />;
  }
  if (!valid) {
    return (
      <EmptyState
        title="رابط المراجعة غير صالح"
        actionHref="/admin/verification"
        actionLabel="العودة إلى الطابور"
      />
    );
  }
  if (evidence.loading) {
    return (
      <div aria-busy="true" aria-label="جارٍ التحميل">
        <div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 800 }} />
      </div>
    );
  }
  if (evidence.status === 404) {
    return (
      <EmptyState
        title="لا يوجد دليل معلّق"
        message="ربما بُتّ فيه بالفعل أو أعاد صاحب المتجر إرساله. راجعي الطابور."
        actionHref="/admin/verification"
        actionLabel="العودة إلى الطابور"
      />
    );
  }
  if (evidence.error || !evidence.data) {
    return <ErrorBanner message={evidence.error ?? "تعذّر تحميل الدليل"} />;
  }

  const shownPhoto = kind === "BRANCH" ? (branch.data?.photo_url ?? "") : "";
  const data = evidence.data;

  return (
    <div style={{ maxWidth: 800, width: "100%" }}>
      <div className="warning-banner">
        هذه البيانات سرّية: لا تُعرض للعامة ولا لأصحاب المتاجر عبر هذا المسار. تم تسجيل فتحك لها في سجل التدقيق.
      </div>
      <div className="card" style={{ maxWidth: "none", marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>
          {kind === "BRANCH" ? "دليل الفرع" : "دليل المستودع"}
        </h2>
        <p className="muted">
          قُدّم في {formatDateTime(data.submitted_at)}
          {kind === "BRANCH" && branch.data ? ` - النسخة رقم ${branch.data.evidence_revision}` : ""}
        </p>
        <dl style={{ margin: 0 }}>
          <dt className="muted">الإحداثيات (خط العرض، خط الطول)</dt>
          <dd style={{ margin: "0 0 12px" }} dir="ltr">
            {data.lat}, {data.lng}
          </dd>
          {kind === "WAREHOUSE" && warehouse.data && (
            <>
              <dt className="muted">ملاحظة العنوان</dt>
              <dd style={{ margin: "0 0 12px", whiteSpace: "pre-wrap" }}>{warehouse.data.address_note}</dd>
            </>
          )}
          {kind === "BRANCH" && (
            <>
              <dt className="muted">صورة واجهة الفرع</dt>
              <dd style={{ margin: 0 }}>
                {isHttpUrl(shownPhoto) ? (
                  <SafeImage
                    src={shownPhoto}
                    alt="صورة واجهة الفرع المقدَّمة"
                    referrerPolicy="no-referrer"
                    style={{ maxWidth: "100%", maxHeight: 360, borderRadius: 8 }}
                  />
                ) : (
                  <span className="muted">رابط الصورة غير صالح للعرض</span>
                )}
              </dd>
            </>
          )}
        </dl>
      </div>

      {kind === "BRANCH" && branch.data ? (
        <DecisionForm
          path={`/vendors/${params.vendorId}/branches/${branch.data.branch_id}/verification-decision`}
          onStale={() => setNonce((n) => n + 1)}
          buildBody={(decision, reason) => ({
            decision,
            evidence_revision: branch.data!.evidence_revision,
            ...(decision === "approve" ? {} : { reason: reason.trim() }),
          })}
        />
      ) : warehouse.data ? (
        <DecisionForm
          path={`/vendors/${params.vendorId}/warehouse/verification-decision`}
          onStale={() => setNonce((n) => n + 1)}
          buildBody={(decision, reason) => ({
            evidence_id: warehouse.data!.id,
            decision,
            ...(decision === "approve" ? {} : { reason: reason.trim() }),
          })}
        />
      ) : null}
    </div>
  );
}

export default function VerificationReviewPage() {
  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 800 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>مراجعة دليل التحقق</h1>
          <Link href="/admin/verification" className="button-link">الطابور</Link>
        </div>
        <Suspense fallback={<div className="skeleton" style={{ height: 160, width: "100%" }} />}>
          <ReviewInner />
        </Suspense>
      </div>
    </div>
  );
}
