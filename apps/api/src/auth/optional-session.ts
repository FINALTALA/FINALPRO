import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { SessionService } from './session.service';

/**
 * The signed-in user on a PUBLIC route, if any - the same checks as
 * SessionAuthGuard (a live session whose version still matches), but a
 * missing, stale or revoked token simply means a guest here, never a
 * 401. Used where a public answer may be personalised (the default
 * delivery zone of the customer's own address, PD-2).
 */
export async function optionalSessionUserId(
  sessions: SessionService,
  prisma: PrismaService,
  req: Request,
): Promise<string | null> {
  const header = req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) return null;
  const session = await sessions.get(token);
  if (!session) return null;
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { sessionVersion: true },
  });
  return user && user.sessionVersion === session.sessionVersion
    ? session.userId
    : null;
}
