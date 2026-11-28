"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiFetch } from "./api";

// VIA phase 6 - Content Studio on the public pages. A page is wrapped in
// <ManagedContentProvider page="HOMEPAGE">; each existing section keeps its
// own renderer and asks useManagedSection(key) for its managed content:
//   mode "default" - not managed yet / still loading: render the existing
//                    built-in content unchanged;
//   mode "hidden"  - managed but unpublished, or the section is off or
//                    collapsed: render nothing (the page shell stays);
//   mode "managed" - render these fields and items.
// A preview (?content_preview=draft or =<revisionId>) loads the admin
// preview instead (PLATFORM_ADMIN only) through the very same renderers.

export type Bi = { ar: string; en: string };
export interface ManagedMedia {
  kind: "IMAGE" | "VIDEO";
  url: string;
  api_relative?: boolean;
  alt: Bi;
  width: number | null;
  height: number | null;
}
export interface ManagedRef {
  refType: string;
  refId: string;
  slug?: string;
  name?: string;
  title?: Bi;
  href?: string;
  image_url?: string | null;
  store_name?: string;
  logo_url?: string | null;
}
export type ManagedValue = Bi | ManagedMedia | { href: string } | ManagedRef | null;
export interface ManagedItem {
  id: string;
  fields: Record<string, ManagedValue>;
}
export interface ManagedSectionData {
  id: string;
  key: string;
  fields: Record<string, ManagedValue>;
  items: ManagedItem[];
}
export interface ContentProblem {
  section_key: string;
  item_id: string | null;
  field: string | null;
  code: string;
  message: string;
}
interface Loaded {
  state: "loading" | "ready";
  managed: boolean;
  published: boolean;
  sections: Map<string, ManagedSectionData>;
  preview: null | { kind: string; problems: ContentProblem[] };
}

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api/v1";
const Ctx = createContext<Loaded | null>(null);

export function ManagedContentProvider({ page, children }: { page: "HOMEPAGE" | "TRENDING" | "ADS" | "WOMEN" | "MEN" | "KIDS"; children: ReactNode }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading", managed: false, published: false, sections: new Map(), preview: null });
  useEffect(() => {
    let cancelled = false;
    const q = new URLSearchParams(window.location.search).get("content_preview");
    const url = q
      ? `/admin/content/${page}/preview${q === "draft" ? "" : `?revision=${encodeURIComponent(q)}`}`
      : `/content/${page}`;
    apiFetch<{ managed: boolean; published: boolean; sections?: ManagedSectionData[]; preview?: string; problems?: ContentProblem[] }>(url)
      .then((r) => {
        if (cancelled) return;
        setLoaded({
          state: "ready",
          managed: r.managed,
          published: r.published,
          sections: new Map((r.sections ?? []).map((s) => [s.key, s])),
          preview: q ? { kind: r.preview ?? "draft", problems: r.problems ?? [] } : null,
        });
      })
      // Content Studio unreachable: the page keeps its built-in content.
      .catch(() => !cancelled && setLoaded((l) => ({ ...l, state: "ready", managed: false })));
    return () => {
      cancelled = true;
    };
  }, [page]);
  return (
    <Ctx.Provider value={loaded}>
      {loaded.preview && <PreviewBanner preview={loaded.preview} />}
      {children}
    </Ctx.Provider>
  );
}

export type SectionMode =
  | { mode: "default" }
  | { mode: "hidden" }
  | { mode: "managed"; section: ManagedSectionData };

export function useManagedSection(key: string): SectionMode {
  const c = useContext(Ctx);
  return useMemo(() => {
    if (!c || c.state === "loading" || !c.managed) return { mode: "default" } as const;
    if (!c.published) return { mode: "hidden" } as const;
    const s = c.sections.get(key);
    return s ? ({ mode: "managed", section: s } as const) : ({ mode: "hidden" } as const);
  }, [c, key]);
}

/** Text in the current language (falls back to the other language, then to `fallback`). */
export function pickText(v: ManagedValue | undefined, lang: string, fallback = ""): string {
  const b = v as Bi | null | undefined;
  if (!b || typeof b !== "object" || !("ar" in b)) return fallback;
  return (lang === "ar" ? b.ar || b.en : b.en || b.ar) || fallback;
}

/** A managed media URL, or the section's bundled fallback when it is missing (a broken dependency). */
export function mediaUrl(v: ManagedValue | undefined, fallback: string | null = null): string | null {
  const m = v as ManagedMedia | null | undefined;
  if (!m || typeof m !== "object" || !("url" in m)) return fallback;
  return m.api_relative ? `${API_BASE_URL}${m.url}` : m.url;
}
export function mediaOf(v: ManagedValue | undefined): ManagedMedia | null {
  const m = v as ManagedMedia | null | undefined;
  return m && typeof m === "object" && "url" in m ? m : null;
}
export function linkOf(v: ManagedValue | undefined, fallback: string | null = null): string | null {
  const l = v as { href?: string } | null | undefined;
  return l && typeof l === "object" && typeof l.href === "string" ? l.href : fallback;
}
export function refOf(v: ManagedValue | undefined): ManagedRef | null {
  const r = v as ManagedRef | null | undefined;
  return r && typeof r === "object" && "refType" in r ? r : null;
}

/**
 * The section's items over its built-in ones: a managed item with the id of
 * a built-in item keeps that item's design (layout, crop, tone) and takes
 * the managed copy and media; a new item uses the first built-in item as
 * its template. The managed order and membership win.
 */
export function overlayItems<T>(
  mode: SectionMode,
  defaults: T[],
  idOf: (d: T) => string,
  merge: (base: T, item: ManagedItem, isNew: boolean) => T | null,
): T[] {
  if (mode.mode === "default") return defaults;
  if (mode.mode === "hidden") return [];
  const byId = new Map(defaults.map((d) => [idOf(d), d]));
  const out: T[] = [];
  for (const it of mode.section.items) {
    const base = byId.get(it.id) ?? defaults[0];
    if (base === undefined) continue;
    const m = merge(base, it, !byId.has(it.id));
    if (m) out.push(m);
  }
  return out;
}

function PreviewBanner({ preview }: { preview: { kind: string; problems: ContentProblem[] } }) {
  return (
    <div
      role="status"
      data-testid="content-preview-banner"
      dir="auto"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 1000,
        background: "#4a1626",
        color: "#fff",
        padding: "8px 16px",
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      <strong>
        معاينة {preview.kind === "draft" ? "المسودة" : "نسخة سابقة"} · Preview of the {preview.kind === "draft" ? "draft" : "revision"}
      </strong>
      {preview.problems.length === 0 ? (
        <span data-testid="content-preview-ready"> · جاهز للنشر · Ready to publish</span>
      ) : (
        <details>
          <summary data-testid="content-preview-problems">
            {preview.problems.length} ناقص قبل النشر · missing before publishing
          </summary>
          <ul style={{ margin: "4px 0 0", paddingInlineStart: 18 }}>
            {preview.problems.map((p, i) => (
              <li key={i}>
                <bdi dir="ltr">
                  {p.section_key}
                  {p.item_id ? ` / ${p.item_id}` : ""}
                  {p.field ? ` / ${p.field}` : ""}
                </bdi>
                : {p.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
