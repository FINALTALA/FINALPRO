"use client";

import "@/lib/adminStoreDetailText";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import SafeImage from "@/components/SafeImage";
import { EmptyState, ErrorBanner } from "@/components/States";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { fillMp, mpDate, mpError, mpFetchError, mpReasonProblem } from "@/lib/adminMarketplaceText";
import { useAdminGate } from "@/lib/useAdminGate";
import { useFetch } from "@/lib/useFetch";
import { useLang, useT } from "@/lib/useLang";

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

// M-01: decision labels and outcomes live in lib/adminStoreDetailText.ts.
const DECISIONS: Decision[] = ["approve", "reject", "request_resubmission"];

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
  const lang = useLang();
  const t = useT();
  const [decision, setDecision] = useState<Decision>("approve");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [done, setDone] = useState<Decision | null>(null);
  const needsReason = decision !== "approve";
  const problem = needsReason ? mpReasonProblem(reason, lang) : null;

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
      setError(mpError(err, lang));
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
        <div className="notice-banner" role="status">{t(`mpa.sd.verif.done.${done}`)}</div>
        <Link href="/admin/verification" className="button">{t("mpa.sd.verif.backToQueue")}</Link>
      </div>
    );
  }

  return (
    <div className="card" style={{ maxWidth: "none" }}>
      <h2 style={{ marginTop: 0 }}>{t("mpa.sd.verif.decisionTitle")}</h2>
      {error && <ErrorBanner message={error} />}
      {stale && (
        <div style={{ marginBottom: 12 }}>
          <button className="button button-secondary" onClick={onStale}>
            {t("mpa.sd.verif.reloadEvidence")}
          </button>
        </div>
      )}
      <fieldset style={{ border: 0, padding: 0, margin: "0 0 12px" }}>
        {DECISIONS.map((d) => (
          <label key={d} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
            <input
              type="radio"
              name="decision"
              checked={decision === d}
              disabled={busy}
              onChange={() => setDecision(d)}
            />
            {t(`mpa.sd.verif.decision.${d}`)}
          </label>
        ))}
      </fieldset>
      {needsReason && (
        <div className="field">
          <label htmlFor="reason">{t("mpa.sd.verif.reason")}</label>
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
        {busy ? t("mpa.sd.sending") : t("mpa.sd.verif.confirm")}
      </button>
    </div>
  );
}

function ReviewInner() {
  const gate = useAdminGate();
  const lang = useLang();
  const t = useT();
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
    return <EmptyState title={t("mpa.sd.forbiddenStaff")} actionHref="/account" actionLabel={t("mpa.sd.myAccount")} />;
  }
  if (!valid) {
    return (
      <EmptyState
        title={t("mpa.sd.verif.invalidLink")}
        actionHref="/admin/verification"
        actionLabel={t("mpa.sd.verif.backToQueue")}
      />
    );
  }
  if (evidence.loading) {
    return (
      <div aria-busy="true" aria-label={t("mpa.sd.loading")}>
        <div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 800 }} />
      </div>
    );
  }
  if (evidence.status === 404) {
    return (
      <EmptyState
        title={t("mpa.sd.verif.noPending")}
        message={t("mpa.sd.verif.noPendingHint")}
        actionHref="/admin/verification"
        actionLabel={t("mpa.sd.verif.backToQueue")}
      />
    );
  }
  if (evidence.error || !evidence.data) {
    return <ErrorBanner message={mpFetchError(evidence.error, evidence.apiError, lang) ?? t("mpa.sd.verif.loadFailed")} />;
  }

  const shownPhoto = kind === "BRANCH" ? (branch.data?.photo_url ?? "") : "";
  const data = evidence.data;

  return (
    <div style={{ maxWidth: 800, width: "100%" }}>
      <div className="warning-banner">
        {t("mpa.sd.verif.confidential")}
      </div>
      <div className="card" style={{ maxWidth: "none", marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>
          {t(kind === "BRANCH" ? "mpa.sd.verif.branchEvidence" : "mpa.sd.verif.warehouseEvidence")}
        </h2>
        <p className="muted">
          {fillMp(t("mpa.sd.verif.submittedAt"), { date: mpDate(data.submitted_at, lang) })}
          {kind === "BRANCH" && branch.data ? fillMp(t("mpa.sd.verif.revision"), { n: branch.data.evidence_revision }) : ""}
        </p>
        <dl style={{ margin: 0 }}>
          <dt className="muted">{t("mpa.sd.verif.coords")}</dt>
          <dd style={{ margin: "0 0 12px" }} dir="ltr">
            {data.lat}, {data.lng}
          </dd>
          {kind === "WAREHOUSE" && warehouse.data && (
            <>
              <dt className="muted">{t("mpa.sd.verif.addressNote")}</dt>
              <dd style={{ margin: "0 0 12px", whiteSpace: "pre-wrap" }}>{warehouse.data.address_note}</dd>
            </>
          )}
          {kind === "BRANCH" && (
            <>
              <dt className="muted">{t("mpa.sd.verif.photo")}</dt>
              <dd style={{ margin: 0 }}>
                {isHttpUrl(shownPhoto) ? (
                  <SafeImage
                    src={shownPhoto}
                    alt={t("mpa.sd.verif.photoAlt")}
                    referrerPolicy="no-referrer"
                    style={{ maxWidth: "100%", maxHeight: 360, borderRadius: 8 }}
                  />
                ) : (
                  <span className="muted">{t("mpa.sd.verif.badPhotoUrl")}</span>
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
  const t = useT();
  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 800 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>{t("mpa.sd.verif.title")}</h1>
          <Link href="/admin/verification" className="button-link">{t("mpa.sd.verif.queue")}</Link>
        </div>
        <Suspense fallback={<div className="skeleton" style={{ height: 160, width: "100%" }} />}>
          <ReviewInner />
        </Suspense>
      </div>
    </div>
  );
}
