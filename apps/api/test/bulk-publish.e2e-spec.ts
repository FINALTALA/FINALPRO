import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as ExcelJS from 'exceljs';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { BulkPublishService } from './../src/offer-drafts/bulk-publish.service';
import { OfferDraftsService } from './../src/offer-drafts/offer-drafts.service';
import { OutboxRelayService } from './../src/outbox/outbox-relay.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { tb26Fixtures } from './helpers/tb26-fixtures';
import { makeZip } from './helpers/zip-writer';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp = require('sharp') as typeof import('sharp/dist/index.cjs');

// Bulk publishing of an import's drafts (2026-11-18, phase B): a read-only
// preflight with the publish gate itself; a run over only what the owner
// confirmed, each product whole or not at all, a draft changed since the
// preflight not published; one run at a time per store; retrying never
// publishes twice; ONE summary notification to the followers.
describe('Bulk publish (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const f = tb26Fixtures(() => app);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
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

  const auth = (token: string) => f.bearer(token);
  type Store = Awaited<ReturnType<typeof f.store>>;

  /** Imports complete drafts (one colour, a main image each) and returns their ids by title. */
  async function importDrafts(s: Store, titles: string[]) {
    const branches = await prisma.storeBranch.findMany({
      where: { vendorId: s.vendorId },
      orderBy: { createdAt: 'asc' },
      select: { name: true },
    });
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('المنتجات').addRows([
      [
        'رقم المنتج في الملف',
        'الاسم بالعربية',
        'الجمهور',
        'الفئة',
        'العلامة التجارية',
        'السعر',
        'نظام المقاسات',
      ],
      ...titles.map((t, i) => [
        i + 1,
        t,
        'نساء',
        'فساتين',
        'بدون علامة تجارية',
        100 + i,
        'حروف',
      ]),
    ]);
    wb.addWorksheet('الألوان والمقاسات').addRows([
      [
        'رقم المنتج في الملف',
        'اسم اللون بالعربية',
        'عائلة اللون',
        'المقاس',
        `الكمية: ${branches[0].name}`,
      ],
      ...titles.map((_, i) => [i + 1, 'أحمر', 'أحمر', 'M', 3]),
    ]);
    wb.addWorksheet('الصور').addRows([
      [
        'رقم المنتج في الملف',
        'اسم اللون بالعربية',
        'اسم ملف الصورة',
        'نوع الصورة',
      ],
      ...titles.map((_, i) => [i + 1, 'أحمر', `p${i + 1}.jpg`, 'رئيسية']),
    ]);
    const images = await Promise.all(
      titles.map(async (_, i) => ({
        name: `p${i + 1}.jpg`,
        data: await sharp({
          create: {
            width: 30,
            height: 40,
            channels: 3,
            background: { r: 20 * i, g: 90, b: 140 },
          },
        })
          .jpeg()
          .toBuffer(),
      })),
    );
    const checked = await f
      .http()
      .post(`/api/v1/vendors/${s.vendorId}/product-import/check`)
      .set(auth(s.owner.token))
      .attach('file', Buffer.from(await wb.xlsx.writeBuffer()), 'p.xlsx')
      .attach('images', makeZip(images), 'p.zip')
      .expect(200);
    const confirmed = await f
      .http()
      .post(
        `/api/v1/vendors/${s.vendorId}/product-import/${checked.body.batch_id}/confirm`,
      )
      .set(auth(s.owner.token))
      .send({
        refs: titles.map((_, i) => String(i + 1)),
        expected_sha256: checked.body.file_sha256,
      })
      .expect(201);
    const ids = Object.fromEntries(
      confirmed.body.created.map((c: { title: string; draft_id: string }) => [
        c.title,
        c.draft_id,
      ]),
    ) as Record<string, string>;
    return { batchId: checked.body.batch_id as string, ids };
  }

  const draftsUrl = (v: string) => `/api/v1/vendors/${v}/offer-drafts`;
  const bulkUrl = (v: string) => `/api/v1/vendors/${v}/bulk-publish`;
  /** Changes a draft (a new revision), optionally its payload. */
  async function edit(
    s: Store,
    id: string,
    change: (p: Record<string, unknown>) => void = () => undefined,
  ) {
    const d = await f
      .http()
      .get(`${draftsUrl(s.vendorId)}/${id}`)
      .set(auth(s.owner.token))
      .expect(200);
    const payload = { ...d.body.payload };
    change(payload);
    await f
      .http()
      .patch(`${draftsUrl(s.vendorId)}/${id}`)
      .set(auth(s.owner.token))
      .send({ expected_revision: d.body.revision, payload })
      .expect(200);
  }
  const preflight = (s: Store, ids: string[]) =>
    f
      .http()
      .post(`${bulkUrl(s.vendorId)}/preflight`)
      .set(auth(s.owner.token))
      .send({ draft_ids: ids })
      .expect(200);
  async function waitDone(s: Store, runId: string) {
    for (let i = 0; i < 150; i += 1) {
      const r = await f
        .http()
        .get(`${bulkUrl(s.vendorId)}/${runId}`)
        .set(auth(s.owner.token))
        .expect(200);
      if (r.body.status === 'DONE') return r.body;
      await new Promise((ok) => setTimeout(ok, 200));
    }
    throw new Error('the run did not finish');
  }
  const offers = (vendorId: string) =>
    prisma.vendorOffer.count({ where: { vendorId } });

  it('the preflight is read-only and is the publish gate itself: ready, or why not (and an already published draft is said)', async () => {
    const s = await f.store();
    const { ids } = await importDrafts(s, ['فستان أ', 'فستان ب', 'فستان ج']);
    // «فستان ب» loses its stock: the gate refuses it
    await edit(s, ids['فستان ب'], (p) => {
      p.stock = {};
    });
    const before = {
      offers: await offers(s.vendorId),
      runs: await prisma.bulkPublishRun.count({
        where: { vendorId: s.vendorId },
      }),
    };
    const r = await preflight(s, Object.values(ids));
    expect(r.body).toMatchObject({ ready: 2, not_ready: 1 });
    const by = (title: string) =>
      r.body.items.find((x: { title: string }) => x.title === title);
    expect(by('فستان أ')).toMatchObject({
      ready: true,
      state: 'OPEN',
      problems: [],
    });
    expect(by('فستان ب')).toMatchObject({ ready: false, state: 'OPEN' });
    expect(by('فستان ب').problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'STOCK_REQUIRED' }),
      ]),
    );
    expect(await offers(s.vendorId)).toBe(before.offers);
    expect(
      await prisma.bulkPublishRun.count({ where: { vendorId: s.vendorId } }),
    ).toBe(before.runs);
    // another store's draft, an employee: refused
    const other = await f.store();
    await f
      .http()
      .post(`${bulkUrl(other.vendorId)}/preflight`)
      .set(auth(other.owner.token))
      .send({ draft_ids: [ids['فستان أ']] })
      .expect(200)
      .expect((x) => expect(x.body.items[0].state).toBe('NOT_FOUND'));
    const branch = await prisma.storeBranch.findFirstOrThrow({
      where: { vendorId: s.vendorId },
    });
    const employee = await f.member(
      s.vendorId,
      await f.account(),
      'BRANCH_EMPLOYEE',
      branch.id,
    );
    await f
      .http()
      .post(`${bulkUrl(s.vendorId)}/preflight`)
      .set(auth(employee.token))
      .send({ draft_ids: [ids['فستان أ']] })
      .expect(403);
  });

  it('a mixed run: the ready one is published (whole), the refused one and one changed after the preflight are not, with their reasons; followers get ONE summary; audited', async () => {
    const s = await f.store();
    const follower = await f.account();
    await prisma.storeFollow.create({
      data: { userId: follower.userId, vendorId: s.vendorId },
    });
    const { ids, batchId } = await importDrafts(s, ['أ', 'ب', 'ج', 'د']);
    await edit(s, ids['ب'], (p) => {
      p.stock = {};
    });
    const pre = await preflight(s, Object.values(ids));
    const rev = (id: string) =>
      pre.body.items.find((x: { draft_id: string }) => x.draft_id === id)
        .revision as number;
    // «ج» changes after the preflight: the owner never saw this version
    await edit(s, ids['ج'], (p) => {
      p.price = 999;
    });
    const started = await f
      .http()
      .post(bulkUrl(s.vendorId))
      .set(auth(s.owner.token))
      .send({
        import_batch_id: batchId,
        items: ['أ', 'ب', 'ج', 'د'].map((t) => ({
          draft_id: ids[t],
          expected_revision: rev(ids[t]),
        })),
      })
      .expect(201);
    const run = await waitDone(s, started.body.id);
    const item = (t: string) =>
      run.items.find((x: { draft_id: string }) => x.draft_id === ids[t]);
    expect(run.counts).toEqual({
      pending: 0,
      published: 2,
      refused: 2,
      already: 0,
    });
    expect(item('أ')).toMatchObject({ state: 'PUBLISHED' });
    expect(item('د')).toMatchObject({ state: 'PUBLISHED' });
    expect(item('ب').state).toBe('REFUSED');
    expect(item('ب').problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'STOCK_REQUIRED' }),
      ]),
    );
    expect(item('ج')).toMatchObject({
      state: 'REFUSED',
      problems: [{ code: 'CHANGED' }],
    });
    // whole products only: published = ACTIVE, nothing half-made for the others
    const made = await prisma.vendorOffer.findMany({
      where: { vendorId: s.vendorId },
      select: { id: true, status: true },
    });
    expect(made.map((o) => o.status).sort()).toEqual(['ACTIVE', 'ACTIVE']);
    expect(new Set(made.map((o) => o.id))).toEqual(
      new Set([item('أ').offer_id, item('د').offer_id]),
    );
    for (const t of ['ب', 'ج'])
      expect(
        (await prisma.offerDraft.findUniqueOrThrow({ where: { id: ids[t] } }))
          .status,
      ).toBe('OPEN');
    // ONE summary to the followers, no per-product notice
    const events = await prisma.outboxEvent.findMany({
      where: {
        eventType: {
          in: [
            'offer.published_for_followers',
            'offer.bulk_published_for_followers',
          ],
        },
        payload: { path: ['vendor_id'], equals: s.vendorId },
      },
    });
    expect(events.map((e) => e.eventType)).toEqual([
      'offer.bulk_published_for_followers',
    ]);
    expect(events[0].payload).toMatchObject({ count: 2, run_id: run.id });
    for (const action of ['bulk_publish.started', 'bulk_publish.finished'])
      expect(
        await prisma.auditLog.count({ where: { action, entityId: run.id } }),
      ).toBe(1);
    // the batch's screen shows the published ones as published
    const batch = await f
      .http()
      .get(`/api/v1/vendors/${s.vendorId}/product-import/${batchId}`)
      .set(auth(s.owner.token))
      .expect(200);
    expect(batch.body.counts).toEqual({ open: 2, published: 2, closed: 0 });
  });

  it('one run at a time per store (another tab is told which run is running); retrying publishes only what was not published - never twice', async () => {
    const s = await f.store();
    const { ids } = await importDrafts(s, ['س', 'ص']);
    // a run already running (another tab)
    const running = await prisma.bulkPublishRun.create({
      data: {
        vendorId: s.vendorId,
        actorId: s.owner.userId,
        correlationId: 'other-tab',
        total: 0,
      },
    });
    const pre = await preflight(s, [ids['س']]);
    await f
      .http()
      .post(bulkUrl(s.vendorId))
      .set(auth(s.owner.token))
      .send({
        items: [
          { draft_id: ids['س'], expected_revision: pre.body.items[0].revision },
        ],
      })
      .expect(409)
      .expect((x) => {
        expect(x.body.error.code).toBe('BULK_PUBLISH_RUNNING');
        expect(x.body.error.details[0].run_id).toBe(running.id);
      });
    const current = await f
      .http()
      .get(`${bulkUrl(s.vendorId)}/current`)
      .set(auth(s.owner.token))
      .expect(200);
    expect(current.body.run.id).toBe(running.id);
    await prisma.bulkPublishRun.update({
      where: { id: running.id },
      data: { status: 'DONE' },
    });

    // first run: «س» only
    const first = await f
      .http()
      .post(bulkUrl(s.vendorId))
      .set(auth(s.owner.token))
      .send({
        items: [
          { draft_id: ids['س'], expected_revision: pre.body.items[0].revision },
        ],
      })
      .expect(201);
    await waitDone(s, first.body.id);
    // retry over both: «س» is already published (said, not published again), «ص» is published
    const again = await preflight(s, [ids['س'], ids['ص']]);
    expect(again.body.items[0]).toMatchObject({
      ready: false,
      state: 'PUBLISHED',
    });
    const second = await f
      .http()
      .post(bulkUrl(s.vendorId))
      .set(auth(s.owner.token))
      .send({
        items: again.body.items.map(
          (x: { draft_id: string; revision: number }) => ({
            draft_id: x.draft_id,
            expected_revision: x.revision,
          }),
        ),
      })
      .expect(201);
    const done = await waitDone(s, second.body.id);
    expect(done.counts).toMatchObject({ published: 1, already: 1 });
    expect(await offers(s.vendorId)).toBe(2);
    // another store cannot start a run over these drafts
    const other = await f.store();
    await f
      .http()
      .post(bulkUrl(other.vendorId))
      .set(auth(other.owner.token))
      .send({ items: [{ draft_id: ids['ص'], expected_revision: 1 }] })
      .expect(404);
  });
  /** Drives the outbox relay until this event is fully sent (its follower fan-out included). */
  async function deliver(eventId: string) {
    const relay = app.get(OutboxRelayService);
    for (let i = 0; i < 3000; i += 1) {
      const e = await prisma.outboxEvent.findUniqueOrThrow({
        where: { id: eventId },
      });
      if (e.status === 'PUBLISHED') return;
      if (e.status === 'DEAD_LETTER')
        throw new Error(`event ${eventId} dead-lettered`);
      if (!(await relay.dispatchOnce()))
        await new Promise((ok) => setTimeout(ok, 100));
    }
    throw new Error(`event ${eventId} was not delivered`);
  }
  const summaryEvents = (vendorId: string) =>
    prisma.outboxEvent.findMany({
      where: {
        eventType: 'offer.bulk_published_for_followers',
        payload: { path: ['vendor_id'], equals: vendorId },
      },
    });

  it("the followers' summary becomes ONE notification per follower (customer bell, the count, the store) - never one per product", async () => {
    const s = await f.store();
    const follower = await f.account();
    const other = await f.account();
    for (const u of [follower, other])
      await prisma.storeFollow.create({
        data: { userId: u.userId, vendorId: s.vendorId },
      });
    const { ids } = await importDrafts(s, ['ث 1', 'ث 2', 'ث 3']);
    const pre = await preflight(s, Object.values(ids));
    const started = await f
      .http()
      .post(bulkUrl(s.vendorId))
      .set(auth(s.owner.token))
      .send({
        items: pre.body.items.map(
          (x: { draft_id: string; revision: number }) => ({
            draft_id: x.draft_id,
            expected_revision: x.revision,
          }),
        ),
      })
      .expect(201);
    await waitDone(s, started.body.id);
    const [event] = await summaryEvents(s.vendorId);
    await deliver(event.id);
    for (const u of [follower, other]) {
      const got = await prisma.notification.findMany({
        where: { recipientUserId: u.userId, vendorId: s.vendorId },
      });
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({
        type: 'FOLLOWED_STORE_NEW_PRODUCTS',
        targetType: 'VENDOR',
        targetId: s.vendorId,
        audience: 'CUSTOMER',
        data: { count: 3 },
      });
    }
    expect(
      await prisma.notification.count({
        where: { vendorId: s.vendorId, type: 'FOLLOWED_STORE_NEW_PRODUCT' },
      }),
    ).toBe(0);
    // it is in the follower's shopping bell
    const bell = await f
      .http()
      .get('/api/v1/me/notifications')
      .set(auth(follower.token))
      .expect(200);
    expect(JSON.stringify(bell.body)).toContain('FOLLOWED_STORE_NEW_PRODUCTS');
  });

  it('resuming after an interruption: a product the run published before the server stopped (its result not yet recorded) is recorded as PUBLISHED - counted, in the summary, never published again; one published elsewhere stays «already»', async () => {
    const s = await f.store();
    const { ids, batchId } = await importDrafts(s, ['ع 1', 'ع 2', 'ع 3']);
    const pre = await preflight(s, [ids['ع 1'], ids['ع 2'], ids['ع 3']]);
    const rev = (id: string) =>
      pre.body.items.find((x: { draft_id: string }) => x.draft_id === id)
        .revision as number;
    // the run as the server left it: RUNNING, every item still waiting
    const run = await prisma.bulkPublishRun.create({
      data: {
        vendorId: s.vendorId,
        actorId: s.owner.userId,
        importBatchId: batchId,
        correlationId: `interrupted-${Date.now()}`,
        total: 3,
        items: {
          create: ['ع 1', 'ع 2', 'ع 3'].map((t, i) => ({
            draftId: ids[t],
            position: i,
            expectedRevision: rev(ids[t]),
          })),
        },
      },
    });
    const drafts = app.get(OfferDraftsService);
    // «ع 1»: published BY THE RUN, then the server stopped before recording it
    const byRun = await drafts.publish(
      s.vendorId,
      ids['ع 1'],
      rev(ids['ع 1']),
      s.owner.userId,
      run.correlationId,
      { notifyFollowers: false },
    );
    // «ع 3»: published elsewhere meanwhile (another tab)
    const elsewhere = await drafts.publish(
      s.vendorId,
      ids['ع 3'],
      rev(ids['ع 3']),
      s.owner.userId,
      `other-tab-${Date.now()}`,
    );
    expect(await offers(s.vendorId)).toBe(2);

    await app.get(BulkPublishService).resumeAll();
    const done = await waitDone(s, run.id);
    const item = (t: string) =>
      done.items.find((x: { draft_id: string }) => x.draft_id === ids[t]);
    expect(done.counts).toEqual({
      pending: 0,
      published: 2,
      refused: 0,
      already: 1,
    });
    expect(item('ع 1')).toMatchObject({
      state: 'PUBLISHED',
      recovered: true,
      offer_id: byRun.offer_id,
      problems: [],
    });
    expect(item('ع 2')).toMatchObject({ state: 'PUBLISHED', recovered: false });
    expect(item('ع 3')).toMatchObject({
      state: 'ALREADY',
      offer_id: elsewhere.offer_id,
    });
    // idempotent: three products, never a second one for «ع 1»
    expect(await offers(s.vendorId)).toBe(3);
    const [summary] = await summaryEvents(s.vendorId);
    expect(summary.payload).toMatchObject({ count: 2, run_id: run.id });
    expect(
      (summary.payload as { offer_ids: string[] }).offer_ids.sort(),
    ).toEqual([byRun.offer_id, item('ع 2').offer_id].sort());
    const finished = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'bulk_publish.finished', entityId: run.id },
    });
    expect(JSON.stringify(finished.afterState)).toContain(byRun.offer_id);
    // resuming again changes nothing
    await app.get(BulkPublishService).process(run.id);
    expect(await offers(s.vendorId)).toBe(3);
    expect(await summaryEvents(s.vendorId)).toHaveLength(1);
  });

  it("an import batch sees only ITS running run: another batch's run is not shown as this batch's, and starting here is refused naming the other batch", async () => {
    const s = await f.store();
    const first = await importDrafts(s, ['دفعة أولى']);
    const second = await importDrafts(s, ['دفعة ثانية']);
    const running = await prisma.bulkPublishRun.create({
      data: {
        vendorId: s.vendorId,
        actorId: s.owner.userId,
        importBatchId: first.batchId,
        correlationId: `first-batch-${Date.now()}`,
        total: 0,
      },
    });
    const current = (batchId?: string) =>
      f
        .http()
        .get(
          `${bulkUrl(s.vendorId)}/current${batchId ? `?import_batch_id=${batchId}` : ''}`,
        )
        .set(auth(s.owner.token))
        .expect(200);
    expect((await current(second.batchId)).body.run).toBeNull();
    expect((await current(first.batchId)).body.run.id).toBe(running.id);
    expect((await current()).body.run.id).toBe(running.id);
    const pre = await preflight(s, [second.ids['دفعة ثانية']]);
    await f
      .http()
      .post(bulkUrl(s.vendorId))
      .set(auth(s.owner.token))
      .send({
        import_batch_id: second.batchId,
        items: [
          {
            draft_id: second.ids['دفعة ثانية'],
            expected_revision: pre.body.items[0].revision,
          },
        ],
      })
      .expect(409)
      .expect((x) =>
        expect(x.body.error.details[0]).toEqual({
          run_id: running.id,
          import_batch_id: first.batchId,
        }),
      );
    await prisma.bulkPublishRun.update({
      where: { id: running.id },
      data: { status: 'DONE' },
    });
  });
});
