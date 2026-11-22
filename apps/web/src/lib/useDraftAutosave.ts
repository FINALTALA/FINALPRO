"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, ApiError } from "./api";
import { isMeaningful, type DraftBrandRequest, type DraftDto, type DraftEdit, type DraftPayload } from "./offerWizard";

export type SaveState =
  /** Phase A: nothing real entered yet - nothing exists on the server. */
  | { kind: "local" }
  | { kind: "loading" }
  /** `justNow`: saved by this page a moment ago (vs. as loaded from the server). */
  | { kind: "saved"; at: Date; justNow: boolean }
  | { kind: "saving" }
  | { kind: "error"; error: unknown }
  /** Another tab/device saved a newer revision: nothing is overwritten until the seller chooses. */
  | { kind: "conflict"; serverRevision: number }
  | { kind: "closed"; offerId: string | null }
  | { kind: "missing"; error: unknown };

const SAVE_DELAY_MS = 700;

/**
 * The wizard's server-side autosave. Every change is sent (debounced) as
 * the whole draft with the revision it was based on; one save is in flight
 * at a time and a change made meanwhile is sent right after it. A save the
 * server refuses because another tab/device saved first (409
 * DRAFT_REVISION_CONFLICT) stops autosaving and reports a conflict - the
 * page then asks the seller to load the newer version or keep theirs;
 * nothing is overwritten silently in either direction.
 *
 * Phase A - no empty drafts: with `draftId` null the wizard starts in the
 * browser only (`initial` = the context it was opened from). The draft is
 * created on the server (POST, with everything entered so far) only with
 * the seller's first REAL information (isMeaningful); `onCreated` then
 * gets its id. `confirmed` is the last version the server acknowledged -
 * what a single field compares itself with to say «محفوظ».
 */
export function useDraftAutosave(
  vendorId: string,
  draftId: string | null,
  options: { initial?: DraftPayload; onCreated?: (id: string) => void } = {},
) {
  const [payload, setPayload] = useState<DraftPayload>(draftId ? {} : (options.initial ?? {}));
  const [confirmed, setConfirmed] = useState<DraftPayload | null>(null);
  const [state, setState] = useState<SaveState>(draftId ? { kind: "loading" } : { kind: "local" });
  /** The typed brand's request (under review / approved / rejected), from the server. */
  const [brandRequest, setBrandRequest] = useState<DraftBrandRequest | null>(null);
  /** Edit drafts: the published product this draft edits (null: a new product). */
  const [edit, setEdit] = useState<DraftEdit | null>(null);
  const [id, setId] = useState<string | null>(draftId);
  /** The draft as it was when this page opened it (null for a new one) - what was done before this visit. */
  const [opened, setOpened] = useState<DraftPayload | null>(null);
  /** Phase A+: a change is waiting to be saved (or being saved) - the publish check waits for it. */
  const [dirty, setDirty] = useState(false);
  const collection = `/vendors/${vendorId}/offer-drafts`;
  const s = useRef({
    id: draftId,
    latest: (draftId ? {} : (options.initial ?? {})) as DraftPayload,
    revision: 0,
    dirty: false,
    blocked: false,
    failed: false,
    inFlight: null as Promise<void> | null,
    timer: null as ReturnType<typeof setTimeout> | null,
    onCreated: options.onCreated,
  });
  useEffect(() => {
    s.current.onCreated = options.onCreated;
  }, [options.onCreated]);

  const applyServer = useCallback((d: DraftDto) => {
    const r = s.current;
    r.revision = d.revision;
    r.latest = d.payload ?? {};
    r.dirty = false;
    r.failed = false;
    r.blocked = d.status !== "OPEN";
    setDirty(false);
    setPayload(d.payload ?? {});
    setConfirmed(d.payload ?? {});
    setBrandRequest(d.brand_request ?? null);
    setEdit(d.edit ?? null);
    setState(d.status === "OPEN" ? { kind: "saved", at: new Date(d.updated_at), justNow: false } : { kind: "closed", offerId: d.offer_id });
  }, []);

  useEffect(() => {
    if (!draftId) return;
    let cancelled = false;
    apiFetch<DraftDto>(`${collection}/${draftId}`)
      .then((d) => {
        if (cancelled) return;
        applyServer(d);
        setOpened(d.payload ?? {});
      })
      .catch((err) => {
        if (!cancelled) setState({ kind: "missing", error: err });
      });
    return () => {
      cancelled = true;
    };
  }, [applyServer, collection, draftId]);

  /** One save of the latest draft (a single request); returns when it is answered. */
  const saveOnce = useCallback(async (): Promise<void> => {
    const r = s.current;
    if (r.blocked || !r.dirty) return;
    r.dirty = false;
    r.failed = false;
    setState({ kind: "saving" });
    const body = r.latest;
    try {
      let d: DraftDto;
      if (r.id === null) {
        // The first real information: the draft is created with it.
        d = await apiFetch<DraftDto>(collection, { method: "POST", body: { payload: body } });
        r.id = d.id;
        setId(d.id);
        r.onCreated?.(d.id);
      } else {
        d = await apiFetch<DraftDto>(`${collection}/${r.id}`, {
          method: "PATCH",
          body: { expected_revision: r.revision, payload: body },
        });
      }
      r.revision = d.revision;
      setConfirmed(d.payload ?? body);
      setBrandRequest(d.brand_request ?? null);
      setEdit(d.edit ?? null);
      if (!r.dirty) {
        setState({ kind: "saved", at: new Date(d.updated_at), justNow: true });
        setDirty(false);
      }
    } catch (err) {
      r.dirty = true;
      r.failed = true;
      if (err instanceof ApiError && err.code === "DRAFT_REVISION_CONFLICT") {
        r.blocked = true;
        const detail = err.details[0] as { revision?: number } | undefined;
        setState({ kind: "conflict", serverRevision: detail?.revision ?? 0 });
      } else if (err instanceof ApiError && err.code === "DRAFT_CLOSED") {
        r.blocked = true;
        const detail = err.details[0] as { offer_id?: string | null } | undefined;
        setState({ kind: "closed", offerId: detail?.offer_id ?? null });
      } else {
        setState({ kind: "error", error: err });
      }
    }
  }, [collection]);

  /** Saves until nothing is left (or a save fails / is refused). */
  const flush = useCallback(async (): Promise<void> => {
    const r = s.current;
    while (true) {
      if (r.inFlight) {
        await r.inFlight;
        continue;
      }
      if (!r.dirty || r.blocked || r.failed) return;
      const run = saveOnce();
      r.inFlight = run;
      try {
        await run;
      } finally {
        r.inFlight = null;
      }
    }
  }, [saveOnce]);

  /** Change the draft; it is saved shortly after (before its first real information: kept here only). */
  const update = useCallback(
    (change: (p: DraftPayload) => DraftPayload) => {
      const r = s.current;
      if (r.blocked) return;
      const next = change(r.latest);
      r.latest = next;
      setPayload(next);
      if (r.id === null && !isMeaningful(next)) {
        // Context only (or everything removed again before any save): nothing to keep.
        r.dirty = false;
        if (r.timer) clearTimeout(r.timer);
        return;
      }
      r.dirty = true;
      r.failed = false;
      setDirty(true);
      if (r.timer) clearTimeout(r.timer);
      r.timer = setTimeout(() => void flush(), SAVE_DELAY_MS);
    },
    [flush],
  );

  /** Save now and wait (before changing step, creating the product or closing). True when all is on the server. */
  const saveNow = useCallback(async (): Promise<boolean> => {
    const r = s.current;
    if (r.timer) clearTimeout(r.timer);
    await flush();
    return !r.dirty && !r.blocked;
  }, [flush]);

  const reload = useCallback(async () => {
    const r = s.current;
    if (!r.id) return;
    try {
      applyServer(await apiFetch<DraftDto>(`${collection}/${r.id}`));
    } catch (err) {
      setState({ kind: "error", error: err });
    }
  }, [applyServer, collection]);

  /** Conflict: drop what this tab has not saved and show the newer version. */
  const takeServerVersion = useCallback(async () => {
    s.current.blocked = false;
    await reload();
  }, [reload]);

  /** Conflict: deliberately keep this tab's version - saved on top of the newer one. */
  const keepMine = useCallback(async () => {
    const r = s.current;
    if (!r.id) return;
    try {
      const d = await apiFetch<DraftDto>(`${collection}/${r.id}`);
      if (d.status !== "OPEN") {
        applyServer(d);
        return;
      }
      r.revision = d.revision;
      r.blocked = false;
      r.failed = false;
      r.dirty = true;
      await flush();
    } catch (err) {
      setState({ kind: "error", error: err });
    }
  }, [applyServer, collection, flush]);

  const retry = useCallback(() => {
    s.current.failed = false;
    s.current.dirty = true;
    void flush();
  }, [flush]);

  /**
   * Phase A++ (item 2): «نسخ من فرع…» - ONE request at the current revision,
   * never through the debounced autosave. Whatever is waiting is saved first
   * (the copy builds on it); the page shows the copied quantities only after
   * the server accepted all of them. On any refusal nothing here changes:
   * the original quantities stay (a newer save in another tab is reported as
   * the usual conflict) and the error is returned for the page to show.
   */
  const copyStock = useCallback(
    async (fromBranchId: string, toBranchId: string): Promise<{ ok: true } | { ok: false; error: unknown }> => {
      const r = s.current;
      if (!(await saveNow()) || !r.id) {
        return { ok: false, error: new ApiError(409, "DRAFT_NOT_SAVED", "Save the draft first", []) };
      }
      try {
        const d = await apiFetch<DraftDto>(`${collection}/${r.id}/copy-stock`, {
          method: "POST",
          body: { expected_revision: r.revision, from_branch_id: fromBranchId, to_branch_id: toBranchId },
        });
        applyServer(d);
        setState({ kind: "saved", at: new Date(d.updated_at), justNow: true });
        return { ok: true };
      } catch (err) {
        if (err instanceof ApiError && err.code === "DRAFT_REVISION_CONFLICT") {
          r.blocked = true;
          const detail = err.details[0] as { revision?: number } | undefined;
          setState({ kind: "conflict", serverRevision: detail?.revision ?? 0 });
        }
        return { ok: false, error: err };
      }
    },
    [applyServer, collection, saveNow],
  );

  const revision = useCallback(() => s.current.revision, []);
  /** The draft's id once it exists on the server (null before the first real information). */
  const currentId = useCallback(() => s.current.id, []);

  // Leaving with an unsaved change asks first.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (s.current.dirty || s.current.inFlight) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  return { id, payload, opened, confirmed, state, dirty, brandRequest, edit, update, saveNow, retry, takeServerVersion, keepMine, revision, currentId, reload, copyStock };
}
