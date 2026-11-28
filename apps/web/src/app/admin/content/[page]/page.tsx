"use client";

import "@/lib/contentStudioText";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, ErrorBanner } from "@/components/States";
import { apiFetch, newIdempotencyKey } from "@/lib/api";
import { fill } from "@/lib/approvalCenterText";
import { baselineDocument } from "@/lib/contentBaseline";
import { applicableSuggestions, applySuggestions } from "@/lib/contentTranslations";
import { CONTENT_PAGE_KEYS, contentError, PUBLIC_PATH, type ContentPage } from "@/lib/contentStudioText";
import { MEDIA_CATEGORIES, mediaUrl as libraryUrl } from "@/lib/mediaLibraryText";
import { useAdminGate } from "@/lib/useAdminGate";
import { useLang, useT } from "@/lib/useLang";
import styles from "../../approvals/approvals.module.css";

// VIA phase 6 - the Content Studio editor for one page. Edits a private
// draft (optimistic version), previews it through the public renderers
// (?content_preview=draft), publishes it now or at an Asia/Hebron wall
// time, and manages the revision history. The registry (served by the
// API) decides which sections, fields and item counts exist.

type Bi = { ar: string; en: string };
type FieldType = "text" | "media" | "link" | "ref";
interface FieldDef {
  name: string;
  type: FieldType;
  required?: boolean;
  media?: ("IMAGE" | "VIDEO")[];
  refType?: "store" | "collection" | "category" | "product";
  label: Bi;
}
interface SectionDef {
  key: string;
  page: ContentPage;
  label: Bi;
  fields: FieldDef[];
  items?: { min: number; max: number; fields: FieldDef[]; label: Bi };
}
interface Registry {
  sections: SectionDef[];
  time_zone: string;
  now_local: string;
}
type MediaValue = { source: "bundled"; path: string; alt?: Bi } | { source: "library"; assetId: string; alt?: Bi };
type Value = Bi | MediaValue | { href: string } | { refType: string; refId: string } | null;
interface Item {
  id: string;
  fields: Record<string, Value>;
}
interface Section {
  id: string;
  key: string;
  enabled: boolean;
  fields: Record<string, Value>;
  items: Item[];
}
interface Doc {
  schemaVersion: 1;
  sections: Section[];
}
interface Problem {
  section_key: string;
  item_id: string | null;
  field: string | null;
  code: string;
  message: string;
}
interface Detail {
  page: ContentPage;
  exists: boolean;
  draft?: Doc;
  draft_version?: number;
  draft_problems?: Problem[];
  published_revision_id?: string | null;
  published_at?: string | null;
  revisions?: {
    id: string;
    number: number;
    source: string;
    created_at: string;
    archived_at: string | null;
    live: boolean;
    scheduled: boolean;
    can_restore: boolean;
    can_archive: boolean;
  }[];
  schedules?: {
    id: string;
    revision_id: string;
    status: string;
    run_at: string;
    local_time: string;
    attempts: number;
    last_error: string | null;
    executed_at: string | null;
  }[];
  issues?: { id: string; section_id: string; item_id: string | null; field: string; kind: string; detail: string; detected_at: string }[];
}
interface LibraryItem {
  id: string;
  name: string;
  kind: "IMAGE" | "VIDEO";
  preview_url: string | null;
}

const isPage = (p: string): p is ContentPage => (CONTENT_PAGE_KEYS as readonly string[]).includes(p);
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const fmt = (iso: string, lang: string) =>
  new Date(iso).toLocaleString(lang === "ar" ? "ar" : "en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Hebron" });

export default function ContentEditorPage() {
  const params = useParams<{ page: string }>();
  const page = (params.page ?? "").toUpperCase();
  const gate = useAdminGate("ADMIN");
  const t = useT();
  const lang = useLang();
  const L = (b: Bi) => (lang === "ar" ? b.ar : b.en);
  // The error text is built when an error happens; loading must not depend
  // on the translator (a new function each render would refetch forever).
  const errText = useRef((e: unknown) => contentError(e, lang, t));
  useEffect(() => {
    errText.current = (e: unknown) => contentError(e, lang, t);
  });

  const [registry, setRegistry] = useState<Registry | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picker, setPicker] = useState<null | { kinds: ("IMAGE" | "VIDEO")[]; apply: (v: LibraryItem) => void }>(null);
  const [thumbs, setThumbs] = useState<Record<string, LibraryItem>>({});
  const [sched, setSched] = useState({ date: "", time: "", occurrence: "", replace: false });

  const accept = useCallback((d: Detail) => {
    setDetail(d);
    setDoc(d.draft ? clone(d.draft) : null);
    setDirty(false);
  }, []);

  const load = useCallback(() => {
    if (!isPage(page)) return;
    Promise.all([apiFetch<Registry>("/admin/content/registry"), apiFetch<Detail>(`/admin/content/${page}`)])
      .then(([r, d]) => {
        setError(null);
        setRegistry(r);
        accept(d);
      })
      .catch((e) => setError(errText.current(e)));
  }, [page, accept]);

  useEffect(() => {
    if (gate.status === "ok") load();
  }, [gate.status, load]);

  // Leaving with unsaved edits asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const defs = useMemo(() => new Map((registry?.sections ?? []).map((s) => [s.key, s])), [registry]);

  async function act(path: string, body?: unknown, okText?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const d = await apiFetch<Detail>(`/admin/content/${page}${path}`, {
        method: path === "/draft" ? "PUT" : "POST",
        body: body ?? {},
        idempotencyKey: path === "/draft" ? undefined : newIdempotencyKey(`content${path.replace(/\W+/g, "-")}`),
      });
      accept(d);
      if (okText) setNotice(okText);
      return true;
    } catch (e) {
      setError(contentError(e, lang, t));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const edit = (fn: (d: Doc) => void) => {
    setDoc((prev) => {
      if (!prev) return prev;
      const next = clone(prev);
      fn(next);
      return next;
    });
    setDirty(true);
  };

  if (gate.status === "loading") {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 160, width: "100%", maxWidth: 1100 }} />
      </div>
    );
  }
  if (gate.status === "forbidden" || !isPage(page)) {
    return (
      <div className="page-shell">
        <EmptyState title={t("cs.forbidden")} actionHref="/admin/content" actionLabel={t("cs.back")} />
      </div>
    );
  }

  const version = detail?.draft_version;
  const problems = detail?.draft_problems ?? [];
  const pendingSchedule = detail?.schedules?.find((s) => s.status === "PENDING");
  const publicPath = PUBLIC_PATH[page];
  const suggestions = doc ? applicableSuggestions(page, doc).length : 0;
  const missingSections = (registry?.sections ?? []).filter((s) => s.page === page && !doc?.sections.some((x) => x.key === s.key));

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 1100, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16 }}>
        <div className="top-bar" style={{ flexWrap: "wrap", gap: 8 }}>
          <h1 className="page-title" style={{ margin: 0 }}>
            {t("cs.title")} · {t(`cs.page.${page}`)}
          </h1>
          <Link href="/admin/content" className="button-link">{t("cs.back")}</Link>
        </div>
        {error && (
          <div>
            <ErrorBanner message={error} />
            <button type="button" className="button-secondary" onClick={load} style={{ marginTop: 8 }}>{t("cs.reload")}</button>
          </div>
        )}
        {notice && <p role="status" data-testid="cs-notice" style={{ margin: 0 }}>{notice}</p>}
        {!detail && !error && <div className="skeleton" style={{ height: 120 }} />}

        {detail && !detail.exists && (
          <section className={styles.panel} data-testid="cs-import">
            <h2 className={styles.panelTitle}>{t("cs.import")}</h2>
            <p className={styles.lead}>{t("cs.importLead")}</p>
            <button
              type="button"
              className="button"
              disabled={busy}
              data-testid="cs-import-submit"
              onClick={() => act("/import", { document: baselineDocument(page) })}
            >
              {t("cs.import")}
            </button>
          </section>
        )}

        {detail?.exists && doc && (
          <>
            {/* ------------------------------------------------ status + actions */}
            <section className={styles.panel} data-testid="cs-status">
              <p className={styles.rowSecondary} style={{ marginTop: 0 }}>
                {detail.published_revision_id
                  ? fill(t("cs.published"), { n: detail.revisions?.find((r) => r.live)?.number ?? "" })
                  : t("cs.unpublished")}
                {" · "}
                {fill(t("cs.draftVersion"), { n: version ?? "" })}
                {dirty && <strong data-testid="cs-dirty"> · {t("cs.unsaved")}</strong>}
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <button type="button" className="button" disabled={busy || !dirty} data-testid="cs-save" onClick={() => act("/draft", { version, document: doc }, t("cs.saved"))}>
                  {t("cs.save")}
                </button>
                {dirty ? (
                  <span className="button-secondary" aria-disabled="true" title={t("cs.previewSaveFirst")}>{t("cs.preview")}</span>
                ) : (
                  <a className="button-secondary" href={`${publicPath}?content_preview=draft`} target="_blank" rel="noopener" data-testid="cs-preview">
                    {t("cs.preview")}
                  </a>
                )}
                <button type="button" className="button" disabled={busy || dirty || problems.length > 0} data-testid="cs-publish" onClick={() => act("/publish", { version })}>
                  {t("cs.publish")}
                </button>
                {detail.published_revision_id && (
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={busy}
                    data-testid="cs-unpublish"
                    onClick={() => window.confirm(t("cs.confirmUnpublish")) && act("/unpublish")}
                  >
                    {t("cs.unpublish")}
                  </button>
                )}
              </div>
              {suggestions > 0 && (
                <button
                  type="button"
                  className="button-secondary"
                  style={{ marginTop: 12 }}
                  data-testid="cs-suggest"
                  disabled={busy}
                  onClick={() => {
                    // Only empty English values whose Arabic is unchanged; the admin reviews and saves.
                    edit((d) => void applySuggestions(page, d));
                    setNotice(fill(t("cs.suggestDone"), { n: suggestions }));
                  }}
                >
                  {fill(t("cs.suggest"), { n: suggestions })}
                </button>
              )}
              <div style={{ marginTop: 12 }} data-testid="cs-problems">
                {problems.length === 0 ? (
                  <span data-testid="cs-ready">✓ {t("cs.ready")}</span>
                ) : (
                  <details open>
                    <summary>{t("cs.problems")} ({problems.length})</summary>
                    <ul style={{ margin: "4px 0 0", paddingInlineStart: 18 }}>
                      {problems.map((p, i) => {
                        const sd = defs.get(p.section_key);
                        const fd = [...(sd?.fields ?? []), ...(sd?.items?.fields ?? [])].find((f) => f.name === p.field);
                        return (
                          <li key={i}>
                            {sd ? L(sd.label) : p.section_key}
                            {p.item_id ? ` / ${p.item_id}` : ""}
                            {fd ? ` / ${L(fd.label)}` : ""}: <bdi>{p.message}</bdi>
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                )}
              </div>
            </section>

            {/* ------------------------------------------------------ sections */}
            {doc.sections.map((s, si) => {
              const def = defs.get(s.key);
              if (!def) return null;
              const its = def.items;
              return (
                <section key={s.id} className={styles.panel} data-testid={`cs-section-${s.key}`}>
                  <div className={styles.panelHead}>
                    <h2 className={styles.panelTitle}>{L(def.label)}</h2>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <input type="checkbox" checked={s.enabled} onChange={(e) => edit((d) => void (d.sections[si].enabled = e.target.checked))} />
                      {t("cs.section.enabled")}
                    </label>
                  </div>
                  {def.fields.map((f) => (
                    <FieldEditor
                      key={f.name}
                      def={f}
                      value={s.fields[f.name] ?? null}
                      id={`${s.id}-${f.name}`}
                      onChange={(v) => edit((d) => void (d.sections[si].fields[f.name] = v))}
                      onPick={(kinds, apply) => setPicker({ kinds, apply })}
                      thumbs={thumbs}
                    />
                  ))}
                  {its && (
                    <div style={{ display: "grid", gap: 12, marginTop: 8 }}>
                      <h3 style={{ margin: 0, fontSize: 15 }}>{fill(t("cs.items"), { n: s.items.length, min: its.min, max: its.max })}</h3>
                      {s.items.map((it, ii) => (
                        <fieldset key={it.id} data-testid={`cs-item-${s.key}-${it.id}`} style={{ border: "1px solid var(--border, #ddd)", borderRadius: 8, padding: 12, margin: 0, minWidth: 0 }}>
                          <legend style={{ padding: "0 6px" }}>
                            {L(its.label)} {ii + 1} <bdi dir="ltr" style={{ opacity: 0.6, fontSize: 12 }}>{it.id}</bdi>
                          </legend>
                          {its.fields.map((f) => (
                            <FieldEditor
                              key={f.name}
                              def={f}
                              value={it.fields[f.name] ?? null}
                              id={`${s.id}-${it.id}-${f.name}`}
                              onChange={(v) => edit((d) => void (d.sections[si].items[ii].fields[f.name] = v))}
                              onPick={(kinds, apply) => setPicker({ kinds, apply })}
                              thumbs={thumbs}
                            />
                          ))}
                          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                            <button type="button" className="button-secondary" disabled={ii === 0} onClick={() => edit((d) => { const a = d.sections[si].items; [a[ii - 1], a[ii]] = [a[ii], a[ii - 1]]; })}>
                              {t("cs.up")}
                            </button>
                            <button type="button" className="button-secondary" disabled={ii === s.items.length - 1} onClick={() => edit((d) => { const a = d.sections[si].items; [a[ii + 1], a[ii]] = [a[ii], a[ii + 1]]; })}>
                              {t("cs.down")}
                            </button>
                            <button type="button" className="button-secondary" onClick={() => edit((d) => void d.sections[si].items.splice(ii, 1))}>
                              {t("cs.remove")}
                            </button>
                          </div>
                        </fieldset>
                      ))}
                      {s.items.length < its.max && (
                        <button
                          type="button"
                          className="button-secondary"
                          style={{ justifySelf: "start" }}
                          data-testid={`cs-add-${s.key}`}
                          onClick={() => edit((d) => void d.sections[si].items.push({ id: newId("item"), fields: {} }))}
                        >
                          {fill(t("cs.addItem"), { label: L(its.label) })}
                        </button>
                      )}
                    </div>
                  )}
                </section>
              );
            })}
            {missingSections.map((def) => (
              <button
                key={def.key}
                type="button"
                className="button-secondary"
                style={{ justifySelf: "start" }}
                onClick={() => edit((d) => void d.sections.push({ id: newId("section"), key: def.key, enabled: true, fields: {}, items: [] }))}
              >
                + {L(def.label)}
              </button>
            ))}

            {/* ------------------------------------------------------ schedule */}
            <section className={styles.panel} data-testid="cs-schedule">
              <h2 className={styles.panelTitle}>{t("cs.schedule")}</h2>
              <p className={styles.lead} style={{ marginTop: 0 }}>
                {fill(t("cs.schedule.lead"), { tz: registry?.time_zone ?? "Asia/Hebron", now: registry?.now_local ?? "" })}
              </p>
              <div className={styles.filters}>
                <div className="field">
                  <label htmlFor="cs-date">{t("cs.schedule.date")}</label>
                  <input id="cs-date" type="date" value={sched.date} onChange={(e) => setSched({ ...sched, date: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="cs-time">{t("cs.schedule.time")}</label>
                  <input id="cs-time" type="time" value={sched.time} onChange={(e) => setSched({ ...sched, time: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="cs-occ">{t("cs.schedule.occurrence")}</label>
                  <select id="cs-occ" value={sched.occurrence} onChange={(e) => setSched({ ...sched, occurrence: e.target.value })}>
                    <option value="">-</option>
                    <option value="earlier">{t("cs.schedule.earlier")}</option>
                    <option value="later">{t("cs.schedule.later")}</option>
                  </select>
                </div>
                {pendingSchedule && (
                  <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input type="checkbox" checked={sched.replace} onChange={(e) => setSched({ ...sched, replace: e.target.checked })} />
                    {t("cs.schedule.replace")}
                  </label>
                )}
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                <button
                  type="button"
                  className="button"
                  data-testid="cs-schedule-submit"
                  disabled={busy || dirty || problems.length > 0 || !sched.date || !sched.time}
                  onClick={() =>
                    act("/schedule", {
                      version,
                      local_date: sched.date,
                      local_time: sched.time,
                      ...(sched.occurrence ? { occurrence: sched.occurrence } : {}),
                      replace: sched.replace,
                    })
                  }
                >
                  {t("cs.schedule.submit")}
                </button>
                {pendingSchedule && (
                  <button type="button" className="button-secondary" disabled={busy} data-testid="cs-schedule-cancel" onClick={() => act("/schedule/cancel")}>
                    {t("cs.schedule.cancel")}
                  </button>
                )}
              </div>
              {(detail.schedules?.length ?? 0) > 0 && (
                <>
                  <h3 style={{ fontSize: 15 }}>{t("cs.schedules")}</h3>
                  <ul className={styles.list} style={{ listStyle: "none", padding: 0 }}>
                    {detail.schedules!.map((s) => (
                      <li key={s.id} className={styles.row} data-testid={`cs-sched-${s.status}`}>
                        <span className={styles.rowMain}>
                          <span className={styles.rowPrimary}><bdi>{s.local_time}</bdi> · {s.status}</span>
                          {s.last_error && <span className={styles.rowSecondary}><bdi>{s.last_error}</bdi></span>}
                        </span>
                        {s.status === "FAILED" && (
                          <button type="button" className="button-secondary" disabled={busy} onClick={() => act(`/schedules/${s.id}/retry`)}>
                            {t("cs.schedule.retry")}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>

            {/* ----------------------------------------------------- revisions */}
            <section className={styles.panel} data-testid="cs-revisions">
              <h2 className={styles.panelTitle}>{t("cs.revisions")}</h2>
              <ul className={styles.list} style={{ listStyle: "none", padding: 0 }}>
                {detail.revisions?.map((r) => (
                  <li key={r.id} className={styles.row} data-testid={`cs-rev-${r.number}`}>
                    <span className={styles.rowMain}>
                      <span className={styles.rowPrimary}>
                        #{r.number} · {t(`cs.source.${r.source}`)}
                        {r.live && ` · ${t("cs.rev.live")}`}
                        {r.scheduled && ` · ${t("cs.rev.scheduled")}`}
                        {r.archived_at && ` · ${t("cs.rev.archived")}`}
                      </span>
                      <span className={styles.rowSecondary}>{fmt(r.created_at, lang)}</span>
                    </span>
                    <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {!r.archived_at && (
                        <a className="button-link" href={`${publicPath}?content_preview=${r.id}`} target="_blank" rel="noopener">{t("cs.rev.preview")}</a>
                      )}
                      {r.can_restore && (
                        <button type="button" className="button-secondary" disabled={busy} onClick={() => window.confirm(fill(t("cs.rev.confirmRestore"), { n: r.number })) && act(`/revisions/${r.id}/restore`)}>
                          {t("cs.rev.restore")}
                        </button>
                      )}
                      {!r.archived_at && (
                        <button type="button" className="button-secondary" disabled={busy} onClick={() => window.confirm(fill(t("cs.rev.confirmLoad"), { n: r.number })) && act(`/revisions/${r.id}/load-draft`, { version })}>
                          {t("cs.rev.load")}
                        </button>
                      )}
                      {r.can_archive && (
                        <button type="button" className="button-secondary" disabled={busy} onClick={() => act(`/revisions/${r.id}/archive`)}>
                          {t("cs.rev.archive")}
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            {(detail.issues?.length ?? 0) > 0 && (
              <section className={styles.panel} data-testid="cs-issues">
                <h2 className={styles.panelTitle}>{t("cs.openIssues")}</h2>
                <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                  {detail.issues!.map((i) => (
                    <li key={i.id}>
                      <bdi dir="ltr">{i.section_id}{i.item_id ? ` / ${i.item_id}` : ""} / {i.field}</bdi>: {i.kind} ({fmt(i.detected_at, lang)})
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>

      {picker && (
        <MediaPicker
          page={page}
          kinds={picker.kinds}
          onClose={() => setPicker(null)}
          onPick={(m) => {
            setThumbs((th) => ({ ...th, [m.id]: m }));
            picker.apply(m);
            setPicker(null);
          }}
        />
      )}
    </div>
  );
}

function FieldEditor({
  def,
  value,
  id,
  onChange,
  onPick,
  thumbs,
}: {
  def: FieldDef;
  value: Value;
  id: string;
  onChange: (v: Value) => void;
  onPick: (kinds: ("IMAGE" | "VIDEO")[], apply: (m: LibraryItem) => void) => void;
  thumbs: Record<string, LibraryItem>;
}) {
  const t = useT();
  const lang = useLang();
  const label = (
    <>
      {lang === "ar" ? def.label.ar : def.label.en}
      {def.required && <span style={{ opacity: 0.6 }}> ({t("cs.required")})</span>}
    </>
  );
  const biInputs = (v: Bi | undefined, set: (b: Bi) => void, prefix: string, multiline: boolean) => (
    <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(min(220px, 100%), 1fr))" }}>
      {(["ar", "en"] as const).map((l) => (
        <div className="field" key={l} style={{ margin: 0 }}>
          <label htmlFor={`${prefix}-${l}`} style={{ fontSize: 12 }}>{t(`cs.${l}`)}</label>
          {multiline ? (
            <textarea id={`${prefix}-${l}`} dir={l === "ar" ? "rtl" : "ltr"} lang={l} rows={2} value={v?.[l] ?? ""} onChange={(e) => set({ ar: v?.ar ?? "", en: v?.en ?? "", [l]: e.target.value })} />
          ) : (
            <input id={`${prefix}-${l}`} dir={l === "ar" ? "rtl" : "ltr"} lang={l} value={v?.[l] ?? ""} onChange={(e) => set({ ar: v?.ar ?? "", en: v?.en ?? "", [l]: e.target.value })} />
          )}
        </div>
      ))}
    </div>
  );

  if (def.type === "text") {
    return (
      <div style={{ marginBottom: 10 }} data-field={def.name}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{label}</div>
        {biInputs(value as Bi | undefined, onChange, id, true)}
      </div>
    );
  }
  if (def.type === "link") {
    const v = value as { href: string } | null;
    return (
      <div className="field" style={{ marginBottom: 10 }} data-field={def.name}>
        <label htmlFor={id}>{label}</label>
        <input id={id} dir="ltr" placeholder="/women" value={v?.href ?? ""} onChange={(e) => onChange(e.target.value ? { href: e.target.value } : null)} />
        <small style={{ opacity: 0.7 }}>{t("cs.link.hint")}</small>
      </div>
    );
  }
  if (def.type === "ref") {
    const v = value as { refType: string; refId: string } | null;
    return (
      <div className="field" style={{ marginBottom: 10 }} data-field={def.name}>
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          dir="ltr"
          value={v?.refId ?? ""}
          placeholder={def.refType === "product" ? t("cs.ref.product") : t("cs.ref.hint")}
          onChange={(e) => onChange(e.target.value.trim() ? { refType: def.refType!, refId: e.target.value.trim() } : null)}
        />
      </div>
    );
  }
  // media
  const m = value as MediaValue | null;
  const thumb = m?.source === "bundled" ? m.path : m?.source === "library" ? libraryUrl(thumbs[m.assetId]?.preview_url ?? null) : null;
  const isVideo = m?.source === "bundled" ? /\.(mp4|webm)$/i.test(m.path) : m?.source === "library" ? thumbs[m.assetId]?.kind === "VIDEO" : false;
  const kinds = def.media ?? ["IMAGE"];
  return (
    <div style={{ marginBottom: 10 }} data-field={def.name}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{label}</div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        {thumb ? (
          isVideo ? (
            <video src={thumb} muted playsInline preload="metadata" style={{ width: 96, height: 72, objectFit: "cover", borderRadius: 6 }} />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumb} alt="" style={{ width: 96, height: 72, objectFit: "cover", borderRadius: 6 }} />
          )
        ) : null}
        <span style={{ fontSize: 12, opacity: 0.8, overflowWrap: "anywhere", minWidth: 0 }}>
          {!m ? t("cs.media.none") : m.source === "bundled" ? <>{t("cs.media.bundled")}: <bdi dir="ltr">{m.path}</bdi></> : <>{t("cs.media.library")}: <bdi dir="ltr">{thumbs[m.assetId]?.name ?? m.assetId}</bdi></>}
        </span>
        <button type="button" className="button-secondary" data-testid={`cs-pick-${id}`} onClick={() => onPick(kinds, (a) => onChange({ source: "library", assetId: a.id, alt: m?.alt ?? { ar: "", en: "" } }))}>
          {t("cs.media.choose")}
        </button>
        {m && (
          <button type="button" className="button-secondary" onClick={() => onChange(null)}>
            {t("cs.media.clear")}
          </button>
        )}
      </div>
      {m && (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 12, marginBottom: 2 }}>{t("cs.alt")}</div>
          {biInputs(m.alt, (alt) => onChange({ ...m, alt }), `${id}-alt`, false)}
        </div>
      )}
    </div>
  );
}

function MediaPicker({
  page,
  kinds,
  onClose,
  onPick,
}: {
  page: ContentPage;
  kinds: ("IMAGE" | "VIDEO")[];
  onClose: () => void;
  onPick: (m: LibraryItem) => void;
}) {
  const t = useT();
  const [q, setQ] = useState("");
  // The page's own library category when it has one (Women/Men/Kids have none).
  const [category, setCategory] = useState<string>((MEDIA_CATEGORIES as readonly string[]).includes(page) ? page : "all");
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const lang = useLang();
  const errText = useRef((e: unknown) => contentError(e, lang, t));
  useEffect(() => {
    errText.current = (e: unknown) => contentError(e, lang, t);
  });

  useEffect(() => {
    let cancelled = false;
    const qs = new URLSearchParams({ limit: "48", status: "ACTIVE" });
    if (kinds.length === 1) qs.set("kind", kinds[0]);
    if (category !== "all") qs.set("category", category);
    if (q.trim()) qs.set("q", q.trim());
    apiFetch<{ items: LibraryItem[] }>(`/admin/media?${qs}`)
      .then((r) => !cancelled && setItems(r.items.filter((i) => kinds.includes(i.kind))))
      .catch((e) => !cancelled && setErr(errText.current(e)));
    return () => {
      cancelled = true;
    };
  }, [category, q, kinds]);

  return (
    <div role="dialog" aria-modal="true" aria-label={t("cs.media.pick")} data-testid="cs-picker" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 1000, display: "grid", placeItems: "center", padding: 16 }} onClick={onClose}>
      <div className="wide-shell" style={{ background: "var(--surface, #fff)", borderRadius: 12, padding: 16, width: "min(900px, 100%)", maxHeight: "85vh", overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{t("cs.media.pick")}</h2>
          <button type="button" className="button-secondary" onClick={onClose}>{t("cs.media.close")}</button>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "12px 0" }}>
          <input aria-label={t("cs.media.search")} placeholder={t("cs.media.search")} value={q} onChange={(e) => setQ(e.target.value)} />
          <select aria-label="category" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="all">*</option>
            {MEDIA_CATEGORIES.map((c) => (
              <option key={c} value={c}>{t(`ml.cat.${c}`)}</option>
            ))}
          </select>
        </div>
        {err && <ErrorBanner message={err} />}
        {!items && !err && <div className="skeleton" style={{ height: 120 }} />}
        {items?.length === 0 && <p>{t("cs.media.empty")}</p>}
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
          {items?.map((m) => {
            const src = libraryUrl(m.preview_url);
            return (
              <li key={m.id}>
                <button type="button" onClick={() => onPick(m)} data-testid={`cs-pick-asset-${m.id}`} style={{ width: "100%", border: "1px solid #ddd", borderRadius: 8, padding: 6, background: "none", cursor: "pointer", textAlign: "start" }}>
                  {src &&
                    (m.kind === "VIDEO" ? (
                      <video src={src} muted playsInline preload="metadata" style={{ width: "100%", aspectRatio: "4/3", objectFit: "cover" }} />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={src} alt="" style={{ width: "100%", aspectRatio: "4/3", objectFit: "cover" }} />
                    ))}
                  <span style={{ display: "block", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
