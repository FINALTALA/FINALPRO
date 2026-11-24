import type { Test } from 'supertest';

/**
 * «إدارة طلبات الفرع v2» phase 2 (2026-11-24): an order whose preparation
 * starts from this release on must be marked ready (its mandatory checklist
 * done) before mark-sent / pickup-handover. The older suites test other
 * things (notifications, returns, reviews, exceptions...) and drive orders
 * start-preparation -> send / hand over directly; for them, a successful
 * start-preparation is followed by this FIXTURE: the order is marked ready in
 * the database, standing for "the team prepared it". The readiness rules
 * themselves (the gate, the checklist, who may, the own-order rule, old
 * orders) are proven through the real endpoints in
 * order-readiness.e2e-spec.ts - never through this shortcut.
 *
 * Works for both `await staffAction(...)` and `staffAction(...).expect(201)`:
 * the request object is returned as is, only its completion is extended.
 */
export function readyAfterStartPreparation<T extends Test>(
  req: T,
  action: string,
  markReady: () => Promise<unknown>,
): T {
  if (action !== 'start-preparation') return req;
  const then = req.then.bind(req) as T['then'];
  (req as unknown as { then: T['then'] }).then = ((
    onFulfilled?: (value: unknown) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) =>
    then(async (res: { status: number }) => {
      if (res.status === 201) await markReady();
      return res;
    }).then(onFulfilled, onRejected)) as T['then'];
  return req;
}
