import { mkdtempSync, readFileSync } from 'fs';
import { rm } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as ExcelJS from 'exceljs';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { OutboxRelayService } from './../src/outbox/outbox-relay.service';
import { PrismaService } from './../src/prisma/prisma.service';
import {
  FIBER_WORDS,
  PRODUCT_COLUMNS,
} from './../src/product-import/import-labels';
import { API_ROOT } from './helpers/seed-demo-db';
import { tb26Fixtures } from './helpers/tb26-fixtures';
import { makeZip } from './helpers/zip-writer';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp = require('sharp') as typeof import('sharp/dist/index.cjs');

const UPLOADS_ROOT = mkdtempSync(
  path.join(os.tmpdir(), 'composition-uploads-'),
);
process.env.UPLOADS_DIR = UPLOADS_ROOT;

// Fabric composition and country of origin (2026-11-19): for the whole
// product, optional (a quiet hint), a part with fibres totalling exactly
// 100% to publish; the published page and the draft preview show it through
// the same view; it follows the edit of a published product and a copy;
// older products show nothing; the import reads «95% قطن، 5% إيلاستين».
// And the SKU never reaches a shopper.
describe('Fabric composition and country of origin (e2e)', () => {
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
    await rm(UPLOADS_ROOT, { recursive: true, force: true });
  });

  type Store = Awaited<ReturnType<typeof f.store>>;
  const base = (s: Store) => `/api/v1/vendors/${s.vendorId}/offer-drafts`;
  const as = (s: Store) => f.bearer(s.owner.token);
  const jpeg = (shade: number) =>
    sharp({
      create: {
        width: 30,
        height: 40,
        channels: 3,
        background: { r: shade, g: 90, b: 140 },
      },
    })
      .jpeg()
      .toBuffer();
  async function upload(s: Store, shade = 60) {
    const r = await f
      .http()
      .post(`/api/v1/vendors/${s.vendorId}/uploads`)
      .set(as(s))
      .attach('file', await jpeg(shade), 'a.jpg')
      .expect(201);
    return r.body.url as string;
  }
  async function readyPayload(s: Store, extra: object = {}) {
    return {
      layout: 5,
      step: 5,
      audience: 'WOMEN',
      category: 'DRESSES_WOMEN',
      title_ar: `فستان ${f.unique('c').slice(-6)}`,
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
  const create = (s: Store, payload: object) =>
    f.http().post(base(s)).set(as(s)).send({ payload });
  /** Publishes the draft at its current revision and checks the status. */
  async function publish(s: Store, id: string, status: number) {
    const d = await prisma.offerDraft.findUniqueOrThrow({ where: { id } });
    return f
      .http()
      .post(`${base(s)}/${id}/publish`)
      .set(as(s))
      .send({ expected_revision: d.revision })
      .expect(status);
  }
  const slugOf = async (vendorId: string) =>
    (await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } })).slug;
  const COMPLETE = {
    parts: [
      {
        part: 'SHELL',
        fibers: [
          { fiber: 'COTTON', percent: 95 },
          { fiber: 'ELASTANE', percent: 5 },
        ],
      },
      { part: 'LINING', fibers: [{ fiber: 'POLYESTER', percent: 100 }] },
    ],
  };

  it('the draft keeps an unfinished composition while typing, but refuses a wrong shape; the publish gate names an incomplete part (never publishing it), and the absence is only a quiet hint', async () => {
    const s = await f.store();
    for (const bad of [
      { parts: [{ part: 'SLEEVE', fibers: [] }] },
      { parts: [{ part: 'SHELL', fibers: [{ fiber: 'GOLD', percent: 100 }] }] },
      {
        parts: [
          {
            part: 'SHELL',
            fibers: [
              { fiber: 'COTTON', percent: 50 },
              { fiber: 'COTTON', percent: 50 },
            ],
          },
        ],
      },
      { parts: [{ part: 'SHELL', fibers: [{ fiber: 'COTTON', percent: 0 }] }] },
      {
        parts: [{ part: 'SHELL', fibers: [{ fiber: 'COTTON', percent: 2.5 }] }],
      },
      {
        parts: [
          {
            part: 'SHELL',
            fibers: [
              'COTTON',
              'POLYESTER',
              'ELASTANE',
              'VISCOSE',
              'LINEN',
              'WOOL',
              'SILK',
            ].map((fiber) => ({ fiber, percent: 10 })),
          },
        ],
      },
    ])
      await create(s, await readyPayload(s, { composition: bad }))
        .expect(400)
        .expect((r) => expect(r.body.error.code).toBe('INVALID_COMPOSITION'));
    await create(s, await readyPayload(s, { country_of_origin: 'XX' }))
      .expect(400)
      .expect((r) => expect(r.body.error.code).toBe('INVALID_COUNTRY'));

    // unfinished: a total of 95%, a fibre without its percent, an «other» without its name
    const d = await create(
      s,
      await readyPayload(s, {
        composition: {
          parts: [
            {
              part: 'SHELL',
              fibers: [
                { fiber: 'COTTON', percent: 90 },
                { fiber: 'ELASTANE', percent: 5 },
              ],
            },
            {
              part: 'LINING',
              fibers: [
                { fiber: 'POLYESTER', percent: null },
                { fiber: 'OTHER', percent: 20 },
              ],
            },
          ],
        },
        country_of_origin: 'tr',
      }),
    ).expect(201);
    expect(d.body.payload.country_of_origin).toBe('TR');
    const pc = await f
      .http()
      .get(`${base(s)}/${d.body.id}/publish-check`)
      .set(as(s))
      .expect(200);
    expect(pc.body.problems.map((p: { code: string }) => p.code)).toEqual(
      expect.arrayContaining([
        'COMPOSITION_SUM:SHELL',
        'COMPOSITION_PERCENT:LINING',
        'COMPOSITION_OTHER:LINING',
      ]),
    );
    expect(pc.body.problems.every((p: { step: number }) => p.step >= 1)).toBe(
      true,
    );
    expect((await publish(s, d.body.id, 409)).body.error.code).toBe(
      'DRAFT_NOT_PUBLISHABLE',
    );
    expect(
      await prisma.vendorOffer.count({ where: { vendorId: s.vendorId } }),
    ).toBe(0);

    // nothing given: publishable, with two quiet hints
    const plain = await create(s, await readyPayload(s)).expect(201);
    const hints = await f
      .http()
      .get(`${base(s)}/${plain.body.id}/publish-check`)
      .set(as(s))
      .expect(200);
    expect(hints.body.problems).toEqual([]);
    expect(hints.body.hints.map((h: { code: string }) => h.code)).toEqual(
      expect.arrayContaining(['COMPOSITION_SUGGESTED', 'ORIGIN_SUGGESTED']),
    );
    await publish(s, plain.body.id, 201);
  });

  it('published: the product keeps it, the shopper page and the draft preview show it through the same view, the owner sees it - and no SKU reaches a shopper; an older product shows nothing', async () => {
    const s = await f.store();
    const d = await create(
      s,
      await readyPayload(s, { composition: COMPLETE, country_of_origin: 'TR' }),
    ).expect(201);
    const preview = (
      await f
        .http()
        .get(`${base(s)}/${d.body.id}/preview`)
        .set(as(s))
        .expect(200)
    ).body;
    const offerId = (await publish(s, d.body.id, 201)).body.offer_id as string;
    const offer = await prisma.vendorOffer.findUniqueOrThrow({
      where: { id: offerId },
    });
    expect(offer.composition).toEqual(COMPLETE);
    expect(offer.countryOfOrigin).toBe('TR');
    const live = (
      await f
        .http()
        .get(
          `/api/v1/storefronts/${await slugOf(s.vendorId)}/offers/${offerId}`,
        )
        .expect(200)
    ).body;
    expect(live.composition).toEqual(COMPLETE);
    expect(live.country_of_origin).toBe('TR');
    expect({
      composition: preview.offer.composition,
      country_of_origin: preview.offer.country_of_origin,
    }).toEqual({ composition: live.composition, country_of_origin: 'TR' });
    // the SKU stays internal
    expect(JSON.stringify(live)).not.toContain('seller_sku');
    expect(JSON.stringify(preview)).not.toContain('seller_sku');
    const own = (
      await f
        .http()
        .get(`/api/v1/vendors/${s.vendorId}/offers/${offerId}`)
        .set(as(s))
        .expect(200)
    ).body;
    expect(own).toMatchObject({
      composition: COMPLETE,
      country_of_origin: 'TR',
    });

    // an older product (nothing given): null, nothing else changes
    const older = await create(s, await readyPayload(s)).expect(201);
    const olderId = (await publish(s, older.body.id, 201)).body
      .offer_id as string;
    const olderLive = (
      await f
        .http()
        .get(
          `/api/v1/storefronts/${await slugOf(s.vendorId)}/offers/${olderId}`,
        )
        .expect(200)
    ).body;
    expect(olderLive).toMatchObject({
      composition: null,
      country_of_origin: null,
    });
  });

  it('follows the edit of a published product (its own group: changed, applied - only complete) and a copy of the product', async () => {
    const s = await f.store();
    const d = await create(
      s,
      await readyPayload(s, { composition: COMPLETE, country_of_origin: 'TR' }),
    ).expect(201);
    const offerId = (await publish(s, d.body.id, 201)).body.offer_id as string;

    const edit = (
      await f
        .http()
        .post(`${base(s)}/edit-of/${offerId}`)
        .set(as(s))
        .expect(201)
    ).body;
    expect(edit.payload).toMatchObject({
      composition: COMPLETE,
      country_of_origin: 'TR',
    });
    const changed = {
      parts: [
        COMPLETE.parts[0],
        {
          part: 'LINING',
          fibers: [
            { fiber: 'VISCOSE', percent: 60 },
            { fiber: 'OTHER', other_ar: 'ميتاليك', percent: 40 },
          ],
        },
      ],
    };
    const saved = await f
      .http()
      .patch(`${base(s)}/${edit.id}`)
      .set(as(s))
      .send({
        expected_revision: edit.revision,
        payload: {
          ...edit.payload,
          composition: changed,
          country_of_origin: 'CN',
        },
      })
      .expect(200);
    const review = (
      await f
        .http()
        .get(`${base(s)}/${edit.id}/review`)
        .set(as(s))
        .expect(200)
    ).body;
    expect(JSON.stringify(review.groups)).toContain('composition');
    await f
      .http()
      .post(`${base(s)}/${edit.id}/apply`)
      .set(as(s))
      .send({ expected_revision: saved.body.revision })
      .expect(200);
    const after = await prisma.vendorOffer.findUniqueOrThrow({
      where: { id: offerId },
    });
    expect(after.composition).toEqual(changed);
    expect(after.countryOfOrigin).toBe('CN');

    // a copy of the product carries both
    const copy = await f
      .http()
      .post(base(s))
      .set(as(s))
      .send({ copy_from: { offer_id: offerId } })
      .expect(201);
    expect(copy.body.payload).toMatchObject({
      composition: changed,
      country_of_origin: 'CN',
    });
  });

  describe('the import', () => {
    const PRODUCT_HEADER = [
      'رقم المنتج في الملف',
      'الاسم بالعربية',
      'الجمهور',
      'الفئة',
      'العلامة التجارية',
      'السعر',
      'نظام المقاسات',
      'تركيب الخامة الخارجية',
      'تركيب البطانة',
      'بلد المنشأ',
    ];
    async function importCheck(
      s: Store,
      rows: (string | number | null)[][],
      header = PRODUCT_HEADER,
    ) {
      const branches = await prisma.storeBranch.findMany({
        where: { vendorId: s.vendorId },
        orderBy: { createdAt: 'asc' },
      });
      const wb = new ExcelJS.Workbook();
      wb.addWorksheet('المنتجات').addRows([header, ...rows]);
      wb.addWorksheet('الألوان والمقاسات').addRows([
        [
          'رقم المنتج في الملف',
          'اسم اللون بالعربية',
          'عائلة اللون',
          'المقاس',
          `الكمية: ${branches[0].name}`,
        ],
        ...rows.map((r) => [r[0], 'أحمر', 'أحمر', 'M', 2]),
      ]);
      wb.addWorksheet('الصور').addRows([
        [
          'رقم المنتج في الملف',
          'اسم اللون بالعربية',
          'اسم ملف الصورة',
          'نوع الصورة',
        ],
        ...rows.map((r) => [r[0], 'أحمر', `p${r[0]}.jpg`, 'رئيسية']),
      ]);
      const zip = makeZip(
        await Promise.all(
          rows.map(async (r) => ({
            name: `p${r[0]}.jpg`,
            data: await jpeg(10 * Number(r[0])),
          })),
        ),
      );
      return f
        .http()
        .post(`/api/v1/vendors/${s.vendorId}/product-import/check`)
        .set(as(s))
        .attach('file', Buffer.from(await wb.xlsx.writeBuffer()), 'p.xlsx')
        .attach('images', zip, 'p.zip')
        .expect(200);
    }
    const row = (
      n: number,
      shell: string | null,
      lining: string | null,
      country: string | null,
    ) => [
      n,
      `منتج ${n}`,
      'نساء',
      'فساتين',
      'بدون علامة تجارية',
      100 + n,
      'حروف',
      shell,
      lining,
      country,
    ];

    it('the template has the optional columns, the country list and the instructions with «95% قطن، 5% إيلاستين»', async () => {
      const s = await f.store();
      const res = await f
        .http()
        .get(`/api/v1/vendors/${s.vendorId}/product-import/template`)
        .set(as(s))
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(res.body as ArrayBuffer);
      const header = JSON.stringify(
        wb.getWorksheet('المنتجات')!.getRow(1).values,
      );
      for (const k of [
        'composition_shell',
        'composition_lining',
        'composition_filling',
        'composition_trim',
        'country_of_origin',
      ] as const)
        expect(header).toContain(PRODUCT_COLUMNS[k].ar);
      const lists = JSON.stringify(
        wb.getWorksheet('القوائم')!.getSheetValues(),
      );
      for (const w of ['تركيا', 'الصين', 'قطن', 'إيلاستين'])
        expect(lists).toContain(w);
      expect(
        JSON.stringify(wb.getWorksheet('التعليمات')!.getSheetValues()),
      ).toContain('95% قطن، 5% إيلاستين');
    });

    it('each part from one cell («95% قطن، 5% إيلاستين», «قطن 95%», English, «أخرى: …»), the country by name; a wrong total, an unknown fibre or country is named by cell; empty cells are fine; an old file without the columns still imports', async () => {
      const s = await f.store();
      const r = await importCheck(s, [
        row(1, '95% قطن، 5% إيلاستين', '100% بوليستر', 'تركيا'),
        row(2, '90% قطن، 5% إيلاستين', null, null),
        row(3, '50% قطن، 50% بلاستيك', null, null),
        row(4, null, null, 'أرض الأحلام'),
        row(5, 'Cotton 95% + 5% أخرى: ميتاليك', null, 'CN'),
        row(6, null, null, null),
      ]);
      const by = (ref: string) =>
        r.body.products.find((p: { ref: string }) => p.ref === ref);
      for (const ref of ['1', '5', '6']) expect(by(ref).status).toBe('ready');
      const err = (ref: string) => by(ref).errors[0];
      expect(err('2')).toMatchObject({
        sheet: 'products',
        row: 3,
        column: 'تركيب الخامة الخارجية',
        code: 'COMPOSITION_SUM',
        value: '95',
      });
      expect(err('3')).toMatchObject({
        column: 'تركيب الخامة الخارجية',
        code: 'COMPOSITION_FIBER_UNKNOWN',
        value: 'بلاستيك',
      });
      expect(err('4')).toMatchObject({
        column: 'بلد المنشأ',
        code: 'UNKNOWN_COUNTRY',
        value: 'أرض الأحلام',
      });
      const confirmed = await f
        .http()
        .post(
          `/api/v1/vendors/${s.vendorId}/product-import/${r.body.batch_id}/confirm`,
        )
        .set(as(s))
        .send({ refs: ['1', '5', '6'], expected_sha256: r.body.file_sha256 })
        .expect(201);
      const payloadOf = async (ref: string) =>
        (
          await prisma.offerDraft.findUniqueOrThrow({
            where: {
              id: confirmed.body.created.find(
                (c: { ref: string }) => c.ref === ref,
              ).draft_id,
            },
          })
        ).payload as Record<string, unknown>;
      expect(await payloadOf('1')).toMatchObject({
        composition: COMPLETE,
        country_of_origin: 'TR',
      });
      expect(await payloadOf('5')).toMatchObject({
        composition: {
          parts: [
            {
              part: 'SHELL',
              fibers: [
                { fiber: 'COTTON', percent: 95 },
                { fiber: 'OTHER', other_ar: 'ميتاليك', percent: 5 },
              ],
            },
          ],
        },
        country_of_origin: 'CN',
      });
      const six = await payloadOf('6');
      expect(six.composition).toBeUndefined();
      expect(six.country_of_origin).toBeUndefined();

      // an old file without the new columns
      const old = await importCheck(
        s,
        [[7, 'منتج 7', 'نساء', 'فساتين', 'بدون علامة تجارية', 107, 'حروف']],
        PRODUCT_HEADER.slice(0, 7),
      );
      expect(old.body.products[0].status).toBe('ready');
    });

    it("the fibres' words are the wizard's", () => {
      const web = readFileSync(
        path.join(API_ROOT, '..', 'web', 'src', 'lib', 'composition.ts'),
        'utf8',
      );
      for (const [code, w] of Object.entries(FIBER_WORDS)) {
        expect(web).toContain(`"wz.fiber.${code}": "${w.ar}"`);
        expect(web).toContain(`"wz.fiber.${code}": "${w.en}"`);
      }
    });
  });
});
