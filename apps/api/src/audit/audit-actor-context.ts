import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * «إدارة طلبات الفرع v1» (2026-11-22): who acted on a branch order, AS THEY
 * WERE at that moment - the store role and the branch of their membership,
 * and their display name. A membership changes later (an employee is moved
 * to another branch, a name is edited), so the order's timeline must not
 * read today's values for yesterday's events.
 *
 * No migration: the snapshot rides in the existing AuditLog.afterState JSON
 * under ONE clearly named key, `actor_snapshot` (version `v: 1`). Rows
 * written before this package simply have no such key - the timeline shows
 * them as «الدور غير مسجّل».
 */
export const ACTOR_SNAPSHOT_KEY = 'actor_snapshot';

export type ActorSnapshotRole = 'OWNER' | 'BRANCH_EMPLOYEE' | 'PLATFORM_STAFF';

export interface ActorSnapshot {
  v: 1;
  /** The user this snapshot describes - attached only to rows whose actorId is this user. */
  user_id: string;
  role: ActorSnapshotRole;
  /** The membership's branch at that moment (an owner has none). */
  branch_id: string | null;
  display_name: string | null;
}

const storage = new AsyncLocalStorage<ActorSnapshot>();

/** Runs `fn` with `snapshot` as the acting staff member of this request. */
export function runWithAuditActor<T>(snapshot: ActorSnapshot, fn: () => T): T {
  return storage.run(snapshot, fn);
}

export function currentAuditActor(): ActorSnapshot | undefined {
  return storage.getStore();
}

/** Entity types whose audit rows carry the snapshot (the order's own timeline). */
const SNAPSHOT_ENTITY_TYPES = new Set(['BranchOrder', 'Return']);

/**
 * The afterState to store: unchanged unless a staff request is running AND
 * the row is about a branch order AND it is written by that same person (a
 * sweep or the system acting inside the same request - actorId null or
 * someone else - never borrows the requester's identity).
 */
export function withActorSnapshot(
  entityType: string,
  actorId: string | null | undefined,
  afterState: unknown,
): unknown {
  const actor = currentAuditActor();
  if (!actor || !actorId || actor.user_id !== actorId) return afterState;
  if (!SNAPSHOT_ENTITY_TYPES.has(entityType)) return afterState;
  const base =
    afterState && typeof afterState === 'object' && !Array.isArray(afterState)
      ? (afterState as Record<string, unknown>)
      : {};
  return { ...base, [ACTOR_SNAPSHOT_KEY]: actor };
}

/** Reads a stored snapshot back, or null for an older row / a malformed value. */
export function readActorSnapshot(afterState: unknown): ActorSnapshot | null {
  if (!afterState || typeof afterState !== 'object') return null;
  const raw = (afterState as Record<string, unknown>)[ACTOR_SNAPSHOT_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (s.v !== 1 || typeof s.user_id !== 'string') return null;
  if (
    s.role !== 'OWNER' &&
    s.role !== 'BRANCH_EMPLOYEE' &&
    s.role !== 'PLATFORM_STAFF'
  ) {
    return null;
  }
  return {
    v: 1,
    user_id: s.user_id,
    role: s.role,
    branch_id: typeof s.branch_id === 'string' ? s.branch_id : null,
    display_name: typeof s.display_name === 'string' ? s.display_name : null,
  };
}
