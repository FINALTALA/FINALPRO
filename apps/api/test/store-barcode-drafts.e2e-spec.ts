import { mkdtempSync } from 'fs';
import { rm } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { OutboxRelayService } from './../src/outbox/outbox-relay.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { tb26Fixtures } from './helpers/tb26-fixtures';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp = require('sharp') as typeof import('sharp/dist/index.cjs');

const UPLOADS_ROOT = mkdtempSync(
  path.join(os.tmpdir(), 'store-barcode-uploads-'),
);
process.env.UPLOADS_DIR = UPLOADS_ROOT;

// «باركود المنتج للمحل» in the wizard (2026-11-20): optional on the review
// step - a code already on the item, one generated at publish, or «later».
// Never a condition to save or publish; a wrong or already-used code is a
// named problem on the review step, kept in the draft as typed (never
// dropped); at publish the code joins the new product in the same
// transaction.
describe('Store barcode chosen in the product wizard (e2e)', () => {
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
    // one real listener for the whole file: supertest otherwise opens and closes a temporary
    // one per request, and requests sent in parallel then race on it (ECONNRESET)
    await app.listen(0);
    prisma = app.get(PrismaService);
    app.get(OutboxRelayService).onModuleDestroy();
    await setFlag(true);
  });
  afterAll(async () => {
    await setFlag(false);
    await app.close();
    await rm(UPLOADS_ROOT, { recursive: true, force: true });
  });

  type Store = Awaited<ReturnType<typeof f.store>>;
  const base = (s: Store) => `/api/v1/vendors/${s.vendorId}/offer-drafts`;
  const as = (s: Store) => f.bearer(s.owner.token);
  async function upload(s: Store) {
    const jpeg = await sharp({
      create: {
        width: 30,
        height: 40,
        channels: 3,
        background: { r: 80, g: 90, b: 140 },
      },
    })
      .jpeg()
      .toBuffer();
    const r = await f
      .http()
      .post(`/api/v1/vendors/${s.vendorId}/uploads`)
      .set(as(s))
      .attach('file', jpeg, 'a.jpg')
      .expect(201);
    return r.body.url as string;
  }
  async function ready(s: Store, extra: object = {}) {
    return {
      layout: 5,
      step: 5,
      audience: 'WOMEN',
      category: 'DRESSES_WOMEN',
      title_ar: `فستان ${f.unique('b').slice(-6)}`,
      brand: { mode: 'none' },
      colors: [
        {
          key: 'BEIGE',
          family: 'BEIGE',
          name_ar: 'بيج',
          images: [await upload(s)],
        },
      ],
      size_system: 'LETTER',
      sizes: { BEIGE: ['S', 'M'] },
      price: 140,
      stock: { [s.branchA]: { 'BEIGE|S': 2, 'BEIGE|M': 1 } },
      ...extra,
    };
  }
  const create = async (s: Store, payload: object) =>
    (await f.http().post(base(s)).set(as(s)).send({ payload }).expect(201))
      .body;
  const check = async (s: Store, id: string) =>
    (
      await f
        .http()
        .get(`${base(s)}/${id}/publish-check`)
        .set(as(s))
        .expect(200)
    ).body;
  async function publish(s: Store, id: string, status: number) {
    const d = await prisma.offerDraft.findUniqueOrThrow({ where: { id } });
    return f
      .http()
      .post(`${base(s)}/${id}/publish`)
      .set(as(s))
      .send({ expected_revision: d.revision })
      .expect(status);
  }
  const codesOf = (offerId: string) =>
    prisma.offerBarcode.findMany({
      where: { vendorOfferId: offerId },
      orderBy: { createdAt: 'asc' },
    });

  async function setFlag(enabled: boolean) {
    await prisma.featureFlag.upsert({
      where: { key: 'store_cashier_enabled' },
      create: { key: 'store_cashier_enabled', enabled, description: 'test' },
      update: { enabled },
    });
  }
  const reserve = async (s: Store) =>
    (
      await f
        .http()
        .post(`/api/v1/vendors/${s.vendorId}/barcodes/reserve`)
        .set(as(s))
        .expect(201)
    ).body as { code: string; format: string };

  it('saves a draft without a code, but publishes a new product only with one («أضيفي باركوداً للمنتج قبل النشر»)', async () => {
    const s = await f.store();
    for (const extra of [
      {},
      { store_barcode: null },
      // an older draft's «later», and an empty typed code: still missing
      { store_barcode: { mode: 'later' } },
      { store_barcode: { mode: 'external', code: '' } },
    ]) {
      const d = await create(s, await ready(s, extra));
      const c = await check(s, d.id);
      expect(c.ready).toBe(false);
      expect(c.problems).toEqual([
        { code: 'STORE_BARCODE:BARCODE_MISSING', step: 5 },
      ]);
      const refused = await publish(s, d.id, 409);
      expect(refused.body.error.code).toBe('DRAFT_NOT_PUBLISHABLE');
      expect(refused.body.error.details).toEqual([
        { code: 'STORE_BARCODE:BARCODE_MISSING', step: 5 },
      ]);
      const still = await prisma.offerDraft.findUniqueOrThrow({
        where: { id: d.id },
      });
      expect([still.status, still.offerId]).toEqual(['OPEN', null]);
    }
    // the store's barcodes switched off: the wizard has no barcode section, nothing is required
    await setFlag(false);
    try {
      const d = await create(s, await ready(s));
      expect((await check(s, d.id)).ready).toBe(true);
      await publish(s, d.id, 201);
    } finally {
      await setFlag(true);
    }
  });

  it('keeps a wrong code as typed, names the problem on the review step, and refuses to publish until it is fixed', async () => {
    const s = await f.store();
    const d = await create(
      s,
      await ready(s, {
        store_barcode: { mode: 'external', code: ' 4006381333932 ' },
      }),
    );
    expect(d.payload.store_barcode).toEqual({
      mode: 'external',
      code: '4006381333932',
    });
    const c = await check(s, d.id);
    expect(c.ready).toBe(false);
    expect(c.problems).toEqual([
      { code: 'STORE_BARCODE:BARCODE_CHECK_DIGIT', step: 5 },
    ]);
    const refused = await publish(s, d.id, 409);
    expect(refused.body.error.code).toBe('DRAFT_NOT_PUBLISHABLE');
    const still = await prisma.offerDraft.findUniqueOrThrow({
      where: { id: d.id },
    });
    expect((still.payload as { store_barcode: unknown }).store_barcode).toEqual(
      { mode: 'external', code: '4006381333932' },
    );
    expect(still.status).toBe('OPEN');

    // a code another product of the store already carries: named with that product
    const other = await create(
      s,
      await ready(s, {
        store_barcode: { mode: 'external', code: '4006381333931' },
      }),
    );
    const otherId = (await publish(s, other.id, 201)).body.offer_id;
    const otherTitle = (
      await prisma.vendorOffer.findUniqueOrThrow({ where: { id: otherId } })
    ).titleAr;
    const saved = await f
      .http()
      .patch(`${base(s)}/${d.id}`)
      .set(as(s))
      .send({
        expected_revision: still.revision,
        payload: {
          ...(still.payload as object),
          store_barcode: { mode: 'external', code: '4006381333931' },
        },
      })
      .expect(200);
    expect((await check(s, d.id)).problems).toEqual([
      { code: `STORE_BARCODE:BARCODE_ALREADY_USED:${otherTitle}`, step: 5 },
    ]);

    // a free code: published with it, as the product's primary EXTERNAL code (audited)
    await f
      .http()
      .patch(`${base(s)}/${d.id}`)
      .set(as(s))
      .send({
        expected_revision: saved.body.revision,
        payload: {
          ...saved.body.payload,
          store_barcode: { mode: 'external', code: '036000291452' },
        },
      })
      .expect(200);
    const offerId = (await publish(s, d.id, 201)).body.offer_id;
    const codes = await codesOf(offerId);
    expect(
      codes.map((c2) => [c2.code, c2.format, c2.source, c2.isPrimary]),
    ).toEqual([['0036000291452', 'UPCA', 'EXTERNAL', true]]);
    expect(
      await prisma.auditLog.count({
        where: { entityId: codes[0].id, action: 'offer_barcode.added' },
      }),
    ).toBe(1);
  });

  it('«إنشاء باركود من النظام» gives the code at once; publishing attaches exactly that code', async () => {
    const s = await f.store();
    const first = await reserve(s);
    const second = await reserve(s);
    expect(first.code).toMatch(/^29\d{11}$/);
    expect(second.code).not.toBe(first.code);
    const d = await create(
      s,
      await ready(s, { store_barcode: { mode: 'generate', code: first.code } }),
    );
    expect((await check(s, d.id)).ready).toBe(true);
    const offerId = (await publish(s, d.id, 201)).body.offer_id;
    const codes = await codesOf(offerId);
    expect(codes.map((c) => [c.code, c.format, c.source, c.isPrimary])).toEqual(
      [[first.code, 'EAN13', 'GENERATED', true]],
    );

    // the same reserved code on another draft: already used now - named
    const again = await create(
      s,
      await ready(s, { store_barcode: { mode: 'generate', code: first.code } }),
    );
    expect((await check(s, again.id)).problems[0].code).toMatch(
      /^STORE_BARCODE:BARCODE_ALREADY_USED:/,
    );
    // not a generated-range code: refused
    const forged = await create(
      s,
      await ready(s, {
        store_barcode: { mode: 'generate', code: '4006381333931' },
      }),
    );
    expect((await check(s, forged.id)).problems).toEqual([
      { code: 'STORE_BARCODE:BARCODE_INVALID', step: 5 },
    ]);
    // an older draft's «generate» without its code: made at publish
    const legacy = await create(
      s,
      await ready(s, { store_barcode: { mode: 'generate' } }),
    );
    const legacyOffer = (await publish(s, legacy.id, 201)).body.offer_id;
    expect((await codesOf(legacyOffer))[0].code).toMatch(/^29\d{11}$/);
  });

  it('refuses a malformed choice outright (a shape, not a barcode problem)', async () => {
    const s = await f.store();
    for (const bad of [
      { mode: 'scan' },
      { mode: 'external' },
      { mode: 'external', code: 'x'.repeat(65) },
    ])
      await f
        .http()
        .post(base(s))
        .set(as(s))
        .send({ payload: await ready(s, { store_barcode: bad }) })
        .expect(400);
  });

  it('before bulk publishing: the preflight names the missing barcode; one code typed per product (checked, saved); system codes for the CHOSEN drafts only; then they publish with those codes', async () => {
    const s = await f.store();
    const [a, b, c, typed, other] = await Promise.all([
      create(s, await ready(s)),
      create(s, await ready(s)),
      create(s, await ready(s)),
      create(s, await ready(s)),
      create(
        s,
        await ready(s, {
          store_barcode: { mode: 'external', code: '96385074' },
        }),
      ),
    ]);
    const preflight = (
      await f
        .http()
        .post(`/api/v1/vendors/${s.vendorId}/bulk-publish/preflight`)
        .set(as(s))
        .send({ draft_ids: [a.id, b.id, typed.id, other.id] })
        .expect(200)
    ).body;
    const problemsOf = (id: string) =>
      preflight.items.find((i: { draft_id: string }) => i.draft_id === id)
        .problems;
    for (const id of [a.id, b.id, typed.id])
      expect(problemsOf(id)).toEqual([
        { code: 'STORE_BARCODE:BARCODE_MISSING', step: 5 },
      ]);
    expect(problemsOf(other.id)).toEqual([]);

    // «إدخال/مسح باركود لكل منتج»
    const put = (id: string, code: string) =>
      f
        .http()
        .put(`${base(s)}/${id}/store-barcode`)
        .set(as(s))
        .send({ code });
    expect((await put(typed.id, '4006381333932')).body.error.code).toBe(
      'BARCODE_CHECK_DIGIT',
    );
    const taken = await put(typed.id, '96385074');
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('BARCODE_ALREADY_USED');
    const saved = await put(typed.id, '036000291452');
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual(
      expect.objectContaining({
        code: '0036000291452',
        display_code: '036000291452',
        format: 'UPCA',
      }),
    );
    expect(saved.body.revision).toBe(typed.revision + 1);
    expect(
      (
        (await prisma.offerDraft.findUniqueOrThrow({ where: { id: typed.id } }))
          .payload as { store_barcode: unknown }
      ).store_barcode,
    ).toEqual({ mode: 'external', code: '0036000291452' });

    // «إنشاء باركودات من النظام»: only the chosen drafts that still miss one
    const gen = (
      await f
        .http()
        .post(`${base(s)}/store-barcodes/generate`)
        .set(as(s))
        .send({ draft_ids: [a.id, b.id, typed.id, other.id] })
        .expect(201)
    ).body;
    expect(
      gen.items.map((i: { draft_id: string }) => i.draft_id).sort(),
    ).toEqual([a.id, b.id].sort());
    expect(gen.skipped).toBe(2);
    expect(new Set(gen.items.map((i: { code: string }) => i.code)).size).toBe(
      2,
    );
    for (const i of gen.items) expect(i.code).toMatch(/^29\d{11}$/);
    // c was not chosen: untouched
    expect(
      (
        (await prisma.offerDraft.findUniqueOrThrow({ where: { id: c.id } }))
          .payload as { store_barcode?: unknown }
      ).store_barcode,
    ).toBeUndefined();
    expect(
      await prisma.auditLog.count({
        where: {
          action: 'offer_draft.store_barcode_set',
          entityId: { in: [a.id, b.id, typed.id] },
        },
      }),
    ).toBe(3);

    // now every chosen draft is ready; publishing attaches exactly those codes
    const again = (
      await f
        .http()
        .post(`/api/v1/vendors/${s.vendorId}/bulk-publish/preflight`)
        .set(as(s))
        .send({ draft_ids: [a.id, b.id, typed.id, other.id] })
        .expect(200)
    ).body;
    expect(again.items.every((i: { ready: boolean }) => i.ready)).toBe(true);
    for (const [draft, code] of [
      [
        a,
        gen.items.find((i: { draft_id: string }) => i.draft_id === a.id).code,
      ],
      [typed, '0036000291452'],
    ] as [{ id: string }, string][]) {
      const offerId = (await publish(s, draft.id, 201)).body.offer_id;
      expect((await codesOf(offerId)).map((x) => x.code)).toEqual([code]);
    }
    // a closed draft is not changed afterwards
    expect((await put(a.id, '5901234123457')).body.error.code).toBe(
      'DRAFT_CLOSED',
    );
  });
});
