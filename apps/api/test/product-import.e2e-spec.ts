import { randomUUID } from 'crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as ExcelJS from 'exceljs';
import { AppModule } from './../src/app.module';
import { AuditLogService } from './../src/audit/audit-log.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { OutboxRelayService } from './../src/outbox/outbox-relay.service';
import { PrismaService } from './../src/prisma/prisma.service';
import {
  importStagingRoot,
  incomingDir,
  stagingDirOf,
} from './../src/product-import/import-images';
import {
  MEASURE_WORDS,
  SPEC_FIELD_WORDS,
  SPEC_VALUE_WORDS,
} from './../src/product-import/import-labels';
import { ImportStagingSweepService } from './../src/product-import/import-staging-sweep.service';
import {
  ownUploadUrl,
  uploadsDir,
  uploadsPublicBaseUrl,
} from './../src/uploads/uploads.util';
import { API_ROOT } from './helpers/seed-demo-db';
import { tb26Fixtures } from './helpers/tb26-fixtures';
import { makeZip, type ZipItem } from './helpers/zip-writer';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp = require('sharp') as typeof import('sharp/dist/index.cjs');

// The product import with its images (2026-11-18, images in bulk): an XLSX
// file + a ZIP of images -> complete wizard drafts. The check creates
// nothing public (images wait, cleaned, in a private staging folder); a
// product is ready (publishable as it is) or rejected with the reason by
// sheet, row, column or ZIP file; the chosen products become complete
// unpublished drafts all at once or not at all - no image left behind.
describe('Product import (e2e)', () => {
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
  const base = (vendorId: string) =>
    `/api/v1/vendors/${vendorId}/product-import`;
  const filesIn = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);
  const publicFiles = (vendorId: string) =>
    filesIn(join(uploadsDir(), 'vendors', vendorId));

  // images, made here (different colours = different pictures)
  const solid = (r: number, g: number, b: number, width = 60, height = 80) =>
    sharp({
      create: { width, height, channels: 3, background: { r, g, b } },
    });
  const jpg = (r: number, g = 10, b = 10) => solid(r, g, b).jpeg().toBuffer();
  const png = (r: number, g = 20, b = 20) => solid(r, g, b).png().toBuffer();
  const webp = (r: number, g = 30, b = 30) => solid(r, g, b).webp().toBuffer();
  const HEIC = Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from('ftypheic', 'latin1'),
    Buffer.alloc(64),
  ]);
  const SVG = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  );

  async function workbook(
    sheets: Record<string, (string | number | null)[][]>,
  ) {
    const wb = new ExcelJS.Workbook();
    for (const [name, rows] of Object.entries(sheets)) {
      const ws = wb.addWorksheet(name);
      rows.forEach((r) => ws.addRow(r));
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
  const check = (
    token: string,
    vendorId: string,
    xlsx: Buffer,
    zip: Buffer | null,
    names = { xlsx: 'products.xlsx', zip: 'images.zip' },
  ) => {
    const r = f
      .http()
      .post(`${base(vendorId)}/check`)
      .set(auth(token))
      .attach('file', xlsx, names.xlsx);
    return zip ? r.attach('images', zip, names.zip) : r;
  };
  const confirmOf =
    (
      token: string,
      vendorId: string,
      checked: { batch_id: string; file_sha256: string },
    ) =>
    (body: object) =>
      f
        .http()
        .post(`${base(vendorId)}/${checked.batch_id}/confirm`)
        .set(auth(token))
        .send({ expected_sha256: checked.file_sha256, ...body });

  /** A store with its two branches' names, a family shared by two colours, and a collection. */
  async function setup() {
    const s = await f.store();
    const branches = await prisma.storeBranch.findMany({
      where: { vendorId: s.vendorId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true },
    });
    const family = await prisma.taxonomyColor.findFirstOrThrow({
      where: { code: 'BEIGE' },
    });
    const collection = await f
      .http()
      .post(`/api/v1/vendors/${s.vendorId}/sections`)
      .set(auth(s.owner.token))
      .send({ name_ar: 'فساتين سهرة' })
      .expect(201);
    return { s, branches, family, collectionId: collection.body.id as string };
  }
  type Ctx = Awaited<ReturnType<typeof setup>>;

  const PRODUCT_HEADER = [
    'رقم المنتج في الملف',
    'الاسم بالعربية',
    'الاسم بالإنجليزية',
    'الجمهور',
    'الفئة',
    'العلامة التجارية',
    'السعر',
    'نظام المقاسات',
    'المجموعات',
    'مواصفة: المقاس على الجسم',
    'مواصفة: الخامة',
  ];
  const versionHeader = (branches: { name: string }[]) => [
    'رقم المنتج في الملف',
    'اسم اللون بالعربية',
    'اسم اللون بالإنجليزية',
    'عائلة اللون',
    'ترتيب اللون',
    'المقاس',
    ...branches.map((b) => `الكمية: ${b.name}`),
  ];
  const IMAGE_HEADER = [
    'رقم المنتج في الملف',
    'اسم اللون بالعربية',
    'اسم ملف الصورة',
    'نوع الصورة',
    'الترتيب',
  ];
  const product = (ref: number, title: string) => [
    ref,
    title,
    null,
    'نساء',
    'فساتين',
    'بدون علامة تجارية',
    150 + ref,
    'حروف',
    null,
    null,
    null,
  ];
  const version = (ref: number, color: string, family: string, size = 'M') => [
    ref,
    color,
    null,
    family,
    1,
    size,
    2,
    null,
  ];

  /**
   * The whole story in one file:
   *  1 «فستان سهرة مخملي» - «موكا» (main + two extras, ordered) and «بيج رملي»
   *    (main, turned by EXIF), one shared image: READY;
   *  2 a HEIC image; 3 a file not in the ZIP; 4 no main image, an unknown
   *    colour, a shared image given a colour; 5 a PNG named .jpg;
   *  6 its main image is product 1's shared image: READY, with a warning;
   *  7 30 megapixels, an SVG, a GIF; 8 two main images, a file twice.
   * The ZIP also has an unused file and macOS / Windows system files.
   */
  async function storyFiles(ctx: Ctx) {
    const fam = ctx.family.nameAr;
    const m1 = await solid(120, 80, 60)
      .jpeg()
      .withExif({
        IFD0: { Artist: 'Owner Name', Copyright: 'secret-location-31.9' },
      })
      .toBuffer();
    const s1 = await solid(10, 200, 10, 40, 20)
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const big = await solid(1, 2, 3, 6000, 5000).png().toBuffer();
    const images: (string | number | null)[][] = [
      [1, 'موكا', 'm1.jpg', 'رئيسية', null],
      [1, 'موكا', 'm2.png', 'إضافية', 2],
      [1, 'موكا', 'photos/m3.webp', 'إضافية', 1],
      [1, 'بيج رملي', 's1.jpg', 'رئيسية', null],
      [1, null, 'd1.jpg', 'مشتركة', 1],
      [2, 'أسود', 'abaya.heic', 'رئيسية', null], // row 7
      [3, 'أحمر', 'missing.jpg', 'رئيسية', null], // row 8
      [4, 'أزرق', 'q1.jpg', 'إضافية', null],
      [4, 'أخضر', 'q2.jpg', 'رئيسية', null], // row 10
      [4, 'أزرق', 'q3.jpg', 'مشتركة', null], // row 11
      [5, 'أسود', 'fake.jpg', 'رئيسية', null], // row 12
      [6, 'أبيض', 'd1.jpg', 'رئيسية', null], // row 13
      [7, 'وردي', 'big.png', 'رئيسية', null], // row 14
      [7, 'وردي', 'pic.svg', 'إضافية', null],
      [7, 'وردي', 'anim.gif', 'إضافية', null],
      [8, 'أحمر', 'k1.jpg', 'رئيسية', null],
      [8, 'أحمر', 'k2.jpg', 'رئيسية', null], // row 18
      [8, 'أحمر', 'k1.jpg', 'إضافية', null], // row 19
    ];
    const xlsx = await workbook({
      المنتجات: [
        PRODUCT_HEADER,
        [
          1,
          'فستان سهرة مخملي',
          'Velvet dress',
          'نساء',
          'فساتين',
          'بدون علامة تجارية',
          250,
          'حروف',
          'فساتين سهرة',
          'عادي',
          'مخمل',
        ],
        product(2, 'عباية'),
        product(3, 'تنورة'),
        product(4, 'قميص'),
        product(5, 'بنطال'),
        product(6, 'بلوزة'),
        product(7, 'شال'),
        product(8, 'جاكيت'),
      ],
      'الألوان والمقاسات': [
        versionHeader(ctx.branches),
        [1, 'موكا', 'Mocha', fam, 1, 'S', 3, null],
        [1, 'موكا', 'Mocha', fam, 1, 'M', 2, null],
        [1, 'بيج رملي', null, fam, 2, 'M', null, 4],
        version(2, 'أسود', 'أسود'),
        version(3, 'أحمر', 'أحمر'),
        version(4, 'أزرق', 'أزرق'),
        version(5, 'أسود', 'أسود'),
        version(6, 'أبيض', 'أبيض'),
        version(7, 'وردي', 'أحمر'),
        version(8, 'أحمر', 'أحمر'),
      ],
      الصور: [IMAGE_HEADER, ...images],
    });
    const zipItems: ZipItem[] = [
      { name: 'm1.jpg', data: m1 },
      { name: 'm2.png', data: await png(200) },
      { name: 'photos/m3.webp', data: await webp(90), deflate: true },
      { name: 'S1.JPG', data: s1 }, // the sheet says s1.jpg: case does not matter
      { name: 'photos/d1.jpg', data: await jpg(30, 30, 200) }, // the sheet says d1.jpg: its folder does not matter
      { name: 'abaya.heic', data: HEIC },
      { name: 'q1.jpg', data: await jpg(40) },
      { name: 'q2.jpg', data: await jpg(50) },
      { name: 'q3.jpg', data: await jpg(60) },
      { name: 'fake.jpg', data: await png(70) },
      { name: 'big.png', data: big },
      { name: 'pic.svg', data: SVG },
      { name: 'anim.gif', data: await solid(9, 9, 9).gif().toBuffer() },
      { name: 'k1.jpg', data: await jpg(80) },
      { name: 'k2.jpg', data: await jpg(90) },
      { name: 'unused.jpg', data: await jpg(100) },
      { name: '__MACOSX/._m1.jpg', data: Buffer.from('mac') },
      { name: '.DS_Store', data: Buffer.from('mac') },
    ];
    return { xlsx, zip: makeZip(zipItems) };
  }

  /** One product, one colour, its main image - for the tests about the file itself. */
  async function simpleFiles(ctx: Ctx, title: string, picture = 5) {
    const xlsx = await workbook({
      المنتجات: [PRODUCT_HEADER, product(1, title)],
      'الألوان والمقاسات': [
        versionHeader(ctx.branches),
        version(1, 'أحمر', 'أحمر'),
      ],
      الصور: [IMAGE_HEADER, [1, 'أحمر', 'a.jpg', 'رئيسية', null]],
    });
    return {
      xlsx,
      zip: makeZip([{ name: 'a.jpg', data: await jpg(picture) }]),
    };
  }

  it("the template: the store's own sheets with «الصور» and its list of kinds, branch columns and lists - no SKU, barcode or JSON; Arabic and English", async () => {
    const ctx = await setup();
    const get = (lang: string) =>
      f
        .http()
        .get(`${base(ctx.s.vendorId)}/template?lang=${lang}`)
        .set(auth(ctx.s.owner.token))
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
    const res = await get('ar');
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'المنتجات',
      'الألوان والمقاسات',
      'الصور',
      'جدول القياسات',
      'التعليمات',
      'القوائم',
    ]);
    expect(wb.getWorksheet('القوائم')!.state).toBe('hidden');
    const headers = (name: string) =>
      (wb.getWorksheet(name)!.getRow(1).values as unknown[])
        .filter(Boolean)
        .map(String);
    expect(headers('الصور')).toEqual([
      'رقم المنتج في الملف *',
      'اسم اللون بالعربية',
      'اسم ملف الصورة *',
      'نوع الصورة *',
      'الترتيب',
    ]);
    const all = [
      ...headers('المنتجات'),
      ...headers('الألوان والمقاسات'),
      ...headers('الصور'),
    ].join(' | ');
    for (const b of ctx.branches) expect(all).toContain(`الكمية: ${b.name}`);
    expect(all).not.toMatch(/sku|MPN|json|url|رابط/i);
    // ONE optional barcode column, for the whole product, kept as text
    expect(headers('المنتجات')).toContain('الباركود');
    expect(
      [...headers('الألوان والمقاسات'), ...headers('الصور')].join('|'),
    ).not.toContain('الباركود');
    const productsSheet = wb.getWorksheet('المنتجات')!;
    const barcodeCol = (productsSheet.getRow(1).values as unknown[]).findIndex(
      (v) => v === 'الباركود',
    );
    expect(productsSheet.getColumn(barcodeCol).numFmt).toBe('@');
    const listText = JSON.stringify(
      wb.getWorksheet('القوائم')!.getSheetValues(),
    );
    for (const w of [
      'بدون علامة تجارية',
      'فساتين سهرة',
      'رئيسية',
      'إضافية',
      'مشتركة',
    ])
      expect(listText).toContain(w);
    const help = JSON.stringify(wb.getWorksheet('التعليمات')!.getSheetValues());
    for (const w of ['ZIP', 'HEIC', 'dress1-mocha-1.jpg', 'رئيسية'])
      expect(help).toContain(w);
    const wbEn = new ExcelJS.Workbook();
    await wbEn.xlsx.load((await get('en')).body as ArrayBuffer);
    expect(wbEn.worksheets.map((w) => w.name).slice(0, 3)).toEqual([
      'Products',
      'Colours and sizes',
      'Images',
    ]);
  });

  it('the check creates NOTHING public: the ready product has its images (main per colour, ordered extras, shared); every other one is rejected by sheet, row, column and ZIP file; unused and system files are said; the accepted images wait in a private staging folder', async () => {
    const ctx = await setup();
    const counts = async () => ({
      drafts: await prisma.offerDraft.count({
        where: { vendorId: ctx.s.vendorId },
      }),
      offers: await prisma.vendorOffer.count({
        where: { vendorId: ctx.s.vendorId },
      }),
      brandRequests: await prisma.brandRequest.count({
        where: { vendorId: ctx.s.vendorId },
      }),
    });
    const before = await counts();
    const { xlsx, zip } = await storyFiles(ctx);
    const r = await check(ctx.s.owner.token, ctx.s.vendorId, xlsx, zip).expect(
      200,
    );
    expect(await counts()).toEqual(before);
    expect(publicFiles(ctx.s.vendorId)).toEqual([]);
    const by = (ref: string) =>
      r.body.products.find((p: { ref: string }) => p.ref === ref);
    const err = (ref: string, code: string) =>
      by(ref).errors.find((e: { code: string }) => e.code === code);

    expect(by('1')).toMatchObject({
      status: 'ready',
      selectable: true,
      errors: [],
      images: 5,
      image_colors: [
        { name: 'موكا', count: 3 },
        { name: 'بيج رملي', count: 1 },
      ],
      shared_images: 1,
    });
    expect(by('6')).toMatchObject({ status: 'ready', selectable: true });
    expect(by('6').warnings).toEqual([
      expect.objectContaining({
        sheet: 'images',
        row: 13,
        code: 'IMAGE_IN_OTHER_PRODUCT',
        value: 'فستان سهرة مخملي',
        file: 'photos/d1.jpg',
      }),
    ]);
    for (const ref of ['2', '3', '4', '5', '7', '8'])
      expect(by(ref)).toMatchObject({ status: 'rejected', selectable: false });
    expect(err('2', 'IMAGE_FORMAT')).toEqual({
      sheet: 'images',
      row: 7,
      column: 'اسم ملف الصورة',
      code: 'IMAGE_FORMAT',
      value: 'HEIC',
      file: 'abaya.heic',
    });
    expect(err('3', 'IMAGE_FILE_MISSING')).toMatchObject({
      row: 8,
      value: 'missing.jpg',
    });
    expect(err('4', 'MAIN_IMAGE_MISSING')).toMatchObject({ value: 'أزرق' });
    expect(err('4', 'IMAGE_COLOR_UNKNOWN')).toMatchObject({
      row: 10,
      column: 'اسم اللون بالعربية',
      value: 'أخضر',
    });
    expect(err('4', 'SHARED_WITH_COLOR')).toMatchObject({ row: 11 });
    expect(err('5', 'IMAGE_EXT_MISMATCH')).toMatchObject({
      row: 12,
      value: '.jpg → PNG',
      file: 'fake.jpg',
    });
    expect(err('7', 'IMAGE_TOO_MANY_PIXELS')).toMatchObject({
      row: 14,
      value: '6000×5000',
    });
    expect(
      by('7')
        .errors.filter((e: { code: string }) => e.code === 'IMAGE_FORMAT')
        .map((e: { value: string }) => e.value)
        .sort(),
    ).toEqual(['GIF', 'SVG']);
    expect(err('8', 'MAIN_IMAGE_DUPLICATE')).toMatchObject({ row: 18 });
    expect(err('8', 'IMAGE_REPEATED')).toMatchObject({ row: 19 });
    expect(r.body.zip).toMatchObject({
      file_name: 'images.zip',
      staged: 5,
      unused: ['unused.jpg'],
      unused_count: 1,
      ignored: ['__MACOSX/._m1.jpg', '.DS_Store'],
    });
    // nothing of the built drafts is sent back
    expect(by('1').payload).toBeUndefined();
    const batch = await prisma.importBatch.findUniqueOrThrow({
      where: { id: r.body.batch_id },
    });
    expect(batch).toMatchObject({
      kind: 'PRODUCT_DRAFTS',
      status: 'CHECKED',
      productsRejected: 6,
      imagesStaged: 5,
      zipFileName: 'images.zip',
    });
    // staged privately: only the ready products' images, outside the public uploads
    const staging = stagingDirOf(ctx.s.vendorId, r.body.batch_id);
    expect(filesIn(staging)).toHaveLength(5);
    expect(staging.startsWith(uploadsDir())).toBe(false);
    const p = (
      batch.checkResult as {
        products: {
          ref: string;
          payload?: { colors: { images: string[] }[] };
        }[];
      }
    ).products.find((x) => x.ref === '1')!;
    expect(p.payload!.colors[0].images[0]).toMatch(
      /^staged:[0-9a-f]{64}\.jpg$/,
    );
  });

  it('the ZIP itself is refused - nothing read or written outside the staging - for an unsafe path, a symbolic link, encryption, two entries with one name, an undeclared name encoding or a ZIP bomb; it is required and must be a ZIP', async () => {
    const ctx = await setup();
    const { xlsx } = await simpleFiles(ctx, 'فستان');
    const img = await jpg(11);
    const cases: [string, ZipItem[]][] = [
      [
        'ZIP_UNSAFE_PATH',
        [
          { name: '../evil.jpg', data: img },
          { name: 'a.jpg', data: img },
        ],
      ],
      ['ZIP_UNSAFE_PATH', [{ name: '/abs/evil.jpg', data: img }]],
      [
        'ZIP_SYMLINK',
        [
          {
            name: 'a.jpg',
            data: Buffer.from('/etc/passwd'),
            unixMode: 0o120777,
          },
        ],
      ],
      ['ZIP_ENCRYPTED', [{ name: 'a.jpg', data: img, encrypted: true }]],
      [
        'ZIP_DUPLICATE_NAME',
        [
          { name: 'A.jpg', data: img },
          { name: 'a.jpg', data: img },
        ],
      ],
      [
        'ZIP_NAME_ENCODING',
        [
          // «صور.jpg» written in Windows-1256 without the UTF-8 flag
          {
            name: Buffer.from([0xd5, 0xe6, 0xd1, 0x2e, 0x6a, 0x70, 0x67]),
            data: img,
          },
          { name: 'a.jpg', data: img },
        ],
      ],
      [
        'ZIP_BOMB',
        [
          {
            name: 'a.jpg',
            data: Buffer.alloc(20 * 1024 * 1024),
            deflate: true,
          },
        ],
      ],
    ];
    for (const [code, items] of cases) {
      const r = await check(
        ctx.s.owner.token,
        ctx.s.vendorId,
        xlsx,
        makeZip(items),
      ).expect(200);
      expect(r.body.file_problems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sheet: 'zip', code }),
        ]),
      );
      expect(r.body.products[0]).toMatchObject({ status: 'rejected' });
      expect(r.body.products[0].errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'ZIP_REFUSED' }),
        ]),
      );
      expect(filesIn(stagingDirOf(ctx.s.vendorId, r.body.batch_id))).toEqual(
        [],
      );
    }
    for (const dir of [
      importStagingRoot(),
      join(importStagingRoot(), '..'),
      uploadsDir(),
    ])
      expect(existsSync(join(dir, 'evil.jpg'))).toBe(false);
    expect(publicFiles(ctx.s.vendorId)).toEqual([]);
    await check(ctx.s.owner.token, ctx.s.vendorId, xlsx, null)
      .expect(400)
      .expect((x) => expect(x.body.error.code).toBe('IMPORT_ZIP_REQUIRED'));
    await check(
      ctx.s.owner.token,
      ctx.s.vendorId,
      xlsx,
      Buffer.from('not a zip'),
    )
      .expect(400)
      .expect((x) => expect(x.body.error.code).toBe('IMPORT_ZIP_ONLY'));
    // nothing is left in the private incoming folder after a request
    expect(filesIn(incomingDir())).toEqual([]);
  });

  it('confirm: complete unpublished drafts with their images - copied once to the public uploads under new names, without EXIF, upright, owned by the drafts, on the review step, publishable as they are; the staging is removed; a second confirm is refused; nothing is published', async () => {
    const ctx = await setup();
    const { xlsx, zip } = await storyFiles(ctx);
    const r = await check(ctx.s.owner.token, ctx.s.vendorId, xlsx, zip).expect(
      200,
    );
    const confirm = confirmOf(ctx.s.owner.token, ctx.s.vendorId, r.body);
    await confirm({ refs: ['1', '2'] })
      .expect(400)
      .expect((x) => expect(x.body.error.code).toBe('IMPORT_PRODUCT_REJECTED'));
    expect(publicFiles(ctx.s.vendorId)).toEqual([]);
    const ok = await confirm({ refs: ['1', '6'] }).expect(201);
    expect(ok.body.created.map((c: { ref: string }) => c.ref)).toEqual([
      '1',
      '6',
    ]);
    const [d1, d6] = await Promise.all(
      ok.body.created.map((c: { draft_id: string }) =>
        prisma.offerDraft.findUniqueOrThrow({ where: { id: c.draft_id } }),
      ),
    );
    const p = d1.payload as {
      step: number;
      colors: { name_ar: string; images: string[] }[];
      shared_images: string[];
      sections: string[];
    };
    const own = `${uploadsPublicBaseUrl()}/vendors/${ctx.s.vendorId}/`;
    expect(p.step).toBe(5);
    expect(p.colors.map((c) => [c.name_ar, c.images.length])).toEqual([
      ['موكا', 3],
      ['بيج رملي', 1],
    ]);
    // the main image first, then the extras by their order (m3 = 1, m2 = 2)
    expect(p.colors[0].images.map((u) => u.split('.').pop())).toEqual([
      'jpg',
      'webp',
      'png',
    ]);
    expect(p.shared_images).toHaveLength(1);
    for (const u of [...p.colors.flatMap((c) => c.images), ...p.shared_images])
      expect(u.startsWith(own)).toBe(true);
    expect(p.sections).toEqual([ctx.collectionId]);
    // the same picture (1's shared, 6's main) is one public file
    expect((d6.payload as typeof p).colors[0].images[0]).toBe(
      p.shared_images[0],
    );
    expect(publicFiles(ctx.s.vendorId)).toHaveLength(5);
    expect(new Set(d1.uploads as string[])).toEqual(
      new Set([...p.colors.flatMap((c) => c.images), ...p.shared_images]),
    );
    // EXIF gone (location, owner), the turned image stored upright
    const fileOf = (url: string) =>
      readFileSync(
        join(uploadsDir(), 'vendors', ctx.s.vendorId, url.slice(own.length)),
      );
    const main = fileOf(p.colors[0].images[0]);
    expect((await sharp(main).metadata()).exif).toBeUndefined();
    expect(main.includes('secret-location')).toBe(false);
    const upright = await sharp(fileOf(p.colors[1].images[0])).metadata();
    expect([upright.width, upright.height, upright.orientation]).toEqual([
      20,
      40,
      undefined,
    ]);
    expect(ownUploadUrl(ctx.s.vendorId, 'x.jpg').startsWith(own)).toBe(true);
    // complete: the publish gate has nothing to ask
    const pc = await f
      .http()
      .get(
        `/api/v1/vendors/${ctx.s.vendorId}/offer-drafts/${d1.id}/publish-check`,
      )
      .set(auth(ctx.s.owner.token))
      .expect(200);
    expect(pc.body.problems).toEqual([]);
    const list = await f
      .http()
      .get(`/api/v1/vendors/${ctx.s.vendorId}/offer-drafts`)
      .set(auth(ctx.s.owner.token))
      .expect(200);
    expect(
      list.body.items.find((x: { id: string }) => x.id === d1.id).imported,
    ).toBe(true);
    expect(filesIn(stagingDirOf(ctx.s.vendorId, r.body.batch_id))).toEqual([]);
    expect(
      await prisma.importBatch.findUniqueOrThrow({
        where: { id: r.body.batch_id },
      }),
    ).toMatchObject({
      status: 'CONFIRMED',
      draftsCreated: 2,
      plannedUploads: null,
    });
    await confirm({ refs: ['1'] })
      .expect(409)
      .expect((x) =>
        expect(x.body.error.code).toBe('IMPORT_ALREADY_CONFIRMED'),
      );
    expect(
      await prisma.vendorOffer.count({ where: { vendorId: ctx.s.vendorId } }),
    ).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: {
          action: 'product_import.confirmed',
          entityId: r.body.batch_id,
        },
      }),
    ).toBe(1);
  });

  it('all or nothing: a branch archived after the check, or a failure while the drafts are written, leaves no draft and no image - the copied images are removed, the check can be confirmed again', async () => {
    const ctx = await setup();
    const { xlsx, zip } = await storyFiles(ctx);
    const r = await check(ctx.s.owner.token, ctx.s.vendorId, xlsx, zip).expect(
      200,
    );
    const confirm = confirmOf(ctx.s.owner.token, ctx.s.vendorId, r.body);
    const staging = stagingDirOf(ctx.s.vendorId, r.body.batch_id);
    const nothingLeft = async () => {
      expect(
        await prisma.offerDraft.count({ where: { vendorId: ctx.s.vendorId } }),
      ).toBe(0);
      expect(publicFiles(ctx.s.vendorId)).toEqual([]);
      expect(
        await prisma.importBatch.findUniqueOrThrow({
          where: { id: r.body.batch_id },
        }),
      ).toMatchObject({ status: 'CHECKED', plannedUploads: null });
      expect(filesIn(staging)).toHaveLength(5);
    };

    await prisma.storeBranch.update({
      where: { id: ctx.branches[0].id },
      data: { archivedAt: new Date() },
    });
    await confirm({ refs: ['1', '6'] })
      .expect(409)
      .expect((x) => expect(x.body.error.code).toBe('IMPORT_STALE'));
    await nothingLeft();
    await prisma.storeBranch.update({
      where: { id: ctx.branches[0].id },
      data: { archivedAt: null },
    });

    // the second draft's write fails: the first one is rolled back with it
    const audit = app.get(AuditLogService);
    const real = audit.record.bind(audit);
    let drafts = 0;
    const spy = jest
      .spyOn(audit, 'record')
      .mockImplementation(async (entry, tx) => {
        if (entry.action === 'offer_draft.created' && ++drafts === 2)
          throw new Error('simulated failure');
        return real(entry, tx);
      });
    try {
      await confirm({ refs: ['1', '6'] }).expect(500);
    } finally {
      spy.mockRestore();
    }
    await nothingLeft();

    const ok = await confirm({ refs: ['1', '6'] }).expect(201);
    expect(ok.body.created).toHaveLength(2);
    expect(publicFiles(ctx.s.vendorId)).toHaveLength(5);
  });

  it("a ready product's staged thumbnail: only its store, only while its check is valid (afterwards, for another store or a rejected product: the same 404); a small private copy, never a public URL", async () => {
    const ctx = await setup();
    const { xlsx, zip } = await storyFiles(ctx);
    const r = await check(ctx.s.owner.token, ctx.s.vendorId, xlsx, zip).expect(
      200,
    );
    const thumb = (vendorId: string, token: string, ref: string) =>
      f
        .http()
        .get(`${base(vendorId)}/${r.body.batch_id}/thumbnails/${ref}`)
        .set(auth(token))
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        });
    const ok = await thumb(ctx.s.vendorId, ctx.s.owner.token, '1').expect(200);
    expect(ok.headers['content-type']).toBe('image/webp');
    expect(ok.headers['cache-control']).toBe('private, no-store');
    const meta = await sharp(ok.body as Buffer).metadata();
    expect([meta.width, meta.height, meta.exif]).toEqual([240, 320, undefined]);
    // a rejected product has no thumbnail
    await thumb(ctx.s.vendorId, ctx.s.owner.token, '2').expect(404);
    // another store (its own owner, its own vendor id in the path): nothing
    const other = await setup();
    await thumb(other.s.vendorId, other.s.owner.token, '1').expect(404);
    await f
      .http()
      .get(`${base(ctx.s.vendorId)}/${r.body.batch_id}/thumbnails/1`)
      .set(auth(other.s.owner.token))
      .expect(403);
    // once expired: gone
    await prisma.importBatch.update({
      where: { id: r.body.batch_id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await thumb(ctx.s.vendorId, ctx.s.owner.token, '1')
      .expect(404)
      .expect((x) =>
        expect(JSON.parse((x.body as Buffer).toString()).error.code).toBe(
          'IMPORT_PREVIEW_GONE',
        ),
      );
  });

  it("the batch's screen: only the drafts this import created (never the store's other drafts), only the products chosen, with what was not created and why", async () => {
    const ctx = await setup();
    // another draft of the store, and another import
    await f
      .http()
      .post(`/api/v1/vendors/${ctx.s.vendorId}/offer-drafts`)
      .set(auth(ctx.s.owner.token))
      .send({ payload: { title_ar: 'مسودة يدوية' } })
      .expect(201);
    const otherImport = await simpleFiles(ctx, 'فستان من ملف آخر', 77);
    const o = await check(
      ctx.s.owner.token,
      ctx.s.vendorId,
      otherImport.xlsx,
      otherImport.zip,
    ).expect(200);
    await confirmOf(
      ctx.s.owner.token,
      ctx.s.vendorId,
      o.body,
    )({
      refs: ['1'],
    }).expect(201);

    const { xlsx, zip } = await storyFiles(ctx);
    const r = await check(ctx.s.owner.token, ctx.s.vendorId, xlsx, zip).expect(
      200,
    );
    // only the checked product «6» is created - «1» is ready but not chosen
    const ok = await confirmOf(
      ctx.s.owner.token,
      ctx.s.vendorId,
      r.body,
    )({
      refs: ['6'],
    }).expect(201);
    expect(ok.body.created.map((c: { ref: string }) => c.ref)).toEqual(['6']);
    const view = await f
      .http()
      .get(`${base(ctx.s.vendorId)}/${r.body.batch_id}?page=1&page_size=10`)
      .set(auth(ctx.s.owner.token))
      .expect(200);
    expect(view.body).toMatchObject({
      batch_id: r.body.batch_id,
      drafts_total: 1,
      counts: { open: 1, published: 0, closed: 0 },
      page: 1,
      pages: 1,
    });
    expect(view.body.items).toEqual([
      expect.objectContaining({
        id: ok.body.created[0].draft_id,
        ref: '6',
        title: 'بلوزة',
        state: 'OPEN',
        colors: 1,
        sizes: 1,
        branches: 1,
        images: 1,
      }),
    ]);
    expect(view.body.items[0].thumbnail).toMatch(
      new RegExp(`/vendors/${ctx.s.vendorId}/[0-9a-f]{32}\\.jpg$`),
    );
    const reasons = Object.fromEntries(
      view.body.not_created.map((x: { ref: string; reason: string }) => [
        x.ref,
        x.reason,
      ]),
    );
    expect(reasons).toMatchObject({ '1': 'NOT_CHOSEN', '2': 'REJECTED' });
    expect(
      view.body.not_created.find((x: { ref: string }) => x.ref === '2')
        .errors[0],
    ).toMatchObject({ code: 'IMAGE_FORMAT', value: 'HEIC' });
    // another store cannot read this batch
    const other = await setup();
    await f
      .http()
      .get(`${base(other.s.vendorId)}/${r.body.batch_id}`)
      .set(auth(other.s.owner.token))
      .expect(404);
  });

  it('the staging clean-up (independent of the draft clean-up flag): an expired check, an interrupted confirm (its public copies, unless a draft uses one), an orphan folder and a cut-short upload are removed; a new check replaces the previous one', async () => {
    const ctx = await setup();
    const sweep = app.get(ImportStagingSweepService);
    const checkSimple = async (title: string, picture: number) => {
      const x = await simpleFiles(ctx, title, picture);
      return check(ctx.s.owner.token, ctx.s.vendorId, x.xlsx, x.zip).expect(
        200,
      );
    };
    const status = async (id: string) =>
      (await prisma.importBatch.findUniqueOrThrow({ where: { id } })).status;

    const first = await checkSimple('فستان أول', 21);
    const second = await checkSimple('فستان ثان', 22);
    // one staging per store: the earlier check expired, its images gone
    expect(await status(first.body.batch_id)).toBe('EXPIRED');
    expect(existsSync(stagingDirOf(ctx.s.vendorId, first.body.batch_id))).toBe(
      false,
    );
    expect(
      filesIn(stagingDirOf(ctx.s.vendorId, second.body.batch_id)),
    ).toHaveLength(1);

    // an expired check
    await prisma.importBatch.update({
      where: { id: second.body.batch_id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await sweep.runOnce()).expired).toBeGreaterThanOrEqual(1);
    expect(await status(second.body.batch_id)).toBe('EXPIRED');
    expect(existsSync(stagingDirOf(ctx.s.vendorId, second.body.batch_id))).toBe(
      false,
    );

    // an interrupted confirm: two public copies, one already used by a draft
    const third = await checkSimple('فستان ثالث', 23);
    const pub = join(uploadsDir(), 'vendors', ctx.s.vendorId);
    mkdirSync(pub, { recursive: true });
    const lost = `${'a'.repeat(32)}.jpg`;
    const used = `${'b'.repeat(32)}.jpg`;
    writeFileSync(join(pub, lost), 'x');
    writeFileSync(join(pub, used), 'x');
    const usedUrl = ownUploadUrl(ctx.s.vendorId, used);
    await prisma.offerDraft.create({
      data: {
        vendorId: ctx.s.vendorId,
        createdByUserId: ctx.s.owner.userId,
        payload: { title_ar: 'مسودة', shared_images: [usedUrl] },
        uploads: [usedUrl],
      },
    });
    await prisma.importBatch.update({
      where: { id: third.body.batch_id },
      data: {
        status: 'CONFIRMING',
        confirmStartedAt: new Date(Date.now() - 20 * 60_000),
        plannedUploads: [lost, used],
      },
    });
    // an orphan staging folder and a cut-short upload, both old
    const orphan = stagingDirOf(ctx.s.vendorId, randomUUID());
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, 'x.jpg'), 'x');
    mkdirSync(incomingDir(), { recursive: true });
    const cut = join(incomingDir(), 'c'.repeat(32));
    writeFileSync(cut, 'x');
    const old = new Date(Date.now() - 2 * 3600_000);
    utimesSync(orphan, old, old);
    utimesSync(cut, old, old);

    expect((await sweep.runOnce()).undone).toBeGreaterThanOrEqual(1);
    expect(await status(third.body.batch_id)).toBe('EXPIRED');
    expect(existsSync(stagingDirOf(ctx.s.vendorId, third.body.batch_id))).toBe(
      false,
    );
    expect(existsSync(join(pub, lost))).toBe(false);
    expect(existsSync(join(pub, used))).toBe(true);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(cut)).toBe(false);
  });

  it('the same file again is warned (SHA-256) and needs an explicit choice; a likely duplicate is skipped unless chosen; an expired check is refused', async () => {
    const ctx = await setup();
    const files = await simpleFiles(ctx, 'فستان مكرر');
    const first = await check(
      ctx.s.owner.token,
      ctx.s.vendorId,
      files.xlsx,
      files.zip,
    ).expect(200);
    await confirmOf(
      ctx.s.owner.token,
      ctx.s.vendorId,
      first.body,
    )({
      refs: ['1'],
    }).expect(201);

    const again = await check(
      ctx.s.owner.token,
      ctx.s.vendorId,
      files.xlsx,
      files.zip,
    ).expect(200);
    expect(again.body.same_file).toMatchObject({
      batch_id: first.body.batch_id,
    });
    const p1 = again.body.products[0];
    expect(p1.duplicate_of).toMatchObject({
      kind: 'draft',
      title: 'فستان مكرر',
    });
    expect(p1.selected_by_default).toBe(false);
    const confirm = confirmOf(ctx.s.owner.token, ctx.s.vendorId, again.body);
    await confirm({ refs: ['1'] })
      .expect(409)
      .expect((x) => expect(x.body.error.code).toBe('IMPORT_SAME_FILE'));
    await confirm({ refs: ['1'], reimport_same_file: true })
      .expect(400)
      .expect((x) => expect(x.body.error.code).toBe('IMPORT_NOTHING_CHOSEN'));
    const ok = await confirm({
      refs: ['1'],
      reimport_same_file: true,
      include_duplicates: ['1'],
    }).expect(201);
    expect(ok.body.created).toHaveLength(1);

    const other = await simpleFiles(ctx, 'فستان آخر', 7);
    const third = await check(
      ctx.s.owner.token,
      ctx.s.vendorId,
      other.xlsx,
      other.zip,
    ).expect(200);
    await prisma.importBatch.update({
      where: { id: third.body.batch_id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await confirmOf(
      ctx.s.owner.token,
      ctx.s.vendorId,
      third.body,
    )({
      refs: ['1'],
    })
      .expect(409)
      .expect((x) => expect(x.body.error.code).toBe('IMPORT_EXPIRED'));
    expect(existsSync(stagingDirOf(ctx.s.vendorId, third.body.batch_id))).toBe(
      false,
    );
  });

  it('the product barcode column: one code for the whole product - valid kept on the draft; empty / wrong / repeated / used waits on the check (never refused): typed there or generated for the chosen ones, then the drafts', async () => {
    const ctx = await setup();
    // with the store's barcodes ON: an empty cell is still NOT a reason to refuse the row
    await prisma.featureFlag.upsert({
      where: { key: 'store_cashier_enabled' },
      create: {
        key: 'store_cashier_enabled',
        enabled: true,
        description: 'test',
      },
      update: { enabled: true },
    });
    // a product of the store that already carries 036000291452 (stored as its EAN form)
    const variant = await f.offer(ctx.s);
    const owned = await prisma.offerVariant.findUniqueOrThrow({
      where: { id: variant },
    });
    await prisma.offerBarcode.create({
      data: {
        vendorId: ctx.s.vendorId,
        vendorOfferId: owned.vendorOfferId,
        code: '0036000291452',
        format: 'UPCA',
        source: 'EXTERNAL',
        isPrimary: true,
        createdById: ctx.s.owner.userId,
      },
    });
    const header = [...PRODUCT_HEADER, 'الباركود'];
    const row = (ref: number, code: string | null) => [
      ...product(ref, `فستان ${ref}`),
      code,
    ];
    const codes: [number, string | null][] = [
      [1, '4006381333931'], // valid
      [2, '96385074'], // repeated in the file ...
      [3, '96385074'], // ... on two products
      [4, '4006381333932'], // wrong check digit
      [5, null], // empty
      [6, '036000291452'], // used by a product of this store
      [7, 'abc'], // not a barcode
    ];
    const xlsx = await workbook({
      المنتجات: [header, ...codes.map(([r, c]) => row(r, c))],
      'الألوان والمقاسات': [
        versionHeader(ctx.branches),
        ...codes.map(([r]) => version(r, 'أحمر', 'أحمر')),
      ],
      الصور: [
        IMAGE_HEADER,
        ...codes.map(([r]) => [r, 'أحمر', `p${r}.jpg`, 'رئيسية', null]),
      ],
    });
    const zip = makeZip(
      await Promise.all(
        codes.map(async ([r]) => ({ name: `p${r}.jpg`, data: await jpg(r) })),
      ),
    );
    const res = await check(
      ctx.s.owner.token,
      ctx.s.vendorId,
      xlsx,
      zip,
    ).expect(200);
    const by = (ref: string) =>
      res.body.products.find((p: { ref: string }) => p.ref === ref);
    const fixOf = (ref: string) =>
      by(ref).barcode_problems.map((e: { code: string }) => e.code);
    expect(by('1')).toMatchObject({
      status: 'ready',
      barcode: {
        code: '4006381333931',
        display_code: '4006381333931',
        format: 'EAN13',
        source: 'EXTERNAL',
      },
    });
    // a barcode problem never refuses the product: it waits on the check for its barcode
    for (const ref of ['2', '3', '4', '5', '6', '7']) {
      expect(by(ref)).toMatchObject({
        status: 'needs_barcode',
        errors: [],
        selectable: false,
        barcode: null,
      });
    }
    expect(fixOf('2')).toEqual(['BARCODE_DUPLICATE_IN_FILE']);
    expect(fixOf('3')).toEqual(['BARCODE_DUPLICATE_IN_FILE']);
    expect(fixOf('4')).toEqual(['BARCODE_CHECK_DIGIT']);
    expect(fixOf('5')).toEqual(['BARCODE_MISSING']);
    expect(fixOf('7')).toEqual(['BARCODE_INVALID']);
    expect(by('6').barcode_problems).toEqual([
      expect.objectContaining({
        code: 'BARCODE_ALREADY_USED',
        column: 'الباركود',
        value: expect.any(String),
      }),
    ]);
    // its thumbnail is there (its images are kept for its draft)
    await f
      .http()
      .get(`${base(ctx.s.vendorId)}/${res.body.batch_id}/thumbnails/5`)
      .set(auth(ctx.s.owner.token))
      .expect(200);
    // no draft for a product still without its barcode
    await confirmOf(
      ctx.s.owner.token,
      ctx.s.vendorId,
      res.body,
    )({ refs: ['1', '5'] })
      .expect(400)
      .expect((x) =>
        expect(x.body.error.code).toBe('IMPORT_PRODUCT_NEEDS_BARCODE'),
      );

    // fixed on the check: typed / scanned, checked at once (shape, the store, the file)
    const put = (ref: string, code: string, token = ctx.s.owner.token) =>
      f
        .http()
        .put(
          `${base(ctx.s.vendorId)}/${res.body.batch_id}/products/${ref}/barcode`,
        )
        .set(auth(token))
        .send({ code });
    await put('4', '4006381333932')
      .expect(400)
      .expect((x) => expect(x.body.error.code).toBe('BARCODE_CHECK_DIGIT'));
    await put('4', '4006381333931')
      .expect(409)
      .expect((x) =>
        expect(x.body.error.code).toBe('BARCODE_DUPLICATE_IN_FILE'),
      );
    await put('6', '036000291452')
      .expect(409)
      .expect((x) => expect(x.body.error.code).toBe('BARCODE_ALREADY_USED'));
    const two = await put('2', '96385074').expect(200);
    expect(two.body).toMatchObject({
      ref: '2',
      status: 'ready',
      selectable: true,
      barcode_problems: [],
      barcode: { code: '96385074', format: 'EAN8', source: 'EXTERNAL' },
    });
    await put('3', '96385074')
      .expect(409)
      .expect((x) =>
        expect(x.body.error.code).toBe('BARCODE_DUPLICATE_IN_FILE'),
      );
    const employee = await f.member(
      ctx.s.vendorId,
      await f.account(),
      'BRANCH_EMPLOYEE',
      ctx.branches[0].id,
    );
    await put('3', '5901234123457', employee.token).expect(403);

    // generated by the system: for the CHOSEN ones that still need one - never the others, never twice
    const generate = (refs: string[]) =>
      f
        .http()
        .post(`${base(ctx.s.vendorId)}/${res.body.batch_id}/barcodes/generate`)
        .set(auth(ctx.s.owner.token))
        .send({ refs })
        .expect(200);
    const gen = await generate(['3', '4', '5', '2']);
    expect(gen.body.products.map((p: { ref: string }) => p.ref)).toEqual([
      '3',
      '4',
      '5',
    ]);
    const generated: string[] = gen.body.products.map(
      (p: { barcode: { code: string } }) => p.barcode.code,
    );
    for (const p of gen.body.products)
      expect(p).toMatchObject({
        status: 'ready',
        barcode: { format: 'EAN13', source: 'GENERATED' },
      });
    for (const c of generated) expect(c).toMatch(/^29\d{11}$/);
    expect(new Set(generated).size).toBe(3);
    expect((await generate(['3'])).body.products).toEqual([]);

    // then the complete drafts - 6 and 7 (not completed) are not created, and say why
    const ok = await confirmOf(
      ctx.s.owner.token,
      ctx.s.vendorId,
      res.body,
    )({ refs: ['1', '2', '3', '4', '5'] }).expect(201);
    expect(
      ok.body.skipped
        .filter((x: { reason: string }) => x.reason === 'NEEDS_BARCODE')
        .map((x: { ref: string }) => x.ref)
        .sort(),
    ).toEqual(['6', '7']);
    const drafts = await prisma.offerDraft.findMany({
      where: { importBatchId: res.body.batch_id },
    });
    const sb = (ref: string) =>
      (
        drafts.find((d) => d.importRef === ref)!.payload as {
          store_barcode?: unknown;
        }
      ).store_barcode;
    expect(sb('1')).toEqual({ mode: 'external', code: '4006381333931' });
    expect(sb('2')).toEqual({ mode: 'external', code: '96385074' });
    expect(sb('3')).toEqual({ mode: 'generate', code: generated[0] });
    expect(sb('5')).toEqual({ mode: 'generate', code: generated[2] });
    // nothing attached before publishing
    expect(
      await prisma.offerBarcode.count({ where: { vendorId: ctx.s.vendorId } }),
    ).toBe(1);
    // the check cannot change any more
    await put('6', '5901234123457')
      .expect(409)
      .expect((x) =>
        expect(x.body.error.code).toBe('IMPORT_ALREADY_CONFIRMED'),
      );
    // the batch: each card's barcode, and every draft's label (for «إضافة ملصقات المحدد»)
    const view = (
      await f
        .http()
        .get(`${base(ctx.s.vendorId)}/${res.body.batch_id}`)
        .set(auth(ctx.s.owner.token))
        .expect(200)
    ).body;
    const cardOf = (ref: string) =>
      view.items.find((i: { ref: string }) => i.ref === ref);
    expect(cardOf('1').barcode).toEqual({
      code: '4006381333931',
      display_code: '4006381333931',
      format: 'EAN13',
      source: 'EXTERNAL',
    });
    expect(cardOf('4').barcode).toMatchObject({ source: 'GENERATED' });
    expect(view.labels).toHaveLength(5);
    expect(view.labels[0]).toMatchObject({
      title_ar: expect.any(String),
      price: expect.any(Number),
      code: expect.any(String),
      format: expect.any(String),
    });
    expect(
      view.not_created
        .filter((x: { reason: string }) => x.reason === 'NEEDS_BARCODE')
        .map((x: { ref: string }) => x.ref)
        .sort(),
    ).toEqual(['6', '7']);
    await prisma.featureFlag.update({
      where: { key: 'store_cashier_enabled' },
      data: { enabled: false },
    });
  });

  it('only the owner; .xlsx only; a missing «الصور» sheet rejects every product and is said', async () => {
    const ctx = await setup();
    const files = await simpleFiles(ctx, 'فستان');
    const employee = await f.member(
      ctx.s.vendorId,
      await f.account(),
      'BRANCH_EMPLOYEE',
      ctx.branches[0].id,
    );
    await check(employee.token, ctx.s.vendorId, files.xlsx, files.zip).expect(
      403,
    );
    await f
      .http()
      .get(`${base(ctx.s.vendorId)}/template`)
      .set(auth(employee.token))
      .expect(403);
    await check(
      ctx.s.owner.token,
      ctx.s.vendorId,
      Buffer.from('a,b\n1,2', 'utf-8'),
      files.zip,
      { xlsx: 'products.csv', zip: 'images.zip' },
    )
      .expect(400)
      .expect((x) => expect(x.body.error.code).toBe('IMPORT_XLSX_ONLY'));
    const noImages = await check(
      ctx.s.owner.token,
      ctx.s.vendorId,
      await workbook({
        المنتجات: [PRODUCT_HEADER, product(1, 'فستان')],
        'الألوان والمقاسات': [
          versionHeader(ctx.branches),
          version(1, 'أحمر', 'أحمر'),
        ],
      }),
      files.zip,
    ).expect(200);
    expect(noImages.body.file_problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'SHEET_MISSING', value: 'الصور' }),
      ]),
    );
    expect(noImages.body.products[0].errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'IMAGES_SHEET_INVALID' }),
      ]),
    );
    expect(noImages.body.zip.unused).toEqual(['a.jpg']);
  });

  it("the file's words match the wizard's (specifications, their values, measurements)", () => {
    const web = readFileSync(
      join(API_ROOT, '..', 'web', 'src', 'lib', 'specCodes.ts'),
      'utf8',
    );
    for (const values of Object.values(SPEC_VALUE_WORDS))
      for (const [code, w] of Object.entries(values))
        expect(web).toContain(`c("${code}", "${w.ar}", "${w.en}")`);
    const text = readFileSync(
      join(API_ROOT, '..', 'web', 'src', 'lib', 'offerWizardText.ts'),
      'utf8',
    );
    for (const [key, w] of Object.entries(SPEC_FIELD_WORDS)) {
      expect(text).toContain(`"wz.spec.${key}": "${w.ar}"`);
      expect(text).toContain(`"wz.spec.${key}": "${w.en}"`);
    }
    for (const [key, w] of Object.entries(MEASURE_WORDS)) {
      expect(text).toContain(`"wz.key.${key}": "${w.ar}"`);
      expect(text).toContain(`"wz.key.${key}": "${w.en}"`);
    }
    void prisma;
  });
});
