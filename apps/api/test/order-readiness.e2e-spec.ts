import { ThrottlerStorage } from '@nestjs/throttler';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { OutboxRelayService } from './../src/outbox/outbox-relay.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { tb26Fixtures } from './helpers/tb26-fixtures';

// «إدارة طلبات الفرع v2» phase 2 (2026-11-24): preparation start, the saved
// prep checklist, «جاهز» (a sub-state of PREPARING) and the two customer
// notifications. Through the real endpoints only. Covers: the migration's
// columns and no backfill, who/when on every step (+ the audit actor), the
// closed checklist and its permissions (owner any branch, the branch's
// employee, never another branch / store, never an employee on her own
// order - the owner may, recorded), the server-side readiness rule and the
// send / hand-over gate for orders started from now on, older orders on the
// old path, READY_FOR_PICKUP and ORDER_SENT (no pickup code anywhere), the
// queue «جاهز» tab and counts (branch + the owner's all branches), the
// shopper's «جاهز للاستلام», and compatibility with cancellation and stock.
describe('Order readiness: preparation, checklist, «جاهز», notifications (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let relay: OutboxRelayService;
  const f = tb26Fixtures(() => app);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // nothing here is about rate limiting
      .overrideProvider(ThrottlerStorage)
      .useValue({
        increment: () =>
          Promise.resolve({
            totalHits: 1,
            timeToExpire: 60,
            isBlocked: false,
            timeToBlockExpire: 0,
          }),
      })
      .compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    relay = app.get(OutboxRelayService);
  });
  afterAll(async () => {
    await app.close();
  });

  type Store = Awaited<ReturnType<typeof f.store>>;
  type Account = Awaited<ReturnType<typeof f.account>>;
  const queue = (s: Store, branchId: string, qs = '') =>
    `/api/v1/vendors/${s.vendorId}/branches/${branchId}/order-queue${qs}`;
  const get = (url: string, who: { token: string }) =>
    f.http().get(url).set(f.bearer(who.token));
  const order = (id: string) =>
    prisma.branchOrder.findUniqueOrThrow({ where: { id } });
  const codeOf = async (id: string) => (await order(id)).pickupCode!;
  async function named(name: string): Promise<Account> {
    const a = await f.account();
    await prisma.customerProfile.update({
      where: { userId: a.userId },
      data: { displayName: name },
    });
    return a;
  }
  async function employee(s: Store, branchId: string, name: string) {
    return f.member(s.vendorId, await named(name), 'BRANCH_EMPLOYEE', branchId);
  }
  /** Turns a bought (pickup, PLACED) order into a DELIVERY order with a slot. */
  let windows = 0;
  async function asDelivery(s: Store, id: string) {
    // a different day for each call: windows of one branch never overlap
    windows += 1;
    const due = new Date(Date.now() + (1 + windows) * 24 * 3600_000);
    const date = new Date(
      Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate()),
    );
    const w = await prisma.deliveryWindow.create({
      data: {
        vendorId: s.vendorId,
        branchId: s.branchA,
        dayOfWeek: date.getUTCDay(),
        startMinute: 600,
        endMinute: 720,
        capacity: 10,
      },
    });
    await prisma.branchOrder.update({
      where: { id },
      data: {
        fulfilmentMethod: 'DELIVERY',
        pickupCode: null,
        deliveryWindowId: w.id,
        scheduledDate: date,
      },
    });
  }
  /** Lets the relay write the customer notification of `branchOrderId`. */
  async function notificationsOf(branchOrderId: string) {
    for (let i = 0; i < 400; i += 1) {
      const pending = await prisma.outboxEvent.count({
        where: {
          status: { in: ['PENDING', 'PROCESSING'] },
          payload: { path: ['branch_order_id'], equals: branchOrderId },
        },
      });
      if (pending === 0) break;
      if (!(await relay.dispatchOnce()))
        await new Promise((r) => setTimeout(r, 50));
    }
    return prisma.notification.findMany({
      where: { targetId: branchOrderId },
      orderBy: { createdAt: 'asc' },
    });
  }

  let s: Store;
  let empA: Account;
  let empA2: Account;
  let empB: Account;
  let otherOwner: Account;
  let shopper: Account;
  let variant: string;

  beforeAll(async () => {
    s = await f.store();
    await prisma.customerProfile.update({
      where: { userId: s.owner.userId },
      data: { displayName: 'ريم المالكة' },
    });
    empA = await employee(s, s.branchA, 'هبة موظفة');
    empA2 = await employee(s, s.branchA, 'أمل موظفة');
    empB = await employee(s, s.branchB, 'دانة موظفة');
    otherOwner = (await f.store()).owner;
    shopper = await named('سارة أحمد');
    variant = await f.offer(s, 30);
  });

  it('migration: a new order has every new field empty; older orders are never backfilled', async () => {
    const { branchOrderId: id } = await f.buy(shopper, s, variant);
    const o = await order(id);
    expect(o.preparationStartedAt).toBeNull();
    expect(o.preparationStartedById).toBeNull();
    expect(o.readyAt).toBeNull();
    expect(o.readyById).toBeNull();
    expect(o.completedAt).toBeNull();
    expect(
      await prisma.branchOrderPrepCheck.count({ where: { branchOrderId: id } }),
    ).toBe(0);
    const d = await get(queue(s, s.branchA, `/${id}`), s.owner).expect(200);
    expect(d.body.preparation).toMatchObject({
      requires_ready: false,
      started_at: null,
      started_by: null,
      is_ready: false,
      ready_at: null,
      missing: ['ITEMS_VERIFIED', 'PACKED'],
      can_edit: false,
    });
    expect(d.body.preparation.checklist).toEqual([
      expect.objectContaining({
        key: 'ITEMS_VERIFIED',
        required: true,
        done: false,
      }),
      expect.objectContaining({ key: 'PACKED', required: true, done: false }),
      expect.objectContaining({
        key: 'INVOICE_ATTACHED',
        required: false,
        done: false,
      }),
    ]);
    // the closed lists are enforced by the database too
    await expect(
      prisma.$executeRaw`INSERT INTO branch_order_prep_checks (id, "vendorId", "branchOrderId", "itemKey", "doneById", "doneByRole") VALUES (gen_random_uuid()::text, ${s.vendorId}, ${id}, 'GIFT_WRAP', ${empA.userId}, 'BRANCH_EMPLOYEE')`,
    ).rejects.toThrow();
    await expect(
      prisma.$executeRaw`UPDATE branch_orders SET "readyByRole" = 'CUSTOMER', "readyAt" = now() WHERE id = ${id}`,
    ).rejects.toThrow();
    // checklist on a PLACED order: not while preparing
    const placed = await f.prepCheck(s, empA, id, 'PACKED').expect(409);
    expect(placed.body.error.code).toBe('ORDER_NOT_PREPARING');
  });

  it('start-preparation records who and when (role at that moment) - the order is then on the new path', async () => {
    const { branchOrderId: id } = await f.buy(shopper, s, variant);
    const before = Date.now();
    await f.staff(s, empA, id, 'start-preparation').expect(201);
    const o = await order(id);
    expect(o.status).toBe('PREPARING');
    expect(o.preparationStartedById).toBe(empA.userId);
    expect(o.preparationStartedByRole).toBe('BRANCH_EMPLOYEE');
    expect(o.preparationStartedAt!.getTime()).toBeGreaterThanOrEqual(
      before - 1000,
    );
    const d = await get(queue(s, s.branchA, `/${id}`), s.owner).expect(200);
    expect(d.body.preparation).toMatchObject({
      requires_ready: true,
      started_by: { name: 'هبة موظفة', role: 'BRANCH_EMPLOYEE' },
      can_edit: true,
    });
    // its one next step: «جاهز» (with what is missing) - not send / hand over
    expect(d.body.actions).toEqual(
      expect.arrayContaining([
        {
          key: 'mark_ready',
          primary: true,
          missing: ['ITEMS_VERIFIED', 'PACKED'],
        },
      ]),
    );
    expect(d.body.actions.map((a: { key: string }) => a.key)).not.toContain(
      'pickup_handover',
    );
    // the status change keeps the actor (role + branch) for the timeline
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: id, action: 'branch_order.status_changed' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit.afterState).toMatchObject({
      status: 'PREPARING',
      actor_snapshot: {
        role: 'BRANCH_EMPLOYEE',
        branch_id: s.branchA,
        user_id: empA.userId,
      },
    });
  });

  it('the checklist: closed items, saved with who / when / role; idempotent; un-tick before «جاهز» only; the same boundary as every order action', async () => {
    const { branchOrderId: id } = await f.buy(shopper, s, variant);
    await f.staff(s, empA, id, 'start-preparation').expect(201);
    const t1 = await f.prepCheck(s, empA, id, 'ITEMS_VERIFIED').expect(200);
    expect(t1.body).toEqual({
      id,
      item: 'ITEMS_VERIFIED',
      done: true,
      missing: ['PACKED'],
    });
    const row = await prisma.branchOrderPrepCheck.findUniqueOrThrow({
      where: {
        branchOrderId_itemKey: { branchOrderId: id, itemKey: 'ITEMS_VERIFIED' },
      },
    });
    expect(row).toMatchObject({
      doneById: empA.userId,
      doneByRole: 'BRANCH_EMPLOYEE',
      vendorId: s.vendorId,
    });
    // ticking again changes and records nothing
    await f.prepCheck(s, empA2, id, 'ITEMS_VERIFIED').expect(200);
    expect(
      (
        await prisma.branchOrderPrepCheck.findUniqueOrThrow({
          where: { id: row.id },
        })
      ).doneById,
    ).toBe(empA.userId);
    expect(
      await prisma.auditLog.count({
        where: { entityId: id, action: 'branch_order.prep_check_done' },
      }),
    ).toBe(1);
    // the owner (any branch of her store) ticks the optional one
    await f.prepCheck(s, s.owner, id, 'INVOICE_ATTACHED').expect(200);
    // un-tick: the row goes, the step is recorded
    const un = await f
      .prepCheck(s, s.owner, id, 'INVOICE_ATTACHED', false)
      .expect(200);
    expect(un.body.done).toBe(false);
    expect(
      await prisma.branchOrderPrepCheck.count({
        where: { branchOrderId: id, itemKey: 'INVOICE_ATTACHED' },
      }),
    ).toBe(0);
    const undone = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: id, action: 'branch_order.prep_check_undone' },
    });
    expect(undone.afterState).toMatchObject({
      item: 'INVOICE_ATTACHED',
      done: false,
      role: 'OWNER',
      actor_snapshot: { role: 'OWNER' },
    });
    // details: each item with who and when
    const d = await get(queue(s, s.branchA, `/${id}`), empA).expect(200);
    expect(d.body.preparation.checklist[0]).toMatchObject({
      key: 'ITEMS_VERIFIED',
      done: true,
      done_by: { name: 'هبة موظفة', role: 'BRANCH_EMPLOYEE' },
      done_at: expect.any(String),
    });
    expect(d.body.preparation.missing).toEqual(['PACKED']);
    // the timeline names the step and the item
    const tl = await get(
      queue(s, s.branchA, `/${id}/timeline`),
      s.owner,
    ).expect(200);
    const kinds = tl.body.items.map(
      (i: { kind: string; item?: string }) => `${i.kind}:${i.item ?? ''}`,
    );
    expect(kinds).toEqual(
      expect.arrayContaining([
        'prep_check:ITEMS_VERIFIED',
        'prep_check:INVOICE_ATTACHED',
        'prep_uncheck:INVOICE_ATTACHED',
      ]),
    );
    // refusals
    await f.prepCheck(s, empA, id, 'GIFT_WRAP').expect(404);
    await f
      .http()
      .patch(
        `/api/v1/vendors/${s.vendorId}/branches/${s.branchA}/orders/${id}/prep-checklist/PACKED`,
      )
      .set(f.staffHeaders(empA))
      .send({ done: 'yes' })
      .expect(400);
    // another branch's employee, another store's owner: refused by the guard
    await f.prepCheck(s, empB, id, 'PACKED').expect(403);
    await f.prepCheck(s, otherOwner, id, 'PACKED').expect(403);
    // the order asked for under branch B (even by the owner): not there
    await f
      .http()
      .patch(
        `/api/v1/vendors/${s.vendorId}/branches/${s.branchB}/orders/${id}/prep-checklist/PACKED`,
      )
      .set(f.staffHeaders(s.owner))
      .send({ done: true })
      .expect(404);
    expect(
      await prisma.branchOrderPrepCheck.count({
        where: { branchOrderId: id, itemKey: 'PACKED' },
      }),
    ).toBe(0);
  });

  it('«جاهز» needs the two mandatory items (checked by the server), once; then the checklist is locked - the optional item never blocks', async () => {
    const { branchOrderId: id } = await f.buy(shopper, s, variant);
    await f.staff(s, empA, id, 'start-preparation').expect(201);
    const none = await f.staff(s, empA, id, 'mark-ready').expect(409);
    expect(none.body.error).toMatchObject({
      code: 'PREP_CHECKLIST_INCOMPLETE',
      details: ['ITEMS_VERIFIED', 'PACKED'],
    });
    await f.prepCheck(s, empA, id, 'ITEMS_VERIFIED').expect(200);
    const half = await f.staff(s, empA, id, 'mark-ready').expect(409);
    expect(half.body.error.details).toEqual(['PACKED']);
    expect((await order(id)).readyAt).toBeNull();
    await f.prepCheck(s, empA2, id, 'PACKED').expect(200);
    const ready = await f.staff(s, empA2, id, 'mark-ready').expect(201);
    expect(ready.body).toMatchObject({
      id,
      status: 'PREPARING',
      ready_at: expect.any(String),
    });
    const o = await order(id);
    expect(o).toMatchObject({
      status: 'PREPARING',
      readyById: empA2.userId,
      readyByRole: 'BRANCH_EMPLOYEE',
    });
    expect(
      (await f.staff(s, empA, id, 'mark-ready').expect(409)).body.error.code,
    ).toBe('ORDER_ALREADY_READY');
    expect(
      (await f.prepCheck(s, empA, id, 'PACKED', false).expect(409)).body.error
        .code,
    ).toBe('ORDER_ALREADY_READY');
    expect(
      (await f.prepCheck(s, empA, id, 'INVOICE_ATTACHED').expect(409)).body
        .error.code,
    ).toBe('ORDER_ALREADY_READY');
    // the audit: «جاهز» with who, role and branch
    const a = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: id, action: 'branch_order.ready' },
    });
    expect(a.actorId).toBe(empA2.userId);
    expect(a.afterState).toMatchObject({
      ready: true,
      fulfilment_method: 'PICKUP',
      role: 'BRANCH_EMPLOYEE',
      branch_id: s.branchA,
      actor_snapshot: { role: 'BRANCH_EMPLOYEE', branch_id: s.branchA },
    });
    // details + timeline
    const d = await get(queue(s, s.branchA, `/${id}`), s.owner).expect(200);
    expect(d.body.preparation).toMatchObject({
      is_ready: true,
      ready_by: { name: 'أمل موظفة', role: 'BRANCH_EMPLOYEE' },
      can_edit: false,
      missing: [],
    });
    expect(d.body.bucket).toBe('ready');
    expect(d.body.actions).toEqual(
      expect.arrayContaining([{ key: 'pickup_handover', primary: true }]),
    );
    const tl = await get(queue(s, s.branchA, `/${id}/timeline`), empA).expect(
      200,
    );
    expect(tl.body.items[0]).toMatchObject({
      kind: 'ready',
      actor: { kind: 'employee', name: 'أمل موظفة' },
    });
  });

  it('pickup: no hand-over before «جاهز» (the same answer with a right or a wrong code); READY_FOR_PICKUP to the shopper; then the hand-over completes (completedAt)', async () => {
    const { branchOrderId: id } = await f.buy(shopper, s, variant);
    const code = await codeOf(id);
    await f.staff(s, empA, id, 'start-preparation').expect(201);
    for (const c of [code, code === '000000' ? '000001' : '000000']) {
      const r = await f
        .staff(s, empA, id, 'pickup-handover', { pickup_code: c })
        .expect(409);
      expect(r.body.error.code).toBe('ORDER_NOT_READY');
      expect(JSON.stringify(r.body)).not.toContain(code);
    }
    expect((await order(id)).status).toBe('PREPARING');
    await f.prepareAndReady(s, empA, id);
    const notes = await notificationsOf(id);
    const ready = notes.filter((n) => n.type === 'READY_FOR_PICKUP');
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({
      recipientUserId: shopper.userId,
      audience: 'CUSTOMER',
      targetType: 'BRANCH_ORDER',
      targetId: id,
    });
    expect(ready[0].data).toEqual({});
    // nobody of the store is told (it is the shopper's notice)
    expect(
      notes.filter(
        (n) =>
          n.recipientUserId !== shopper.userId && n.type === 'READY_FOR_PICKUP',
      ),
    ).toEqual([]);
    const done = await f
      .staff(s, empA, id, 'pickup-handover', { pickup_code: code })
      .expect(201);
    expect(done.body.status).toBe('COMPLETED');
    const o = await order(id);
    expect(o.completedAt).not.toBeNull();
    expect(o.pickedUpAt).not.toBeNull();
    // the shopper's own order: «جاهز للاستلام» only while ready, nothing internal
    const mine = await get('/api/v1/customers/me/orders', shopper).expect(200);
    const row = mine.body.find((x: { id: string }) => x.id === id);
    expect(row.ready_for_pickup).toBe(false);
    for (const k of [
      'preparation',
      'ready_at',
      'ready_by',
      'checklist',
      'internal_store_note',
    ])
      expect(row).not.toHaveProperty(k);
  });

  it('the shopper sees «جاهز للاستلام» (a flag only) while her pickup order is ready', async () => {
    const { branchOrderId: id } = await f.buy(shopper, s, variant);
    await f.staff(s, empA, id, 'start-preparation').expect(201);
    const before = await get('/api/v1/customers/me/orders', shopper).expect(
      200,
    );
    expect(
      before.body.find((x: { id: string }) => x.id === id).ready_for_pickup,
    ).toBe(false);
    await f.prepareAndReady(s, empA, id);
    const after = await get('/api/v1/customers/me/orders', shopper).expect(200);
    const row = after.body.find((x: { id: string }) => x.id === id);
    expect(row).toMatchObject({ status: 'PREPARING', ready_for_pickup: true });
    expect(JSON.stringify(row)).not.toContain('هبة');
  });

  it('delivery: no «sent» before «جاهز»; no shopper notice at «جاهز»; ORDER_SENT when it is actually sent', async () => {
    const { branchOrderId: id } = await f.buy(shopper, s, variant);
    await asDelivery(s, id);
    await f.staff(s, empA, id, 'start-preparation').expect(201);
    expect(
      (await f.staff(s, empA, id, 'mark-sent').expect(409)).body.error.code,
    ).toBe('ORDER_NOT_READY');
    await f.prepareAndReady(s, empA, id);
    const d = await get(queue(s, s.branchA, `/${id}`), empA).expect(200);
    expect(d.body.actions).toEqual(
      expect.arrayContaining([{ key: 'mark_sent', primary: true }]),
    );
    expect(
      (await notificationsOf(id)).filter((n) => n.type === 'READY_FOR_PICKUP'),
    ).toEqual([]);
    await f.staff(s, empA, id, 'mark-sent').expect(201);
    const sent = (await notificationsOf(id)).filter(
      (n) => n.type === 'ORDER_SENT',
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      recipientUserId: shopper.userId,
      audience: 'CUSTOMER',
      targetId: id,
    });
    expect(sent[0].data).toEqual({});
  });

  it('older orders (PREPARING before the release - no start time) keep the old path: sent / handed over without «جاهز»; ORDER_SENT still goes', async () => {
    const a = (await f.buy(shopper, s, variant)).branchOrderId;
    const b = (await f.buy(shopper, s, variant)).branchOrderId;
    await asDelivery(s, b);
    // as an order started before the release looks: PREPARING, no start fields
    for (const id of [a, b]) {
      await prisma.branchOrder.update({
        where: { id },
        data: { status: 'PREPARING' },
      });
    }
    const d = await get(queue(s, s.branchA, `/${a}`), empA).expect(200);
    expect(d.body.preparation.requires_ready).toBe(false);
    expect(d.body.actions).toEqual(
      expect.arrayContaining([{ key: 'pickup_handover', primary: true }]),
    );
    expect(d.body.actions.map((x: { key: string }) => x.key)).not.toContain(
      'mark_ready',
    );
    await f
      .staff(s, empA, a, 'pickup-handover', { pickup_code: await codeOf(a) })
      .expect(201);
    expect((await order(a)).completedAt).not.toBeNull();
    await f.staff(s, empA, b, 'mark-sent').expect(201);
    expect((await notificationsOf(b)).map((n) => n.type)).toContain(
      'ORDER_SENT',
    );
  });

  it('own order: an employee never ticks or readies her own order (another member does); the owner may - recorded as a self-fulfilment', async () => {
    // the employee buys at her own store
    const own = (await f.buy(empA, s, variant)).branchOrderId;
    // 2026-11-24 policy: not even starting it - a colleague does
    expect(
      (await f.staff(s, empA, own, 'start-preparation').expect(403)).body.error
        .code,
    ).toBe('OWN_ORDER_FORBIDDEN');
    expect((await order(own)).status).toBe('PLACED');
    await f.staff(s, empA2, own, 'start-preparation').expect(201);
    const tick = await f.prepCheck(s, empA, own, 'ITEMS_VERIFIED').expect(403);
    expect(tick.body.error.code).toBe('OWN_ORDER_FORBIDDEN');
    expect(
      (await f.staff(s, empA, own, 'mark-ready').expect(403)).body.error.code,
    ).toBe('OWN_ORDER_FORBIDDEN');
    expect(
      await prisma.branchOrderPrepCheck.count({
        where: { branchOrderId: own },
      }),
    ).toBe(0);
    const mineView = await get(queue(s, s.branchA, `/${own}`), empA).expect(
      200,
    );
    expect(mineView.body.preparation).toMatchObject({
      can_edit: false,
      own_order_blocked: true,
    });
    expect(
      mineView.body.actions.map((x: { key: string }) => x.key),
    ).not.toContain('mark_ready');
    // a colleague prepares it
    await f.prepareAndReady(s, empA2, own);
    expect((await order(own)).readyById).toBe(empA2.userId);

    // the owner's own order: allowed, recorded
    const ownerOwn = (await f.buy(s.owner, s, variant)).branchOrderId;
    await f.staff(s, s.owner, ownerOwn, 'start-preparation').expect(201);
    await f.prepareAndReady(s, s.owner, ownerOwn);
    const self = await prisma.auditLog.findMany({
      where: { entityId: ownerOwn, action: 'branch_order.self_fulfilment' },
    });
    const steps = self.map((r) => (r.afterState as { step: string }).step);
    expect(steps).toEqual(
      expect.arrayContaining(['START_PREPARATION', 'PREP_CHECK', 'MARK_READY']),
    );
  });

  it("the queue: a «جاهز» tab with real counts (not «قيد التجهيز» any more), a ready flag on the row - in the branch and the owner's all branches; employees never all branches", async () => {
    const t = await f.store();
    const v = await f.offer(t, 10);
    const emp = await employee(t, t.branchA, 'لمى موظفة');
    const buyer = await named('نور خالد');
    const p1 = (await f.buy(buyer, t, v)).branchOrderId;
    const p2 = (await f.buy(buyer, t, v)).branchOrderId;
    const p3 = (await f.buy(buyer, t, v)).branchOrderId;
    await f.staff(t, emp, p1, 'start-preparation').expect(201);
    await f.staff(t, emp, p2, 'start-preparation').expect(201);
    await f.prepareAndReady(t, emp, p2);
    const q = await get(queue(t, t.branchA), emp).expect(200);
    expect(q.body.counts).toMatchObject({
      active: 3,
      new: 1,
      preparing: 1,
      ready: 1,
    });
    const rows = new Map(q.body.items.map((r: { id: string }) => [r.id, r]));
    expect(rows.get(p2)).toMatchObject({ bucket: 'ready', is_ready: true });
    expect(rows.get(p1)).toMatchObject({
      bucket: 'preparing',
      is_ready: false,
    });
    expect(rows.get(p3)).toMatchObject({ bucket: 'new', is_ready: false });
    const ready = await get(queue(t, t.branchA, '?tab=ready'), emp).expect(200);
    expect(ready.body.items.map((r: { id: string }) => r.id)).toEqual([p2]);
    const prep = await get(queue(t, t.branchA, '?tab=preparing'), emp).expect(
      200,
    );
    expect(prep.body.items.map((r: { id: string }) => r.id)).toEqual([p1]);
    const all = await get(
      `/api/v1/vendors/${t.vendorId}/order-queue?tab=ready`,
      t.owner,
    ).expect(200);
    expect(all.body.items.map((r: { id: string }) => r.id)).toEqual([p2]);
    expect(all.body.counts.ready).toBe(1);
    await get(
      `/api/v1/vendors/${t.vendorId}/order-queue?tab=ready`,
      emp,
    ).expect(403);
  });

  it('cancellation and stock: readiness writes no stock; a ready order can still be cancelled (reason required) and its units come back', async () => {
    const t = await f.store();
    const v = await f.offer(t, 10);
    const emp = await employee(t, t.branchA, 'رنا موظفة');
    const stock = async () =>
      prisma.branchStock.findFirstOrThrow({
        where: { branchId: t.branchA, offerVariantId: v },
      });
    const start = await stock();
    const id = (await f.buy(shopper, t, v)).branchOrderId;
    const afterBuy = await stock();
    expect(afterBuy.quantity).toBe(start.quantity - 1);
    const movesBefore = await prisma.stockMovement.count({
      where: { offerVariantId: v },
    });
    await f.staff(t, emp, id, 'start-preparation').expect(201);
    await f.prepareAndReady(t, emp, id);
    const afterReady = await stock();
    expect(afterReady.quantity).toBe(afterBuy.quantity);
    expect(afterReady.reservedQuantity).toBe(afterBuy.reservedQuantity);
    expect(
      await prisma.stockMovement.count({ where: { offerVariantId: v } }),
    ).toBe(movesBefore);
    // still PREPARING: the existing cancellation rules (reason required after preparation started)
    const noReason = await f.staff(t, t.owner, id, 'cancel', {});
    expect(noReason.status).toBeGreaterThanOrEqual(400);
    expect(noReason.body.error.code).toBe('CANCELLATION_REASON_REQUIRED');
    await f
      .staff(t, t.owner, id, 'cancel', {
        reason: 'العميلة طلبت الإلغاء هاتفياً',
      })
      .expect(201);
    expect((await order(id)).status).toBe('CANCELLED');
    expect((await stock()).quantity).toBe(start.quantity);
    // a cancelled order has no checklist / ready step any more
    expect(
      (await f.staff(t, t.owner, id, 'mark-ready').expect(409)).body.error.code,
    ).toBe('ORDER_NOT_PREPARING');
  });

  it('the pickup code never appears: not in any store answer, the timeline, the prep sheet, an audit row, an outbox event or a notification of the order', async () => {
    const { branchOrderId: id } = await f.buy(shopper, s, variant);
    const code = await codeOf(id);
    await f.staff(s, empA, id, 'start-preparation').expect(201);
    await f.prepCheck(s, empA, id, 'ITEMS_VERIFIED').expect(200);
    await f.prepCheck(s, empA, id, 'PACKED').expect(200);
    const answers = [
      await f.staff(s, empA, id, 'mark-ready').expect(201),
      await get(queue(s, s.branchA, `/${id}`), empA).expect(200),
      await get(queue(s, s.branchA, `/${id}`), s.owner).expect(200),
      await get(queue(s, s.branchA, `/${id}/timeline`), s.owner).expect(200),
      await get(queue(s, s.branchA, `/${id}/prep-sheet`), empA).expect(200),
      await get(queue(s, s.branchA, '?tab=ready'), empA).expect(200),
    ];
    for (const a of answers) {
      expect(JSON.stringify(a.body)).not.toContain(code);
      expect(JSON.stringify(a.body)).not.toContain('pickup_code');
    }
    const audit = await prisma.auditLog.findMany({ where: { entityId: id } });
    const events = await prisma.outboxEvent.findMany({
      where: { payload: { path: ['branch_order_id'], equals: id } },
    });
    const notes = await notificationsOf(id);
    for (const x of [audit, events, notes])
      expect(JSON.stringify(x)).not.toContain(code);
    expect(events.map((e) => e.eventType)).toContain(
      'branch_order.ready_for_pickup',
    );
  });
});
