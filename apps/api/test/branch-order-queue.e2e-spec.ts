import { ThrottlerStorage } from '@nestjs/throttler';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { OutboxRelayService } from './../src/outbox/outbox-relay.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { tb26Fixtures } from './helpers/tb26-fixtures';

// «إدارة طلبات الفرع v1» (2026-11-22): the branch's order queue, one order's
// details and its timeline - read-only endpoints beside the unchanged order
// actions. Covers: branch isolation (owner / employee / another branch /
// another store), pagination, tabs, method / late / search filters, the
// fixed priority order and the owner-only «newest», server counts, the DTO
// per role (no pickup code anywhere), item snapshots, the slot and window,
// the actions offered per state, the timeline (actor role + branch AT THAT
// TIME, older rows «not recorded», customer and system events, masking for
// an employee, no phone / code in it), and the pickup-code check unchanged.
describe('Branch order queue, details and timeline (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const f = tb26Fixtures(() => app);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // nothing here is about rate limiting - the same never-blocking
      // storage as store-home / offer-drafts
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
    app.get(OutboxRelayService).onModuleDestroy();
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

  /** A shopper with a name of her own. */
  async function shopper(name: string) {
    const a = await f.account();
    await prisma.customerProfile.update({
      where: { userId: a.userId },
      data: { displayName: name },
    });
    return a;
  }
  async function employee(s: Store, branchId: string, name: string) {
    const a = await f.account();
    await prisma.customerProfile.update({
      where: { userId: a.userId },
      data: { displayName: name },
    });
    await f.member(s.vendorId, a, 'BRANCH_EMPLOYEE', branchId);
    return a;
  }
  const pickupCodeOf = async (id: string) =>
    (await prisma.branchOrder.findUniqueOrThrow({ where: { id } })).pickupCode!;

  /** Turns a bought (pickup) order into a slotted delivery order due at `due`. */
  async function asDelivery(s: Store, id: string, due: Date) {
    const date = new Date(
      Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate()),
    );
    const startMinute = due.getUTCHours() * 60 + due.getUTCMinutes();
    const w = await prisma.deliveryWindow.create({
      data: {
        vendorId: s.vendorId,
        branchId: s.branchA,
        dayOfWeek: date.getUTCDay(),
        startMinute,
        endMinute: Math.min(startMinute + 120, 1439),
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

  // One store, branch A busy with orders; branch B empty.
  let s: Store;
  let empA: Account;
  let empB: Account;
  /** a second employee of branch A - still there after empA is moved to B */
  let empA2: Account;
  let otherOwner: Account;
  let variant: string;
  const o: Record<string, string> = {};

  beforeAll(async () => {
    s = await f.store();
    await prisma.customerProfile.update({
      where: { userId: s.owner.userId },
      data: { displayName: 'ريم المالكة' },
    });
    empA = await employee(s, s.branchA, 'هبة موظفة');
    empB = await employee(s, s.branchB, 'دانة موظفة');
    empA2 = await employee(s, s.branchA, 'أمل موظفة');
    otherOwner = (await f.store()).owner;
    variant = await f.offer(s, 50);
    // in creation order: oldest first
    o.pickupOld = (
      await f.buy(await shopper('سارة أحمد'), s, variant)
    ).branchOrderId;
    o.late = (
      await f.buy(await shopper('ليلى محمود'), s, variant)
    ).branchOrderId;
    o.soon = (await f.buy(await shopper('منى'), s, variant)).branchOrderId;
    o.later = (
      await f.buy(await shopper('نور خالد'), s, variant)
    ).branchOrderId;
    o.pickupNew = (
      await f.buy(await shopper('هالة'), s, variant)
    ).branchOrderId;
    const now = Date.now();
    await asDelivery(s, o.late, new Date(now - 3 * 3600_000));
    await asDelivery(s, o.later, new Date(now + 5 * 24 * 3600_000));
    await asDelivery(s, o.soon, new Date(now + 2 * 24 * 3600_000));
  });

  it('isolation: owner and the branch employee read; another branch, another store and a foreign order do not', async () => {
    await get(queue(s, s.branchA), s.owner).expect(200);
    await get(queue(s, s.branchA), empA).expect(200);
    // VendorMembershipGuard: an employee of branch B never reads branch A
    await get(queue(s, s.branchA), empB).expect(403);
    await get(queue(s, s.branchA, `/${o.late}`), empB).expect(403);
    await get(queue(s, s.branchA, `/${o.late}/timeline`), empB).expect(403);
    // another store's owner is not a member at all
    await get(queue(s, s.branchA), otherOwner).expect(403);
    // an order of branch A asked for under branch B: it does not exist there
    const wrong = await get(queue(s, s.branchB, `/${o.late}`), s.owner).expect(
      404,
    );
    expect(wrong.body.error.code).toBe('BRANCH_ORDER_NOT_FOUND');
    await get(queue(s, s.branchB, `/${o.late}/timeline`), s.owner).expect(404);
    await get(
      queue(s, s.branchA, '/00000000-0000-0000-0000-000000000000'),
      s.owner,
    ).expect(404);
    // branch B's own queue is empty
    const b = await get(queue(s, s.branchB), s.owner).expect(200);
    expect(b.body.items).toEqual([]);
    expect(b.body.counts.active).toBe(0);
  });

  it("«كل الفروع»: the owner's store-wide queue - every branch, each row with its branch, per-branch counts, ?branch=; employees and other stores 403", async () => {
    const t = await f.store();
    const v = await f.offer(t, 10);
    const a1 = (await f.buy(await shopper('أسيل'), t, v)).branchOrderId;
    const b1 = (await f.buy(await shopper('بيان'), t, v)).branchOrderId;
    // one order of branch B (a read-only test: only its branch changes)
    await prisma.branchOrder.update({
      where: { id: b1 },
      data: { branchId: t.branchB },
    });
    const branches = await prisma.storeBranch.findMany({
      where: { vendorId: t.vendorId },
      select: { id: true, name: true },
    });
    const nameOf = (id: string) => branches.find((b) => b.id === id)!.name;
    const all = `/api/v1/vendors/${t.vendorId}/order-queue`;
    type Row = { id: string; branch_id: string; branch_name: string };

    const r = await get(all, t.owner).expect(200);
    expect(r.body.scope).toBe('all');
    const rows = r.body.items as Row[];
    expect(rows.map((i) => i.id).sort()).toEqual([a1, b1].sort());
    for (const i of rows) expect(i.branch_name).toBe(nameOf(i.branch_id));
    expect(rows.find((i) => i.id === b1)!.branch_id).toBe(t.branchB);
    expect(r.body.counts.active).toBe(2);
    expect(r.body.branch_counts).toEqual(
      expect.arrayContaining([
        { branch_id: t.branchA, active: 1 },
        { branch_id: t.branchB, active: 1 },
      ]),
    );

    // narrowed to one branch: its rows and counts; the per-branch counts stay whole
    const onlyB = await get(`${all}?branch=${t.branchB}`, t.owner).expect(200);
    expect((onlyB.body.items as Row[]).map((i) => i.id)).toEqual([b1]);
    expect(onlyB.body.counts.active).toBe(1);
    expect(onlyB.body.branch_counts).toHaveLength(2);
    // another store's branch is not a filter of this store
    await get(`${all}?branch=${s.branchA}`, t.owner).expect(404);

    // the branch route is unchanged: one branch, rows with their branch, no store-wide counts
    const onlyA = await get(queue(t, t.branchA), t.owner).expect(200);
    expect(onlyA.body.scope).toBe('branch');
    expect((onlyA.body.items as Row[]).map((i) => [i.id, i.branch_id])).toEqual(
      [[a1, t.branchA]],
    );
    expect(onlyA.body.branch_counts).toBeUndefined();
    // an order opened from «كل الفروع» is read under its own branch
    await get(queue(t, t.branchB, `/${b1}`), t.owner).expect(200);

    // never an employee (own branch only), never another store's owner
    const emp = await employee(t, t.branchA, 'سلمى موظفة');
    await get(all, emp).expect(403);
    await get(`${all}?branch=${t.branchA}`, emp).expect(403);
    await get(all, otherOwner).expect(403);
  });

  it('the fixed priority order: the late one first, then the soonest slot, then the oldest without a slot', async () => {
    const r = await get(queue(s, s.branchA), empA).expect(200);
    const ids = r.body.items.map((i: { id: string }) => i.id);
    expect(ids).toEqual([o.late, o.soon, o.later, o.pickupOld, o.pickupNew]);
    const late = r.body.items[0];
    expect(late.is_late).toBe(true);
    expect(late.due_at).toEqual(expect.any(String));
    expect(late.window).toEqual({
      start_minute: expect.any(Number),
      end_minute: expect.any(Number),
    });
    expect(r.body.items[1].is_late).toBe(false);
    expect(r.body.items[3].due_at).toBeNull();
    expect(r.body.sort).toBe('priority');
    expect(r.body.counts).toMatchObject({ active: 5, new: 5, late: 1 });
  });

  it("«newest» is the owner's alternative only", async () => {
    const r = await get(queue(s, s.branchA, '?sort=newest'), s.owner).expect(
      200,
    );
    expect(r.body.items.map((i: { id: string }) => i.id)).toEqual([
      o.pickupNew,
      o.later,
      o.soon,
      o.late,
      o.pickupOld,
    ]);
    const e = await get(queue(s, s.branchA, '?sort=newest'), empA).expect(403);
    expect(e.body.error.code).toBe('QUEUE_SORT_OWNER_ONLY');
  });

  it('pagination: pages follow each other with no repeat and no gap', async () => {
    const p1 = await get(queue(s, s.branchA, '?limit=2'), empA).expect(200);
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.next_cursor).toBe('2');
    const p2 = await get(
      queue(s, s.branchA, `?limit=2&cursor=${p1.body.next_cursor}`),
      empA,
    ).expect(200);
    const p3 = await get(
      queue(s, s.branchA, `?limit=2&cursor=${p2.body.next_cursor}`),
      empA,
    ).expect(200);
    expect(p3.body.next_cursor).toBeNull();
    const all = [...p1.body.items, ...p2.body.items, ...p3.body.items].map(
      (i: { id: string }) => i.id,
    );
    expect(all).toEqual([o.late, o.soon, o.later, o.pickupOld, o.pickupNew]);
    await get(queue(s, s.branchA, '?limit=abc'), empA).expect(400);
    await get(queue(s, s.branchA, '?cursor=-1'), empA).expect(400);
  });

  it('filters: method, late only, unknown tab refused', async () => {
    const d = await get(queue(s, s.branchA, '?method=DELIVERY'), empA).expect(
      200,
    );
    expect(d.body.items.map((i: { id: string }) => i.id)).toEqual([
      o.late,
      o.soon,
      o.later,
    ]);
    expect(d.body.counts.active).toBe(3);
    const p = await get(queue(s, s.branchA, '?method=PICKUP'), empA).expect(
      200,
    );
    expect(p.body.items.map((i: { id: string }) => i.id)).toEqual([
      o.pickupOld,
      o.pickupNew,
    ]);
    const l = await get(queue(s, s.branchA, '?late=true'), empA).expect(200);
    expect(l.body.items.map((i: { id: string }) => i.id)).toEqual([o.late]);
    await get(queue(s, s.branchA, '?tab=ready'), empA).expect(400);
    await get(queue(s, s.branchA, '?method=SHIP'), empA).expect(400);
  });

  it('search: an order number, the last 4 phone digits or the pickup code - one box', async () => {
    const byNumber = await get(
      queue(s, s.branchA, `?q=%23${o.soon.slice(0, 8)}`),
      empA,
    ).expect(200);
    expect(byNumber.body.items.map((i: { id: string }) => i.id)).toEqual([
      o.soon,
    ]);
    const phone = (
      await prisma.branchOrder.findUniqueOrThrow({
        where: { id: o.later },
        include: {
          customerOrder: { include: { customer: { include: { user: true } } } },
        },
      })
    ).customerOrder.customer.user.phone;
    const byPhone = await get(
      queue(s, s.branchA, `?q=${phone.slice(-4)}`),
      empA,
    ).expect(200);
    expect(byPhone.body.items.map((i: { id: string }) => i.id)).toContain(
      o.later,
    );
    const code = await pickupCodeOf(o.pickupNew);
    const byCode = await get(queue(s, s.branchA, `?q=${code}`), empA).expect(
      200,
    );
    expect(byCode.body.items.map((i: { id: string }) => i.id)).toContain(
      o.pickupNew,
    );
    // the found row still does not carry the code
    expect(JSON.stringify(byCode.body)).not.toContain(`"${code}"`);
    expect(JSON.stringify(byCode.body)).not.toContain('pickup_code');
    const none = await get(queue(s, s.branchA, '?q=hello'), empA).expect(200);
    expect(none.body.items).toEqual([]);
    await get(queue(s, s.branchA, '?q=%3Cscript%3E'), empA).expect(400);
  });

  it("the row and the details per role: masked name in the list, the owner's money, never a pickup code", async () => {
    const code = await pickupCodeOf(o.pickupOld);
    const ownerList = await get(queue(s, s.branchA), s.owner).expect(200);
    const empList = await get(queue(s, s.branchA), empA).expect(200);
    const row = ownerList.body.items.find(
      (i: { id: string }) => i.id === o.pickupOld,
    );
    expect(row).toMatchObject({
      number: o.pickupOld.slice(0, 8),
      customer_short: 'سارة أ.',
      phone_last4: expect.stringMatching(/^\d{4}$/),
      item_count: 1,
      total: 100,
      amount_due: 100,
      fulfilment_method: 'PICKUP',
      payment_method: 'COD',
    });
    const eRow = empList.body.items.find(
      (i: { id: string }) => i.id === o.pickupOld,
    );
    expect(eRow.total).toBeUndefined();
    expect(eRow.amount_due).toBe(100);
    for (const body of [ownerList.body, empList.body]) {
      expect(JSON.stringify(body)).not.toContain('pickup_code');
      expect(JSON.stringify(body)).not.toContain(`"${code}"`);
    }

    const od = await get(
      queue(s, s.branchA, `/${o.pickupOld}`),
      s.owner,
    ).expect(200);
    const ed = await get(queue(s, s.branchA, `/${o.pickupOld}`), empA).expect(
      200,
    );
    expect(od.body).toMatchObject({
      id: o.pickupOld,
      status: 'PLACED',
      customer: { name: 'سارة أحمد', phone: expect.any(String) },
      payment: { method: 'COD', subtotal: 100, total: 100, amount_due: 100 },
      item_count: 1,
    });
    expect(od.body.items[0]).toMatchObject({
      title_ar: expect.any(String),
      quantity: 1,
      cancelled: false,
      unit_price: 100,
      line_total: 100,
    });
    expect(ed.body.payment).toEqual({
      method: 'COD',
      amount_due: 100,
      cod_collected_amount: null,
    });
    expect(ed.body.items[0].unit_price).toBeUndefined();
    expect(ed.body.cancellation_reason).toBeUndefined();
    expect(ed.body.not_received).toEqual({ open: false });
    for (const body of [od.body, ed.body]) {
      expect(JSON.stringify(body)).not.toContain('pickup_code');
      expect(JSON.stringify(body)).not.toContain(`"${code}"`);
      expect(JSON.stringify(body)).not.toMatch(/address/i);
    }
    // the next legal steps, exactly as the endpoints accept them
    expect(ed.body.actions).toEqual([
      { key: 'start_preparation', primary: true },
      { key: 'cancel', reason: 'optional' },
      { key: 'internal_note' },
    ]);
  });

  it('the slot and the window in the details; a late order says so', async () => {
    const d = await get(queue(s, s.branchA, `/${o.late}`), empA).expect(200);
    expect(d.body.fulfilment_method).toBe('DELIVERY');
    expect(d.body.scheduled_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(d.body.window).toEqual({
      day_of_week: expect.any(Number),
      start_minute: expect.any(Number),
      end_minute: expect.any(Number),
    });
    expect(d.body.is_late).toBe(true);
    const soon = await get(queue(s, s.branchA, `/${o.soon}`), empA).expect(200);
    expect(soon.body.is_late).toBe(false);
  });

  it('acting moves the order between tabs; the counts come from the server', async () => {
    await f.staff(s, empA, o.pickupOld, 'start-preparation').expect(201);
    const r = await get(queue(s, s.branchA), empA).expect(200);
    expect(r.body.counts).toMatchObject({ active: 5, new: 4, preparing: 1 });
    const prep = await get(queue(s, s.branchA, '?tab=preparing'), empA).expect(
      200,
    );
    expect(prep.body.items.map((i: { id: string }) => i.id)).toEqual([
      o.pickupOld,
    ]);
    const d = await get(queue(s, s.branchA, `/${o.pickupOld}`), empA).expect(
      200,
    );
    expect(d.body.actions).toEqual([
      { key: 'pickup_handover', primary: true },
      { key: 'cancel', reason: 'required' },
      { key: 'internal_note' },
    ]);
  });

  it('pickup code: checked by the server as before - a wrong one changes nothing, the right one completes', async () => {
    const wrong = await f
      .staff(s, empA, o.pickupOld, 'pickup-handover', { pickup_code: '000000' })
      .expect(409);
    expect(wrong.body.error.code).toBe('WRONG_PICKUP_CODE');
    expect(JSON.stringify(wrong.body)).not.toContain(
      await pickupCodeOf(o.pickupOld),
    );
    expect(
      (
        await prisma.branchOrder.findUniqueOrThrow({
          where: { id: o.pickupOld },
        })
      ).status,
    ).toBe('PREPARING');
    await f
      .staff(s, empA, o.pickupOld, 'pickup-handover', {
        pickup_code: await pickupCodeOf(o.pickupOld),
      })
      .expect(201);
    const done = await get(queue(s, s.branchA, '?tab=done'), empA).expect(200);
    expect(done.body.items.map((i: { id: string }) => i.id)).toEqual([
      o.pickupOld,
    ]);
    expect(done.body.sort).toBe('newest');
  });

  it('timeline: who acted with the role and branch AT THAT TIME, the customer, the system, older rows - newest first, nothing sensitive', async () => {
    const code = await pickupCodeOf(o.pickupOld);
    // the actor snapshot is stored with the event (no migration: afterState.actor_snapshot)
    const rows = await prisma.auditLog.findMany({
      where: {
        entityType: 'BranchOrder',
        entityId: o.pickupOld,
        action: 'branch_order.status_changed',
      },
      orderBy: { occurredAt: 'asc' },
    });
    expect(
      rows.map((r) => (r.afterState as { status: string }).status),
    ).toEqual(['PREPARING', 'PICKED_UP', 'COMPLETED']);
    for (const r of rows) {
      expect((r.afterState as Record<string, unknown>).actor_snapshot).toEqual({
        v: 1,
        user_id: empA.userId,
        role: 'BRANCH_EMPLOYEE',
        branch_id: s.branchA,
        display_name: 'هبة موظفة',
      });
    }

    // the employee is moved to branch B later - her past events keep branch A
    await prisma.vendorUser.updateMany({
      where: { userId: empA.userId, vendorId: s.vendorId },
      data: { branchId: s.branchB },
    });
    // an older event written before snapshots existed, by a staff member
    await prisma.auditLog.create({
      data: {
        actorId: empB.userId,
        correlationId: f.unique('old'),
        action: 'branch_order.internal_note_updated',
        entityType: 'BranchOrder',
        entityId: o.pickupOld,
        occurredAt: new Date(Date.now() - 1000),
      },
    });
    // an event by someone of another branch at that time (as data)
    await prisma.auditLog.create({
      data: {
        actorId: empB.userId,
        correlationId: f.unique('other'),
        action: 'branch_order.internal_note_updated',
        entityType: 'BranchOrder',
        entityId: o.pickupOld,
        occurredAt: new Date(Date.now() - 500),
        afterState: {
          actor_snapshot: {
            v: 1,
            user_id: empB.userId,
            role: 'BRANCH_EMPLOYEE',
            branch_id: s.branchB,
            display_name: 'دانة موظفة',
          },
        },
      },
    });
    // a system event and an unknown action (never shown)
    await prisma.auditLog.createMany({
      data: [
        {
          actorId: null,
          correlationId: f.unique('sys'),
          action: 'branch_order.status_changed',
          entityType: 'BranchOrder',
          entityId: o.pickupOld,
          occurredAt: new Date(Date.now() - 400),
          beforeState: { status: 'PICKED_UP' },
          afterState: { status: 'COMPLETED' },
        },
        {
          actorId: null,
          correlationId: f.unique('x'),
          action: 'something.secret',
          entityType: 'BranchOrder',
          entityId: o.pickupOld,
          afterState: { phone: '+970599999999' },
        },
      ],
    });

    const owner = await get(
      queue(s, s.branchA, `/${o.pickupOld}/timeline`),
      s.owner,
    ).expect(200);
    const emp = await get(
      queue(s, s.branchA, `/${o.pickupOld}/timeline`),
      empA2,
    ).expect(200);
    const at = owner.body.items.map((i: { at: string }) => i.at);
    expect([...at].sort().reverse()).toEqual(at); // newest first

    const ownerKinds = owner.body.items.map((i: { kind: string }) => i.kind);
    expect(ownerKinds).not.toContain(undefined);
    expect(ownerKinds).toContain('created');
    const created = owner.body.items.find(
      (i: { kind: string }) => i.kind === 'created',
    );
    expect(created.actor).toEqual({ kind: 'customer' });
    const start = owner.body.items.find(
      (i: { to_status: string }) => i.to_status === 'PREPARING',
    );
    expect(start).toMatchObject({
      kind: 'status',
      from_status: 'PLACED',
      to_status: 'PREPARING',
    });
    // the owner: her name, her branch at that time (A), not today's (B)
    expect(start.actor).toEqual({
      kind: 'employee',
      name: 'هبة موظفة',
      branch_name: expect.any(String),
      other_branch: false,
    });
    const branchA = await prisma.storeBranch.findUniqueOrThrow({
      where: { id: s.branchA },
    });
    expect(start.actor.branch_name).toBe(branchA.name);
    const actors = owner.body.items.map(
      (i: { actor: { kind: string } }) => i.actor.kind,
    );
    expect(actors).toEqual(
      expect.arrayContaining(['system', 'unrecorded', 'employee', 'customer']),
    );
    const unrecorded = owner.body.items.find(
      (i: { actor: { kind: string } }) => i.actor.kind === 'unrecorded',
    );
    expect(unrecorded.actor).toEqual({
      kind: 'unrecorded',
      name: 'دانة موظفة',
    });

    // the employee of branch A: the same events, but no name of another
    // branch's person and no name of an unrecorded actor
    const eStart = emp.body.items.find(
      (i: { to_status: string }) => i.to_status === 'PREPARING',
    );
    expect(eStart.actor).toEqual({ kind: 'employee', name: 'هبة موظفة' });
    const eKinds = emp.body.items.map(
      (i: { actor: { kind: string } }) => i.actor.kind,
    );
    expect(eKinds).toContain('employee_other_branch');
    const eUnrecorded = emp.body.items.find(
      (i: { actor: { kind: string } }) => i.actor.kind === 'unrecorded',
    );
    expect(eUnrecorded.actor).toEqual({ kind: 'unrecorded' });
    expect(JSON.stringify(emp.body)).not.toContain('دانة');

    for (const body of [owner.body, emp.body]) {
      const text = JSON.stringify(body);
      expect(text).not.toContain(code);
      expect(text).not.toContain('+970');
      expect(text).not.toContain('something.secret');
      expect(text).not.toContain('actor_snapshot');
      expect(text).not.toContain('user_id');
    }
  });

  it('timeline: the owner sees the cancellation reason on the closing step; an employee never; the self-fulfilment note is owner-only', async () => {
    await f.staff(s, empA2, o.later, 'start-preparation').expect(201);
    await f
      .staff(s, s.owner, o.later, 'cancel', {
        reason: 'العميلة طلبت الإلغاء هاتفياً',
      })
      .expect(201);
    const owner = await get(
      queue(s, s.branchA, `/${o.later}/timeline`),
      s.owner,
    ).expect(200);
    const closing = owner.body.items.find(
      (i: { to_status: string }) => i.to_status === 'CANCELLED',
    );
    expect(closing.reason).toBe('العميلة طلبت الإلغاء هاتفياً');
    expect(closing.actor).toEqual({ kind: 'owner', name: 'ريم المالكة' });
    const emp = await get(
      queue(s, s.branchA, `/${o.later}/timeline`),
      empA2,
    ).expect(200);
    expect(JSON.stringify(emp.body)).not.toContain('هاتفياً');
    const ed = await get(queue(s, s.branchA, `/${o.later}`), empA2).expect(200);
    expect(ed.body.cancellation_reason).toBeUndefined();
    expect(ed.body.actions).toEqual([{ key: 'internal_note' }]);
    // a fully cancelled order still counts the pieces it had (never «0»)
    expect(ed.body.item_count).toBe(1);
    expect(
      ed.body.items.every((i: { cancelled: boolean }) => i.cancelled),
    ).toBe(true);
    const done = await get(queue(s, s.branchA, '?tab=done'), empA2).expect(200);
    expect(
      done.body.items.find((i: { id: string }) => i.id === o.later).item_count,
    ).toBe(1);
  });

  it('the pickup code never reaches the store - old and new endpoints, owner and employee; only the shopper who ordered sees it; the hand-over still checks it', async () => {
    const buyer = await shopper('ريم المتسوقة');
    const other = await shopper('متسوقة أخرى');
    const id = (await f.buy(buyer, s, variant)).branchOrderId;
    const code = await pickupCodeOf(id);
    // every store read of the order: the new queue + details + timeline,
    // the old branch list, the old store-wide list - owner and employee
    const storeReads = [
      [queue(s, s.branchA), s.owner],
      [queue(s, s.branchA), empA2],
      [queue(s, s.branchA, `/${id}`), s.owner],
      [queue(s, s.branchA, `/${id}`), empA2],
      [queue(s, s.branchA, `/${id}/timeline`), s.owner],
      [`/api/v1/vendors/${s.vendorId}/branches/${s.branchA}/orders`, s.owner],
      [`/api/v1/vendors/${s.vendorId}/branches/${s.branchA}/orders`, empA2],
      [`/api/v1/vendors/${s.vendorId}/orders`, s.owner],
    ] as const;
    for (const [url, who] of storeReads) {
      const r = await get(url, who).expect(200);
      const text = JSON.stringify(r.body);
      // the order is there (a timeline lists its events, not its id)...
      if (!url.endsWith('/timeline')) expect(text).toContain(id);
      else expect(r.body.items.length).toBeGreaterThan(0);
      expect(text).not.toContain('pickup_code'); // ...without the field
      expect(text).not.toContain(`"${code}"`); // ...and without the value
    }
    // the shopper who ordered: her own orders keep it
    const mine = await get('/api/v1/customers/me/orders', buyer).expect(200);
    expect(mine.body.find((x: { id: string }) => x.id === id).pickup_code).toBe(
      code,
    );
    // anyone else's own list never has it
    for (const who of [other, s.owner, empA2]) {
      const theirs = await get('/api/v1/customers/me/orders', who).expect(200);
      expect(JSON.stringify(theirs.body)).not.toContain(`"${code}"`);
    }
    // the hand-over: a wrong code is refused without echoing either code,
    // the right one completes
    const wrong = code === '111111' ? '222222' : '111111';
    const refused = await f
      .staff(s, empA2, id, 'start-preparation')
      .expect(201)
      .then(() =>
        f.staff(s, empA2, id, 'pickup-handover', { pickup_code: wrong }),
      );
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('WRONG_PICKUP_CODE');
    expect(JSON.stringify(refused.body)).not.toContain(code);
    expect(JSON.stringify(refused.body)).not.toContain(wrong);
    await f
      .staff(s, empA2, id, 'pickup-handover', { pickup_code: code })
      .expect(201);
    expect(
      (await prisma.branchOrder.findUniqueOrThrow({ where: { id } })).status,
    ).toBe('COMPLETED');
  });

  it('a delivery order changed to pickup by its shopper: the new code goes to her only - never into the audit log or the store', async () => {
    const buyer = await shopper('سمر');
    const id = (await f.buy(buyer, s, variant)).branchOrderId;
    // +6 days: a weekday no other window of this branch uses (windows may not overlap)
    await asDelivery(s, id, new Date(Date.now() + 6 * 86400_000));
    const res = await f
      .http()
      .post(
        `/api/v1/customers/me/orders/${id}/change-address/convert-to-pickup`,
      )
      .set(f.bearer(buyer.token))
      .set('Idempotency-Key', f.unique('convert'))
      .send({})
      .expect(201);
    const code = res.body.pickup_code as string;
    expect(code).toMatch(/^\d{6}$/);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: id, action: 'branch_order.converted_to_pickup' },
    });
    expect(JSON.stringify(audit.afterState)).not.toContain(code);
    expect(audit.afterState).toEqual({ pickup_code_issued: true });
    for (const who of [s.owner, empA2]) {
      const d = await get(queue(s, s.branchA, `/${id}`), who).expect(200);
      expect(d.body.fulfilment_method).toBe('PICKUP');
      expect(JSON.stringify(d.body)).not.toContain(code);
      const t = await get(queue(s, s.branchA, `/${id}/timeline`), who).expect(
        200,
      );
      expect(t.body.items.map((i: { kind: string }) => i.kind)).toContain(
        'converted_to_pickup',
      );
      expect(JSON.stringify(t.body)).not.toContain(code);
    }
  });

  it('own order: the employee who bought it cannot be offered a cancel', async () => {
    const buyer = await employee(s, s.branchA, 'سلمى موظفة');
    const own = (await f.buy(buyer, s, variant)).branchOrderId;
    const d = await get(queue(s, s.branchA, `/${own}`), buyer).expect(200);
    expect(d.body.is_own_order).toBe(true);
    expect(d.body.actions).toEqual([
      { key: 'start_preparation', primary: true },
      { key: 'internal_note' },
    ]);
  });

  it('the queue keeps the existing delivered-order reconciliation; the system step is never written as the reader', async () => {
    const id = (await f.buy(await shopper('رنا'), s, variant)).branchOrderId;
    await prisma.branchOrder.update({
      where: { id },
      data: {
        fulfilmentMethod: 'DELIVERY',
        pickupCode: null,
        status: 'DELIVERED',
        deliveredAt: new Date(Date.now() - 80 * 3600_000),
      },
    });
    await get(queue(s, s.branchA), empA2).expect(200);
    const after = await prisma.branchOrder.findUniqueOrThrow({ where: { id } });
    expect(after.status).toBe('COMPLETED');
    const completion = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: id, action: 'branch_order.status_changed' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(completion.actorId).toBeNull();
    expect(
      (completion.afterState as Record<string, unknown>).actor_snapshot,
    ).toBeUndefined();
  });
});
