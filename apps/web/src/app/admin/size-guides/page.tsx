"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch, newIdempotencyKey } from "@/lib/api";
import { isForbidden } from "@/lib/admin";
import { fillMp } from "@/lib/adminMarketplaceText";
import { sgAudience, sgError } from "@/lib/adminSizeGuidesText";
import { AdminSizeGuideSummary } from "@/lib/sizeGuides";
import { useTaxonomy } from "@/lib/taxonomy";
import { useAdminGate } from "@/lib/useAdminGate";
import { useLang, useT } from "@/lib/useLang";

interface Coverage {
  pairs: {
    category_code: string;
    audience: string;
    offers: number;
    default_guide: { id: string; code: string; name_ar: string } | null;
  }[];
  mismatched_offers: { offer_id: string; title: string; store: string; store_slug: string; sizes: string[] }[];
}

interface CanonicalProductRow {
  id: string;
  model_name: string;
  canonical_name_ar: string | null;
  status: string;
}

// PD-4: the PLATFORM_ADMIN's size guides - the list, creating a guide
// (an empty draft: every measurement is entered and reviewed by the
// administrator, nothing is pre-filled), and the coverage report of
// category/audience pairs in use and offers whose sizes the guide lacks.
export default function AdminSizeGuidesPage() {
  const gate = useAdminGate("ADMIN");
  const lang = useLang();
  const t = useT();
  const router = useRouter();
  const taxonomy = useTaxonomy();
  const [guides, setGuides] = useState<AdminSizeGuideSummary[] | null>(null);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [products, setProducts] = useState<CanonicalProductRow[]>([]);
  // M-01: the failure itself is kept, so its message follows the UI language.
  const [failure, setFailure] = useState<unknown>(null);
  const error = failure === null ? null : sgError(failure, lang);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ code: "", name_ar: "", name_en: "", kind: "STANDARD" as "STANDARD" | "PRODUCT", canonical_product_id: "", basis: "BODY" as "BODY" | "GARMENT" });

  useEffect(() => {
    if (gate.status !== "ok") return;
    let cancelled = false;
    Promise.all([
      apiFetch<AdminSizeGuideSummary[]>("/admin/size-guides"),
      apiFetch<Coverage>("/admin/size-guides/coverage"),
    ])
      .then(([g, c]) => {
        if (cancelled) return;
        setGuides(g);
        setCoverage(c);
      })
      .catch((err) => {
        if (cancelled) return;
        if (isForbidden(err)) setForbidden(true);
        setFailure(err);
      });
    apiFetch<CanonicalProductRow[]>("/canonical-products")
      .then((rows) => !cancelled && setProducts(rows.filter((p) => p.status !== "ARCHIVED" && p.status !== "MERGED")))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [gate.status]);

  const categoryName = (code: string) => {
    const c = taxonomy.data?.categories.find((x) => x.code === code);
    return (lang === "en" ? c?.name_en || c?.name_ar : c?.name_ar) ?? code;
  };

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      const created = await apiFetch<{ id: string }>("/admin/size-guides", {
        method: "POST",
        body: {
          code: form.code.trim(),
          name_ar: form.name_ar.trim(),
          name_en: form.name_en.trim(),
          kind: form.kind,
          ...(form.kind === "PRODUCT" ? { canonical_product_id: form.canonical_product_id || null, basis: form.basis } : {}),
        },
        idempotencyKey: newIdempotencyKey("size-guide-create"),
      });
      router.push(`/admin/size-guides/${created.id}`);
    } catch (err) {
      setFailure(err);
      setBusy(false);
    }
  }

  if (gate.status === "loading") {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 1000 }} />
      </div>
    );
  }
  if (gate.status === "forbidden" || forbidden) {
    return (
      <div className="page-shell">
        <EmptyState title={t("mpa.sg.forbidden")} actionHref="/account" actionLabel={t("mpa.sg.myAccount")} />
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 1000 }}>
        <div className="top-bar">
          <h1 className="page-title" style={{ margin: 0 }}>{t("mpa.sg.title")}</h1>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Link href="/admin/size-guides/requests" className="button-link">{t("mpa.sg.storeRequests")}</Link>
            <Link href="/admin" className="button-link">{t("mpa.sg.dashboard")}</Link>
          </div>
        </div>
        <p className="muted">
          {t("mpa.sg.lead")}
        </p>

        {error && <ErrorBanner message={error} />}

        <section className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>{t("mpa.sg.guides")}</h3>
          {!guides ? (
            <div className="skeleton" style={{ height: 56, width: "100%" }} aria-busy="true" />
          ) : guides.length === 0 ? (
            <p className="muted">{t("mpa.sg.noGuides")}</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t("mpa.sg.colGuide")}</th>
                    <th>{t("mpa.sg.colKind")}</th>
                    <th>{t("mpa.sg.colPublished")}</th>
                    <th>{t("mpa.sg.colDraft")}</th>
                    <th>{t("mpa.sg.colAppliesTo")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {guides.map((g) => (
                    <tr key={g.id}>
                      <td>
                        <strong>{lang === "en" ? g.name_en : g.name_ar}</strong>
                        <div className="muted" dir="ltr" style={{ fontSize: 12 }}>{g.code}</div>
                      </td>
                      <td>{g.kind === "STANDARD" ? t("mpa.sg.standard") : fillMp(t("mpa.sg.productKind"), { name: g.canonical_product?.name ?? "" })}</td>
                      <td>
                        {g.published_version ? (
                          <span className="badge badge-active">
                            {fillMp(t("mpa.sg.version"), { n: g.published_version.version })}
                          </span>
                        ) : (
                          <span className="muted">{t("mpa.sg.unpublished")}</span>
                        )}
                      </td>
                      <td>{g.draft_version ? fillMp(t("mpa.sg.version"), { n: g.draft_version.version }) : "—"}</td>
                      <td>
                        {g.kind === "PRODUCT"
                          ? t("mpa.sg.itsProduct")
                          : g.applicability.length === 0
                            ? <span className="muted">{t("mpa.sg.nothingYet")}</span>
                            : g.applicability
                                .map((p) => fillMp(t("mpa.sg.pairText"), { category: categoryName(p.category_code), audience: sgAudience(lang, p.audience) }) + (p.is_default ? t("mpa.sg.defaultSuffix") : ""))
                                .join(t("mpa.sg.listSeparator"))}
                      </td>
                      <td>
                        <Link href={`/admin/size-guides/${g.id}`} className="button-link">{t("mpa.sg.open")}</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card" style={{ marginBottom: 16, maxWidth: 560 }}>
          <h3 style={{ marginTop: 0 }}>{t("mpa.sg.newGuide")}</h3>
          <form onSubmit={create}>
            <div className="field">
              <label htmlFor="sg-kind">{t("mpa.sg.kind")}</label>
              <select id="sg-kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as "STANDARD" | "PRODUCT" })}>
                <option value="STANDARD">{t("mpa.sg.kindStandard")}</option>
                <option value="PRODUCT">{t("mpa.sg.kindProduct")}</option>
              </select>
            </div>
            {form.kind === "PRODUCT" && (
              <>
                <div className="field">
                  <label htmlFor="sg-product">{t("mpa.sg.canonicalProduct")}</label>
                  <select id="sg-product" required value={form.canonical_product_id} onChange={(e) => setForm({ ...form, canonical_product_id: e.target.value })}>
                    <option value="">{t("mpa.sg.choose")}</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>{p.canonical_name_ar ?? p.model_name}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="sg-basis">{t("mpa.sg.basis")}</label>
                  <select id="sg-basis" value={form.basis} onChange={(e) => setForm({ ...form, basis: e.target.value as "BODY" | "GARMENT" })}>
                    <option value="BODY">{t("mpa.sg.basisBody")}</option>
                    <option value="GARMENT">{t("mpa.sg.basisGarment")}</option>
                  </select>
                </div>
              </>
            )}
            <div className="field">
              <label htmlFor="sg-code">{t("mpa.sg.codeHint")}</label>
              <input id="sg-code" dir="ltr" required pattern="[a-z0-9][a-z0-9\-]{1,59}" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="women-dresses" />
            </div>
            <div className="field">
              <label htmlFor="sg-name-ar">{t("mpa.sg.nameAr")}</label>
              <input id="sg-name-ar" required maxLength={120} value={form.name_ar} onChange={(e) => setForm({ ...form, name_ar: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="sg-name-en">{t("mpa.sg.nameEn")}</label>
              <input id="sg-name-en" dir="ltr" required maxLength={120} value={form.name_en} onChange={(e) => setForm({ ...form, name_en: e.target.value })} />
            </div>
            <button className="button" type="submit" disabled={busy}>{t("mpa.sg.createEmpty")}</button>
          </form>
        </section>

        <section className="card">
          <h3 style={{ marginTop: 0 }}>{t("mpa.sg.coverage")}</h3>
          {!coverage ? (
            <div className="skeleton" style={{ height: 56, width: "100%" }} aria-busy="true" />
          ) : (
            <>
              <p className="muted">{t("mpa.sg.coverageLead")}</p>
              {coverage.pairs.length === 0 ? (
                <p className="muted">{t("mpa.sg.noSizedOffers")}</p>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>{t("mpa.sg.colCategory")}</th>
                        <th>{t("mpa.sg.colAudience")}</th>
                        <th>{t("mpa.sg.colOffers")}</th>
                        <th>{t("mpa.sg.colDefault")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {coverage.pairs.map((p) => (
                        <tr key={`${p.category_code}|${p.audience}`}>
                          <td>{categoryName(p.category_code)}</td>
                          <td>{sgAudience(lang, p.audience)}</td>
                          <td>{p.offers}</td>
                          <td>
                            {p.default_guide ? (
                              <Link href={`/admin/size-guides/${p.default_guide.id}`}>{p.default_guide.name_ar}</Link>
                            ) : (
                              <span className="muted">{t("mpa.sg.noPublishedGuide")}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <h4>{t("mpa.sg.mismatched")}</h4>
              {coverage.mismatched_offers.length === 0 ? (
                <p className="muted">{t("mpa.sg.none")}</p>
              ) : (
                <ul>
                  {coverage.mismatched_offers.map((o) => (
                    <li key={o.offer_id}>
                      <Link href={`/store/${o.store_slug}/products/${o.offer_id}`}>{o.title}</Link> - {o.store}:{" "}
                      <span dir="ltr">{o.sizes.join(", ")}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
