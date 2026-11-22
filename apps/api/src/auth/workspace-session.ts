import { ForbiddenException, SetMetadata } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

/**
 * TB-26: a workspace session - the short-lived, revocable proof that the
 * signed-in person deliberately entered ONE store workspace or the
 * platform workspace in this browser tab. Signing in alone is shopping
 * only: while `workspace_scoping_enabled` is on, every store route
 * (VendorMembershipGuard) and every platform route (PlatformRoleGuard)
 * also needs a valid workspace token for that exact store / the platform,
 * sent as `X-Workspace-Token` - never in a URL, never kept in
 * localStorage by the web app.
 *
 * The token is only an entry mark, never the permission itself: the
 * guards still read the membership / platform role from Postgres on
 * every request, so suspending a membership or removing a role takes
 * effect at once even for a token that is still alive. A token is bound
 * to the session it was issued under (a hash of that session token): it
 * is useless with any other session, and dies with logout, a password
 * reset (session version) or session expiry.
 */

export const WORKSPACE_HEADER = 'x-workspace-token';

/** TB-26: marks a session route that a workspace request may also reach
 * (entering/leaving a workspace, the workspace list, logout) - see
 * SessionAuthGuard's SHOPPING_REQUIRED check. */
export const WORKSPACE_NEUTRAL_KEY = 'tb26_workspace_neutral';
export const WorkspaceNeutral = () => SetMetadata(WORKSPACE_NEUTRAL_KEY, true);
/** Idle lifetime - every accepted use extends it by this much. */
export const WORKSPACE_IDLE_SECONDS = 30 * 60;
/** Hard cap from issue, however active the tab is. */
export const WORKSPACE_MAX_SECONDS = 8 * 60 * 60;

const KEY_PREFIX = 'workspace_session:';
const SESSION_SET_PREFIX = 'session_workspaces:';

export type WorkspaceKind = 'VENDOR' | 'PLATFORM';

export interface WorkspaceSessionData {
  userId: string;
  /** sha256 of the session token this workspace was entered under. */
  sessionHash: string;
  kind: WorkspaceKind;
  vendorId: string | null;
  issuedAt: string;
}

export function sessionHash(sessionToken: string): string {
  return createHash('sha256').update(sessionToken).digest('hex');
}

export async function createWorkspaceSession(
  redis: RedisService,
  data: Omit<WorkspaceSessionData, 'issuedAt'>,
): Promise<{ token: string; expiresInSeconds: number }> {
  const token = randomBytes(32).toString('base64url');
  const record: WorkspaceSessionData = {
    ...data,
    issuedAt: new Date().toISOString(),
  };
  await redis
    .multi()
    .set(
      KEY_PREFIX + token,
      JSON.stringify(record),
      'EX',
      WORKSPACE_IDLE_SECONDS,
    )
    .sadd(SESSION_SET_PREFIX + data.sessionHash, token)
    .expire(SESSION_SET_PREFIX + data.sessionHash, WORKSPACE_MAX_SECONDS)
    .exec();
  return { token, expiresInSeconds: WORKSPACE_IDLE_SECONDS };
}

/** The live workspace session for `token`, or null (unknown, expired or
 * past its hard cap). */
export async function readWorkspaceSession(
  redis: RedisService,
  token: string,
): Promise<WorkspaceSessionData | null> {
  const raw = await redis.get(KEY_PREFIX + token);
  if (!raw) return null;
  const data = JSON.parse(raw) as WorkspaceSessionData;
  const age = (Date.now() - new Date(data.issuedAt).getTime()) / 1000;
  if (!(age >= 0 && age < WORKSPACE_MAX_SECONDS)) {
    await redis.del(KEY_PREFIX + token);
    return null;
  }
  return data;
}

/** Leaving the workspace: this one token only. */
export async function revokeWorkspaceSession(
  redis: RedisService,
  token: string,
  data: Pick<WorkspaceSessionData, 'sessionHash'>,
): Promise<void> {
  await redis
    .multi()
    .del(KEY_PREFIX + token)
    .srem(SESSION_SET_PREFIX + data.sessionHash, token)
    .exec();
}

/** Logout: every workspace entered under this session. (The binding to
 * the session already makes them unusable; this removes them.) */
export async function revokeWorkspacesForSession(
  redis: RedisService,
  sessionToken: string,
): Promise<void> {
  const setKey = SESSION_SET_PREFIX + sessionHash(sessionToken);
  const tokens = await redis.smembers(setKey);
  const pipeline = redis.multi();
  for (const t of tokens) pipeline.del(KEY_PREFIX + t);
  pipeline.del(setKey);
  await pipeline.exec();
}

export async function workspaceScopingEnabled(
  prisma: PrismaService,
): Promise<boolean> {
  const row = await prisma.featureFlag.findUnique({
    where: { key: 'workspace_scoping_enabled' },
  });
  return row?.enabled ?? false;
}

function workspaceRequired(): ForbiddenException {
  return new ForbiddenException({
    code: 'WORKSPACE_REQUIRED',
    message:
      'Enter this workspace first - signing in alone gives access to shopping only',
  });
}

/**
 * The guards' check. A no-op while `workspace_scoping_enabled` is off.
 * When on: the request must carry a live workspace token, issued to this
 * user under this same session, for exactly this workspace (the store in
 * the route, or the platform). Each accepted use extends the idle
 * lifetime (never past the hard cap).
 */
export async function requireWorkspace(
  prisma: PrismaService,
  redis: RedisService,
  request: Request,
  expected: { kind: 'VENDOR'; vendorId: string } | { kind: 'PLATFORM' },
): Promise<void> {
  if (!(await workspaceScopingEnabled(prisma))) return;
  const token = request.header(WORKSPACE_HEADER);
  const sessionToken = request.sessionToken;
  if (!token || !sessionToken || !request.user) throw workspaceRequired();
  const ws = await readWorkspaceSession(redis, token);
  if (
    !ws ||
    ws.userId !== request.user.id ||
    ws.sessionHash !== sessionHash(sessionToken) ||
    ws.kind !== expected.kind ||
    (expected.kind === 'VENDOR' && ws.vendorId !== expected.vendorId)
  ) {
    throw workspaceRequired();
  }
  await redis.expire(KEY_PREFIX + token, WORKSPACE_IDLE_SECONDS);
}
