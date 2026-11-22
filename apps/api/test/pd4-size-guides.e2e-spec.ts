import { execFileSync } from 'child_process';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { ProductAudience } from '../generated/prisma/client';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { CURRENT_PLATFORM_TERMS_VERSION } from './../src/checkout/checkout.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { API_ROOT } from './helpers/seed-demo-db';
import {
  createDisposableDatabase,
  dropDisposableDatabase,
} from './helpers/test-databases';
import { uniqueTestPhone } from './helpers/test-phone';

// PD-4 (docs/srs/10-product-detail-enhancement-roadmap.md, PD-FR-003):
// platform size guides - admin lifecycle and immutable versions,
// applicability, the owner's choice and requests, the publish gate,
// public reads and the checkout snapshot.
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

const DRESS_ROWS = [
  {
    size_code: 'S',
    values: { CHEST: { min: 84, max: 88 }, WAIST: { min: 66, max: 70 } },
  },
  {
    size_code: 'M',
    values: { CHEST: { min: 88, max: 92 }, WAIST: { min: 70, max: 74 } },
  },
  {
    size_code: 'L',
    values: { CHEST: { min: 92, max: 98 }, WAIST: { min: 74, max: 80 } },
  },
];
const TWO_COLUMNS = [
  { key: 'CHEST', is_range: true },
  { key: 'WAIST', is_range: true },
];

describe('PD-4 size guides (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  // Size guides are ONE platform-wide catalog: a guide this file publishes
  // (women's dresses S/M/L) applies to every offer of that category, so on
  // the shared database it blocked publishing in any file that ran
  // alongside or after it (offer-drafts' evening dress: «size_guide»). The
  // file therefore runs on a database of its own, created marked and
  // dropped after its marker is checked (as tb5-lock-order does).
  const sharedUrl = process.env.DATABASE_URL!;
  const dbName = `finalpro_pd4guides_test_${process.pid}`;

  beforeAll(async () => {
    const url = await createDisposableDatabase(sharedUrl, dbName);
    execFileSync(
      process.execPath,
      [
        require.resolve('prisma/build/index.js'),
        'migrate',
        'deploy',
        '--config',
        'prisma7.config.ts',
      ],
      {
        cwd: API_ROOT,
        env: { ...process.env, DATABASE_URL: url },
        stdio: 'pipe',
        timeout: 120_000,
      },
    );
    // PrismaService reads DATABASE_URL when each test builds the app below.
    process.env.DATABASE_URL = url;
  }, 180_000);

  afterAll(async () => {
    process.env.DATABASE_URL = sharedUrl;
    await dropDisposableDatabase(sharedUrl, dbName);
  }, 120_000);

  beforeEach(async () => {
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
    // The tests of this file share one database: each one starts with
    // no standard guide applying anywhere (earlier guides stay, unused).
    await prisma.sizeGuideApplicability.deleteMany({});
  });

  afterEach(async () => {
    await app.close();
  });

  const http = () => app.getHttpServer();
  const call = (
    method: 'get' | 'post' | 'put' | 'patch',
    url: string,
    token: string | null,
  ) => {
    let r = request(http())[method](`/api/v1${url}`);
    if (method !== 'get') r = r.set('Idempotency-Key', unique('idem'));
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };

  async function account(platformRole?: 'PLATFORM_ADMIN') {
    const phone = uniqueTestPhone();
    const user = await prisma.user.create({
      data: {
        phone,
        passwordHash: 'not-used',
        phoneVerifiedAt: new Date(),
        platformRole,
      },
    });
    const profile = await prisma.customerProfile.create({
      data: { userId: user.id },
    });
    const token = await app.get(SessionService).create({
      userId: user.id,
      phone,
      phoneVerifiedAt: user.phoneVerifiedAt!.toISOString(),
      sessionVersion: user.sessionVersion,
    });
    return { token, userId: user.id, customerId: profile.id };
  }

  async function store() {
    const owner = await account();
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('sg-store').toLowerCase(),
        legalName: unique('Legal'),
        displayName: 'متجر الأدلة',
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        storefrontPublished: true,
      },
    });
    await prisma.vendorUser.create({
      data: { userId: owner.userId, vendorId: vendor.id, role: 'OWNER' },
    });
    const branch = await prisma.storeBranch.create({
      data: {
        vendorId: vendor.id,
        name: unique('فرع'),
        isPhysical: true,
        verificationStatus: 'APPROVED',
      },
    });
    const employee = await account();
    await prisma.vendorUser.create({
      data: {
        userId: employee.userId,
        vendorId: vendor.id,
        role: 'BRANCH_EMPLOYEE',
        branchId: branch.id,
      },
    });
    return { vendor, branch, owner, employee };
  }
  type Store = Awaited<ReturnType<typeof store>>;

  async function canonical() {
    const brand = await prisma.brand.create({
      data: { name: unique('Brand'), normalizedName: unique('b') },
    });
    const category = await prisma.category.create({
      data: { nameAr: unique('فئة'), nameEn: unique('C') },
    });
    const product = await prisma.canonicalProduct.create({
      data: {
        brandId: brand.id,
        categoryId: category.id,
        modelName: unique('M'),
        canonicalNameAr: 'منتج',
        status: 'PUBLISHED',
      },
    });
    return { brand, product };
  }

  /** A classified offer (DRAFT or ACTIVE) with these sizes, publishable otherwise. */
  async function offer(
    s: Store,
    o: {
      audiences: ProductAudience[];
      category: string;
      sizes: (string | null)[];
      status?: 'DRAFT' | 'ACTIVE';
    },
  ) {
    const c = await canonical();
    const created = await prisma.vendorOffer.create({
      data: {
        vendorId: s.vendor.id,
        titleAr: 'قطعة',
        titleEn: 'Item',
        status: 'DRAFT',
        brandId: c.brand.id,
        canonicalProductId: c.product.id,
        taxonomyVersion: 1,
        requiresTaxonomy: true,
      },
    });
    for (const audience of o.audiences) {
      await prisma.vendorOfferAudience.create({
        data: { vendorId: s.vendor.id, vendorOfferId: created.id, audience },
      });
    }
    await prisma.vendorOfferCategory.create({
      data: {
        vendorId: s.vendor.id,
        vendorOfferId: created.id,
        categoryCode: o.category,
      },
    });
    const ids: Record<string, string> = {};
    let n = 0;
    for (const size of o.sizes) {
      n += 1;
      const cv = await prisma.canonicalProductVariant.create({
        data: {
          canonicalProductId: c.product.id,
          structuralAttributes: { n: unique('v') },
          platformProductBarcode: unique('pb'),
        },
      });
      const v = await prisma.offerVariant.create({
        data: {
          vendorId: s.vendor.id,
          vendorOfferId: created.id,
          sellerSku: unique('sku'),
          storeInventoryBarcode: unique('sib'),
          basePrice: 100,
          isCombination: true,
          colorCode: 'BLACK',
          sizeCode: size,
          canonicalVariantId: cv.id,
        },
      });
      await prisma.branchStock.create({
        data: {
          vendorId: s.vendor.id,
          branchId: s.branch.id,
          offerVariantId: v.id,
          quantity: 20,
        },
      });
      if (n === 1) {
        await prisma.offerVariantMedia.create({
          data: {
            vendorId: s.vendor.id,
            offerVariantId: v.id,
            url: 'https://example.com/a.jpg',
            kind: 'PRIMARY',
            mediaType: 'IMAGE',
            sortOrder: 0,
          },
        });
      }
      ids[size ?? 'none'] = v.id;
    }
    if (o.status !== 'DRAFT') {
      await prisma.vendorOffer.update({
        where: { id: created.id },
        data: { status: 'ACTIVE' },
      });
    }
    return { offerId: created.id, ids, canonicalProductId: c.product.id };
  }

  /** Creates, fills, (optionally) applies and publishes a guide as an administrator. */
  async function guide(
    admin: { token: string },
    g: {
      kind?: 'STANDARD' | 'PRODUCT';
      canonicalProductId?: string;
      rows?: typeof DRESS_ROWS;
      measurements?: typeof TWO_COLUMNS;
      pairs?: {
        category_code: string;
        audience: ProductAudience;
        is_default: boolean;
      }[];
      publish?: boolean;
      basis?: 'BODY' | 'GARMENT';
    },
  ) {
    const created = await call('post', '/admin/size-guides', admin.token)
      .send({
        code: unique('guide').toLowerCase(),
        name_ar: 'دليل',
        name_en: 'Guide',
        kind: g.kind ?? 'STANDARD',
        ...(g.canonicalProductId
          ? { canonical_product_id: g.canonicalProductId }
          : {}),
        ...(g.basis ? { basis: g.basis } : {}),
      })
      .expect(201);
    const id = created.body.id as string;
    if (g.pairs)
      await call('put', `/admin/size-guides/${id}/applicability`, admin.token)
        .send({ pairs: g.pairs })
        .expect(200);
    const draftId = created.body.draft_version.id as string;
    await call(
      'put',
      `/admin/size-guides/${id}/versions/${draftId}`,
      admin.token,
    )
      .send({
        basis: g.basis ?? 'BODY',
        measurements: g.measurements ?? TWO_COLUMNS,
        rows: g.rows ?? DRESS_ROWS,
        notes_ar: 'قيسي حول أعرض جزء من الصدر',
      })
      .expect(200);
    if (g.publish !== false) {
      await call(
        'post',
        `/admin/size-guides/${id}/versions/${draftId}/publish`,
        admin.token,
      ).expect(200);
    }
    return { id, versionId: draftId };
  }

  const WOMEN_DRESSES = [
    {
      category_code: 'DRESSES_WOMEN',
      audience: 'WOMEN' as ProductAudience,
      is_default: true,
    },
  ];

  describe('4.1/4.2 administration, versions and validation', () => {
    it('PLATFORM_ADMIN only: owner, employee and customer get 403; a guest 401', async () => {
      const s = await store();
      const customer = await account();
      for (const t of [s.owner.token, s.employee.token, customer.token]) {
        await call('get', '/admin/size-guides', t).expect(403);
        await call('post', '/admin/size-guides', t)
          .send({
            code: 'x-guide',
            name_ar: 'x',
            name_en: 'x',
            kind: 'STANDARD',
          })
          .expect(403);
      }
      await call('get', '/admin/size-guides', null).expect(401);
    });

    it('drafts are validated; publishing needs a complete, never-decreasing table; published versions are immutable', async () => {
      const admin = await account('PLATFORM_ADMIN');
      const g = await guide(admin, { pairs: WOMEN_DRESSES, publish: false });
      const put = (body: object) =>
        call(
          'put',
          `/admin/size-guides/${g.id}/versions/${g.versionId}`,
          admin.token,
        ).send(body);
      expect(
        (
          await put({
            basis: 'GARMENT',
            measurements: TWO_COLUMNS,
            rows: DRESS_ROWS,
          }).expect(400)
        ).body.error.code,
      ).toBe('BASIS_NOT_ALLOWED');
      expect(
        (
          await put({
            basis: 'BODY',
            measurements: TWO_COLUMNS,
            rows: [
              { size_code: 'M', values: { CHEST: { min: 300, max: 310 } } },
            ],
          }).expect(400)
        ).body.error.code,
      ).toBe('SIZE_VALUE_OUT_OF_RANGE');
      expect(
        (
          await put({
            basis: 'BODY',
            measurements: TWO_COLUMNS,
            rows: [{ size_code: 'AGE_4_5Y', values: {} }],
          }).expect(400)
        ).body.error.code,
      ).toBe('SIZE_GROUP_NOT_ALLOWED');
      expect(
        (
          await put({
            basis: 'BODY',
            measurements: [{ key: 'NECK', is_range: true }],
            rows: DRESS_ROWS,
          }).expect(400)
        ).body.error.code,
      ).toBeDefined();
      // An incomplete draft saves, but does not publish.
      await put({
        basis: 'BODY',
        measurements: TWO_COLUMNS,
        rows: [{ size_code: 'S', values: { CHEST: { min: 84, max: 88 } } }],
      }).expect(200);
      const incomplete = await call(
        'post',
        `/admin/size-guides/${g.id}/versions/${g.versionId}/publish`,
        admin.token,
      ).expect(400);
      expect(incomplete.body.error.code).toBe('SIZE_GUIDE_INCOMPLETE');
      await put({
        basis: 'BODY',
        measurements: TWO_COLUMNS,
        rows: [
          {
            size_code: 'S',
            values: {
              CHEST: { min: 90, max: 94 },
              WAIST: { min: 66, max: 70 },
            },
          },
          {
            size_code: 'M',
            values: {
              CHEST: { min: 88, max: 92 },
              WAIST: { min: 70, max: 74 },
            },
          },
        ],
      }).expect(200);
      expect(
        (
          await call(
            'post',
            `/admin/size-guides/${g.id}/versions/${g.versionId}/publish`,
            admin.token,
          ).expect(400)
        ).body.error.code,
      ).toBe('SIZE_VALUES_NOT_MONOTONIC');
      await put({
        basis: 'BODY',
        measurements: TWO_COLUMNS,
        rows: DRESS_ROWS,
      }).expect(200);
      const published = await call(
        'post',
        `/admin/size-guides/${g.id}/versions/${g.versionId}/publish`,
        admin.token,
      ).expect(200);
      expect(published.body.published_version.version).toBe(1);
      expect(
        published.body.published.rows.map(
          (r: { size_code: string }) => r.size_code,
        ),
      ).toEqual(['S', 'M', 'L']);
      // Immutable: through the API and in the database itself.
      expect(
        (
          await put({
            basis: 'BODY',
            measurements: TWO_COLUMNS,
            rows: DRESS_ROWS,
          }).expect(409)
        ).body.error.code,
      ).toBe('SIZE_GUIDE_VERSION_IMMUTABLE');
      await expect(
        prisma.sizeGuideCell.updateMany({
          where: { row: { versionId: g.versionId } },
          data: { minTenths: 850 },
        }),
      ).rejects.toThrow(/SIZE_GUIDE_VERSION_IMMUTABLE/);
      await expect(
        prisma.sizeGuideVersion.update({
          where: { id: g.versionId },
          data: { notesAr: 'تغيير' },
        }),
      ).rejects.toThrow(/SIZE_GUIDE_VERSION_IMMUTABLE/);
      // A new draft copies the published content; publishing it retires v1.
      const v2 = await call(
        'post',
        `/admin/size-guides/${g.id}/versions`,
        admin.token,
      ).expect(201);
      expect(v2.body.draft.rows).toHaveLength(3);
      await call(
        'post',
        `/admin/size-guides/${g.id}/versions`,
        admin.token,
      ).expect(409);
      await call(
        'post',
        `/admin/size-guides/${g.id}/versions/${v2.body.draft_version.id}/publish`,
        admin.token,
      ).expect(200);
      const versions = await prisma.sizeGuideVersion.findMany({
        where: { guideId: g.id },
        orderBy: { version: 'asc' },
      });
      expect(versions.map((v) => v.status)).toEqual(['RETIRED', 'PUBLISHED']);
      // Retiring the guide withdraws it everywhere.
      await call(
        'post',
        `/admin/size-guides/${g.id}/retire`,
        admin.token,
      ).expect(200);
      await call(
        'post',
        `/admin/size-guides/${g.id}/retire`,
        admin.token,
      ).expect(409);
      expect(
        await prisma.sizeGuideVersion.count({
          where: { guideId: g.id, status: 'PUBLISHED' },
        }),
      ).toBe(0);
      const actions = (
        await prisma.auditLog.findMany({
          where: { entityId: g.id },
          select: { action: true },
        })
      ).map((a) => a.action);
      for (const a of [
        'size_guide.created',
        'size_guide.applicability_set',
        'size_guide.draft_saved',
        'size_guide.published',
        'size_guide.version_created',
        'size_guide.retired',
      ]) {
        expect(actions).toContain(a);
      }
    });

    it('applicability: real pairs only, one size group, one default per pair; product guides are separate', async () => {
      const admin = await account('PLATFORM_ADMIN');
      const a = await guide(admin, { pairs: WOMEN_DRESSES });
      const b = await guide(admin, { publish: false });
      const set = (id: string, pairs: object[]) =>
        call('put', `/admin/size-guides/${id}/applicability`, admin.token).send(
          { pairs },
        );
      expect(
        (
          await set(b.id, [
            {
              category_code: 'DRESSES_WOMEN',
              audience: 'MEN',
              is_default: false,
            },
          ]).expect(400)
        ).body.error.code,
      ).toBe('UNKNOWN_CATEGORY_AUDIENCE');
      expect(
        (
          await set(b.id, [
            { category_code: 'JEANS', audience: 'WOMEN', is_default: false },
            { category_code: 'JEANS', audience: 'KIDS', is_default: false },
          ]).expect(400)
        ).body.error.code,
      ).toBe('SIZE_GROUP_NOT_ALLOWED');
      expect((await set(b.id, WOMEN_DRESSES).expect(409)).body.error.code).toBe(
        'DEFAULT_GUIDE_EXISTS',
      );
      await set(b.id, [
        {
          category_code: 'DRESSES_WOMEN',
          audience: 'WOMEN',
          is_default: false,
        },
      ]).expect(200);
      // Adult rows can't be moved onto a kids audience.
      expect(
        (
          await set(a.id, [
            {
              category_code: 'GIRLS_DRESSES',
              audience: 'KIDS',
              is_default: true,
            },
          ]).expect(400)
        ).body.error.code,
      ).toBe('SIZE_GROUP_NOT_ALLOWED');
      // PRODUCT guides: one per canonical product, may measure the garment, no applicability.
      const c = await canonical();
      const p = await guide(admin, {
        kind: 'PRODUCT',
        canonicalProductId: c.product.id,
        basis: 'GARMENT',
      });
      expect((await set(p.id, WOMEN_DRESSES).expect(409)).body.error.code).toBe(
        'NOT_A_STANDARD_GUIDE',
      );
      const dup = await call('post', '/admin/size-guides', admin.token)
        .send({
          code: unique('dup').toLowerCase(),
          name_ar: 'x',
          name_en: 'x',
          kind: 'PRODUCT',
          canonical_product_id: c.product.id,
        })
        .expect(409);
      expect(dup.body.error.code).toBe('PRODUCT_GUIDE_EXISTS');
      await call('post', '/admin/size-guides', admin.token)
        .send({
          code: 'BAD CODE',
          name_ar: 'x',
          name_en: 'x',
          kind: 'STANDARD',
        })
        .expect(400);
    });
  });

  describe('4.4 public reads and the product-page contract', () => {
    it('no published guide: no link and no guide; a draft is never shown', async () => {
      const s = await store();
      const o = await offer(s, {
        audiences: ['WOMEN'],
        category: 'DRESSES_WOMEN',
        sizes: ['S', 'M'],
      });
      const admin = await account('PLATFORM_ADMIN');
      const draft = await guide(admin, {
        pairs: WOMEN_DRESSES,
        publish: false,
      });
      const detail = await call(
        'get',
        `/storefronts/${s.vendor.slug}/offers/${o.offerId}`,
        null,
      ).expect(200);
      expect(detail.body.size_guide_available).toBe(false);
      expect(
        (
          await call(
            'get',
            `/storefronts/${s.vendor.slug}/offers/${o.offerId}/size-guide`,
            null,
          ).expect(200)
        ).body.guides,
      ).toEqual([]);
      await call('get', `/size-guides/${draft.id}`, null).expect(404);
    });

    it('a published guide is offered and readable by anyone; retiring removes it', async () => {
      const s = await store();
      const o = await offer(s, {
        audiences: ['WOMEN'],
        category: 'DRESSES_WOMEN',
        sizes: ['S', 'M'],
      });
      const admin = await account('PLATFORM_ADMIN');
      const g = await guide(admin, { pairs: WOMEN_DRESSES });
      expect(
        (
          await call(
            'get',
            `/storefronts/${s.vendor.slug}/offers/${o.offerId}`,
            null,
          ).expect(200)
        ).body.size_guide_available,
      ).toBe(true);
      const res = await call(
        'get',
        `/storefronts/${s.vendor.slug}/offers/${o.offerId}/size-guide`,
        null,
      ).expect(200);
      expect(res.body.guides).toHaveLength(1);
      expect(res.body.guides[0]).toMatchObject({
        id: g.id,
        audiences: ['WOMEN'],
        basis: 'BODY',
        unit: 'cm',
        notes_ar: 'قيسي حول أعرض جزء من الصدر',
        measurements: [
          { key: 'CHEST', label_ar: 'الصدر', is_range: true },
          { key: 'WAIST', label_ar: 'الخصر', is_range: true },
        ],
      });
      expect(res.body.guides[0].rows[1]).toEqual({
        size_code: 'M',
        size_label: 'M',
        size_group: 'ADULT',
        values: { CHEST: { min: 88, max: 92 }, WAIST: { min: 70, max: 74 } },
      });
      expect(res.body.sizes_not_in_guide).toEqual([]);
      expect(
        (await call('get', `/size-guides/${g.id}`, null).expect(200)).body
          .version,
      ).toBe(1);
      expect(JSON.stringify(res.body)).not.toMatch(
        /createdById|publishedById|phone/,
      );
      await call(
        'post',
        `/admin/size-guides/${g.id}/retire`,
        admin.token,
      ).expect(200);
      expect(
        (
          await call(
            'get',
            `/storefronts/${s.vendor.slug}/offers/${o.offerId}`,
            null,
          ).expect(200)
        ).body.size_guide_available,
      ).toBe(false);
      // Accessories / unsized offers never get a link.
      const bag = await offer(s, {
        audiences: ['WOMEN'],
        category: 'BAGS',
        sizes: [null],
      });
      expect(
        (
          await call(
            'get',
            `/storefronts/${s.vendor.slug}/offers/${bag.offerId}`,
            null,
          ).expect(200)
        ).body.size_guide_available,
      ).toBe(false);
    });

    it('multi-audience offers get one guide per audience; a product guide replaces them all', async () => {
      const s = await store();
      const o = await offer(s, {
        audiences: ['WOMEN', 'KIDS'],
        category: 'JEANS',
        sizes: ['M', 'AGE_4_5Y'],
      });
      const admin = await account('PLATFORM_ADMIN');
      const women = await guide(admin, {
        pairs: [
          { category_code: 'JEANS', audience: 'WOMEN', is_default: true },
        ],
      });
      const kids = await guide(admin, {
        pairs: [{ category_code: 'JEANS', audience: 'KIDS', is_default: true }],
        measurements: [{ key: 'HEIGHT', is_range: true }],
        rows: [
          { size_code: 'AGE_4_5Y', values: { HEIGHT: { min: 104, max: 110 } } },
        ] as never,
      });
      const res = await call(
        'get',
        `/storefronts/${s.vendor.slug}/offers/${o.offerId}/size-guide`,
        null,
      ).expect(200);
      expect(
        res.body.guides.map((g: { id: string; audiences: string[] }) => [
          g.id,
          g.audiences,
        ]),
      ).toEqual([
        [women.id, ['WOMEN']],
        [kids.id, ['KIDS']],
      ]);
      const product = await guide(admin, {
        kind: 'PRODUCT',
        canonicalProductId: o.canonicalProductId,
        rows: DRESS_ROWS,
      });
      const after = await call(
        'get',
        `/storefronts/${s.vendor.slug}/offers/${o.offerId}/size-guide`,
        null,
      ).expect(200);
      expect(after.body.guides.map((g: { id: string }) => g.id)).toEqual([
        product.id,
      ]);
      expect(after.body.guides[0].audiences).toEqual(['WOMEN', 'KIDS']);
    });
  });

  describe('closing round: accessories and offers a guide cannot describe', () => {
    it('no link for accessories: no applicability, no request, and a stray old link is ignored', async () => {
      const s = await store();
      const admin = await account('PLATFORM_ADMIN');
      const g = await guide(admin, { pairs: WOMEN_DRESSES });
      // The API refuses to link a guide to an accessory category.
      const refused = await call(
        'put',
        `/admin/size-guides/${g.id}/applicability`,
        admin.token,
      )
        .send({
          pairs: [
            ...WOMEN_DRESSES,
            { category_code: 'BAGS', audience: 'WOMEN', is_default: true },
            { category_code: 'WATCHES', audience: 'WOMEN', is_default: false },
          ],
        })
        .expect(400);
      expect(refused.body.error.code).toBe('CATEGORY_NOT_SIZED');
      expect(refused.body.error.details).toEqual(['BAGS', 'WATCHES']);

      // Old/odd data: a bag listed with S/M, a link written straight to the
      // database, and a product guide for its canonical product.
      const bag = await offer(s, {
        audiences: ['WOMEN'],
        category: 'BAGS',
        sizes: ['S', 'M'],
      });
      await prisma.sizeGuideApplicability.create({
        data: {
          guideId: g.id,
          categoryCode: 'BAGS',
          audience: 'WOMEN',
          isDefault: true,
        },
      });
      await guide(admin, {
        kind: 'PRODUCT',
        canonicalProductId: bag.canonicalProductId,
        rows: DRESS_ROWS,
      });
      const detail = await call(
        'get',
        `/storefronts/${s.vendor.slug}/offers/${bag.offerId}`,
        null,
      ).expect(200);
      expect(detail.body.size_guide_available).toBe(false);
      const pub = await call(
        'get',
        `/storefronts/${s.vendor.slug}/offers/${bag.offerId}/size-guide`,
        null,
      ).expect(200);
      expect(pub.body.guides).toEqual([]);
      expect(pub.body.sizes_not_in_guide).toEqual([]);

      // The owner can't ask for one either.
      const view = await call(
        'get',
        `/vendors/${s.vendor.id}/offers/${bag.offerId}/size-guide`,
        s.owner.token,
      ).expect(200);
      expect(view.body.size_guide_eligible).toBe(false);
      expect(view.body.guides).toEqual([]);
      const req = await call(
        'post',
        `/vendors/${s.vendor.id}/offers/${bag.offerId}/size-guide-requests`,
        s.owner.token,
      )
        .send({ message: 'نريد دليلاً للحقيبة' })
        .expect(409);
      expect(req.body.error.code).toBe('OFFER_NOT_SIZED');

      // The taxonomy says which categories take a guide.
      const tax = await call('get', '/taxonomy', null).expect(200);
      const flag = (code: string) =>
        tax.body.categories.find((c: { code: string }) => c.code === code)
          .size_guide;
      expect([flag('DRESSES_WOMEN'), flag('SHOES'), flag('BAGS')]).toEqual([
        true,
        true,
        false,
      ]);
    });

    it("a guide that describes none of the offer's sizes is not offered (ONE_SIZE only)", async () => {
      const s = await store();
      const admin = await account('PLATFORM_ADMIN');
      await guide(admin, { pairs: WOMEN_DRESSES });
      const one = await offer(s, {
        audiences: ['WOMEN'],
        category: 'DRESSES_WOMEN',
        sizes: ['ONE_SIZE'],
      });
      expect(
        (
          await call(
            'get',
            `/storefronts/${s.vendor.slug}/offers/${one.offerId}`,
            null,
          ).expect(200)
        ).body.size_guide_available,
      ).toBe(false);
      expect(
        (
          await call(
            'get',
            `/storefronts/${s.vendor.slug}/offers/${one.offerId}/size-guide`,
            null,
          ).expect(200)
        ).body.guides,
      ).toEqual([]);
    });
  });

  describe('4.3 owner: view, choice and requests (OWNER only)', () => {
    it('the owner sees options and compatibility, chooses only an applicable published guide; employee and other stores are refused', async () => {
      const s = await store();
      const other = await store();
      const o = await offer(s, {
        audiences: ['WOMEN'],
        category: 'DRESSES_WOMEN',
        sizes: ['S', 'M', 'XL'],
      });
      const admin = await account('PLATFORM_ADMIN');
      const def = await guide(admin, { pairs: WOMEN_DRESSES });
      const alt = await guide(admin, {
        pairs: [
          {
            category_code: 'DRESSES_WOMEN',
            audience: 'WOMEN',
            is_default: false,
          },
        ],
      });
      const unrelated = await guide(admin, {
        pairs: [
          { category_code: 'SKIRTS', audience: 'WOMEN', is_default: true },
        ],
      });
      const url = `/vendors/${s.vendor.id}/offers/${o.offerId}/size-guide`;
      const view = await call('get', url, s.owner.token).expect(200);
      expect(
        view.body.options[0].guides.map((g: { id: string }) => g.id).sort(),
      ).toEqual([def.id, alt.id].sort());
      expect(view.body.guides[0].id).toBe(def.id);
      expect(view.body.compatibility).toEqual({
        checked: true,
        mismatched_sizes: ['XL'],
        one_size_exempt: false,
      });
      await call('get', url, s.employee.token).expect(403);
      await call('put', url, s.employee.token)
        .send({ size_guide_id: alt.id })
        .expect(403);
      await call('get', url, other.owner.token).expect(403);
      await call(
        'get',
        `/vendors/${other.vendor.id}/offers/${o.offerId}/size-guide`,
        other.owner.token,
      ).expect(404);
      expect(
        (
          await call('put', url, s.owner.token)
            .send({ size_guide_id: unrelated.id })
            .expect(409)
        ).body.error.code,
      ).toBe('SIZE_GUIDE_NOT_APPLICABLE');
      const chosen = await call('put', url, s.owner.token)
        .send({ size_guide_id: alt.id })
        .expect(200);
      expect(chosen.body.chosen_guide_id).toBe(alt.id);
      expect(chosen.body.guides[0].id).toBe(alt.id);
      await call('put', url, s.owner.token)
        .send({ size_guide_id: null })
        .expect(200);
      expect(
        await prisma.auditLog.count({
          where: { entityId: o.offerId, action: 'offer.size_guide_chosen' },
        }),
      ).toBe(2);
      // A product guide can't be overridden by a store.
      await guide(admin, {
        kind: 'PRODUCT',
        canonicalProductId: o.canonicalProductId,
      });
      expect(
        (
          await call('put', url, s.owner.token)
            .send({ size_guide_id: alt.id })
            .expect(409)
        ).body.error.code,
      ).toBe('PRODUCT_GUIDE_APPLIES');
    });

    it('guide requests: owner only, one pending per offer, the administrator rejects with a note or resolves with a real guide', async () => {
      const s = await store();
      const o = await offer(s, {
        audiences: ['WOMEN'],
        category: 'DRESSES_WOMEN',
        sizes: ['S'],
      });
      const admin = await account('PLATFORM_ADMIN');
      const reqUrl = `/vendors/${s.vendor.id}/offers/${o.offerId}/size-guide-requests`;
      await call('post', reqUrl, s.employee.token)
        .send({ message: 'نحتاج دليلاً' })
        .expect(403);
      const first = await call('post', reqUrl, s.owner.token)
        .send({ message: 'مقاسات هذه الماركة أصغر' })
        .expect(201);
      expect(
        (
          await call('post', reqUrl, s.owner.token)
            .send({ message: 'مرة ثانية' })
            .expect(409)
        ).body.error.code,
      ).toBe('SIZE_GUIDE_REQUEST_PENDING');
      const queue = await call(
        'get',
        '/admin/size-guide-requests?status=PENDING',
        admin.token,
      ).expect(200);
      expect(queue.body.map((r: { id: string }) => r.id)).toContain(
        first.body.id,
      );
      await call('get', '/admin/size-guide-requests', s.owner.token).expect(
        403,
      );
      expect(
        (
          await call(
            'patch',
            `/admin/size-guide-requests/${first.body.id}`,
            admin.token,
          )
            .send({ decision: 'REJECTED' })
            .expect(400)
        ).body.error.code,
      ).toBe('DECISION_NOTE_REQUIRED');
      await call(
        'patch',
        `/admin/size-guide-requests/${first.body.id}`,
        admin.token,
      )
        .send({ decision: 'REJECTED', note: 'الدليل القياسي يكفي' })
        .expect(200);
      const second = await call('post', reqUrl, s.owner.token)
        .send({ message: 'دليل خاص من فضلك' })
        .expect(201);
      const g = await guide(admin, {
        pairs: [
          {
            category_code: 'DRESSES_WOMEN',
            audience: 'WOMEN',
            is_default: false,
          },
        ],
      });
      const unrelated = await guide(admin, {
        pairs: [
          { category_code: 'SKIRTS', audience: 'WOMEN', is_default: false },
        ],
      });
      expect(
        (
          await call(
            'patch',
            `/admin/size-guide-requests/${second.body.id}`,
            admin.token,
          )
            .send({ decision: 'RESOLVED', guide_id: unrelated.id })
            .expect(409)
        ).body.error.code,
      ).toBe('SIZE_GUIDE_NOT_APPLICABLE');
      const resolved = await call(
        'patch',
        `/admin/size-guide-requests/${second.body.id}`,
        admin.token,
      )
        .send({ decision: 'RESOLVED', guide_id: g.id })
        .expect(200);
      expect(resolved.body.status).toBe('RESOLVED');
      expect(
        (
          await prisma.vendorOffer.findUniqueOrThrow({
            where: { id: o.offerId },
          })
        ).sizeGuideId,
      ).toBe(g.id);
      await call(
        'patch',
        `/admin/size-guide-requests/${second.body.id}`,
        admin.token,
      )
        .send({ decision: 'REJECTED', note: 'x' })
        .expect(409);
      const mine = await call(
        'get',
        `/vendors/${s.vendor.id}/size-guide-requests`,
        s.owner.token,
      ).expect(200);
      expect(mine.body.map((r: { status: string }) => r.status).sort()).toEqual(
        ['REJECTED', 'RESOLVED'],
      );
    });
  });

  describe('4.3 the publish gate and existing offers', () => {
    const publish = (s: Store, offerId: string) =>
      call(
        'patch',
        `/vendors/${s.vendor.id}/offers/${offerId}/status`,
        s.owner.token,
      ).send({ status: 'ACTIVE' });

    it('blocks publishing sizes a published guide does not describe; without a guide it publishes', async () => {
      const s = await store();
      const free = await offer(s, {
        audiences: ['WOMEN'],
        category: 'DRESSES_WOMEN',
        sizes: ['S', 'XL'],
        status: 'DRAFT',
      });
      await publish(s, free.offerId).expect(200);
      const admin = await account('PLATFORM_ADMIN');
      await guide(admin, { pairs: WOMEN_DRESSES });
      const blocked = await offer(s, {
        audiences: ['WOMEN'],
        category: 'DRESSES_WOMEN',
        sizes: ['S', 'XL'],
        status: 'DRAFT',
      });
      const res = await publish(s, blocked.offerId).expect(400);
      expect(res.body.error.code).toBe('OFFER_NOT_PUBLISHABLE');
      expect(res.body.error.details).toContain('size_guide');
      expect(res.body.error.message).toContain('XL');
      const fits = await offer(s, {
        audiences: ['WOMEN'],
        category: 'DRESSES_WOMEN',
        sizes: ['S', 'M'],
        status: 'DRAFT',
      });
      await publish(s, fits.offerId).expect(200);
      // ONE_SIZE is exempt unless the guide has its own row.
      const oneSize = await offer(s, {
        audiences: ['WOMEN'],
        category: 'DRESSES_WOMEN',
        sizes: ['ONE_SIZE'],
        status: 'DRAFT',
      });
      await publish(s, oneSize.offerId).expect(200);
      const view = await call(
        'get',
        `/vendors/${s.vendor.id}/offers/${oneSize.offerId}/size-guide`,
        s.owner.token,
      ).expect(200);
      expect(view.body.compatibility).toEqual({
        checked: true,
        mismatched_sizes: [],
        one_size_exempt: true,
      });
      // A kids size is only checked by a kids guide - none published here.
      const kids = await offer(s, {
        audiences: ['KIDS'],
        category: 'JEANS',
        sizes: ['AGE_4_5Y'],
        status: 'DRAFT',
      });
      await publish(s, kids.offerId).expect(200);
      // The offer published before the guide stays ACTIVE and is reported.
      expect(
        (
          await prisma.vendorOffer.findUniqueOrThrow({
            where: { id: free.offerId },
          })
        ).status,
      ).toBe('ACTIVE');
      const coverage = await call(
        'get',
        '/admin/size-guides/coverage',
        admin.token,
      ).expect(200);
      expect(coverage.body.mismatched_offers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ offer_id: free.offerId, sizes: ['XL'] }),
        ]),
      );
      expect(coverage.body.pairs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category_code: 'DRESSES_WOMEN',
            audience: 'WOMEN',
          }),
        ]),
      );
    });
  });

  describe('decision 6: checkout snapshot', () => {
    it('each order line keeps the guide version in force when bought; later versions never rewrite it', async () => {
      const s = await store();
      const o = await offer(s, {
        audiences: ['WOMEN'],
        category: 'DRESSES_WOMEN',
        sizes: ['M', 'XL'],
      });
      const admin = await account('PLATFORM_ADMIN');
      const g = await guide(admin, { pairs: WOMEN_DRESSES });
      const buyer = await account();
      const buy = async (variantId: string) => {
        const cart = await call('post', '/cart/items', buyer.token)
          .send({
            vendor_id: s.vendor.id,
            offer_variant_id: variantId,
            quantity: 1,
          })
          .expect(201);
        const reserved = await call('post', '/checkout/reserve', buyer.token)
          .send({
            terms_accepted: true,
            terms_version: CURRENT_PLATFORM_TERMS_VERSION,
            groups: [
              {
                cart_item_ids: [cart.body.id],
                branch_id: s.branch.id,
                fulfilment_method: 'PICKUP',
                payment_method: 'COD',
              },
            ],
          })
          .expect(201);
        const confirmed = await call('post', '/checkout/confirm', buyer.token)
          .send({ reservation_id: reserved.body.reservation_id })
          .expect(201);
        return prisma.branchOrderItem.findFirstOrThrow({
          where: { branchOrderId: confirmed.body.branch_orders[0].id },
        });
      };
      const m = await buy(o.ids.M);
      expect(m.sizeGuideVersionIdSnapshot).toBe(g.versionId);
      // The order and return screens show the version it was bought under.
      const snapshot = {
        guide_id: g.id,
        version_id: g.versionId,
        version: 1,
        name_ar: 'دليل',
        name_en: 'Guide',
      };
      const orders = await call(
        'get',
        '/customers/me/orders',
        buyer.token,
      ).expect(200);
      const line = orders.body
        .flatMap((x: { items: { id: string }[] }) => x.items)
        .find((i: { id: string }) => i.id === m.id);
      expect(line.size_guide).toMatchObject(snapshot);
      const ret = await prisma.return.create({
        data: {
          vendorId: s.vendor.id,
          branchOrderItemId: m.id,
          reason: 'DAMAGED',
          vendorReviewDueAt: new Date(Date.now() + 86_400_000),
        },
      });
      const mine = await call(
        'get',
        '/customers/me/returns',
        buyer.token,
      ).expect(200);
      expect(
        mine.body.find((r: { id: string }) => r.id === ret.id).size_guide,
      ).toMatchObject(snapshot);
      expect(
        (
          await call(
            'get',
            `/customers/me/returns/${ret.id}`,
            buyer.token,
          ).expect(200)
        ).body.size_guide,
      ).toMatchObject(snapshot);
      const branchList = await call(
        'get',
        `/vendors/${s.vendor.id}/branches/${s.branch.id}/returns`,
        s.owner.token,
      ).expect(200);
      expect(
        branchList.body.find((r: { id: string }) => r.id === ret.id).size_guide,
      ).toMatchObject(snapshot);
      await prisma.return.update({
        where: { id: ret.id },
        data: { status: 'ESCALATED', escalatedAt: new Date() },
      });
      const escalated = await call('get', '/admin/returns', admin.token).expect(
        200,
      );
      expect(
        escalated.body.find((r: { id: string }) => r.id === ret.id).size_guide,
      ).toMatchObject(snapshot);
      // XL isn't in the guide, but the guide is the one describing this product.
      const xl = await buy(o.ids.XL);
      expect(xl.sizeGuideVersionIdSnapshot).toBe(g.versionId);
      const v2 = await call(
        'post',
        `/admin/size-guides/${g.id}/versions`,
        admin.token,
      ).expect(201);
      await call(
        'post',
        `/admin/size-guides/${g.id}/versions/${v2.body.draft_version.id}/publish`,
        admin.token,
      ).expect(200);
      expect(
        (
          await prisma.branchOrderItem.findUniqueOrThrow({
            where: { id: m.id },
          })
        ).sizeGuideVersionIdSnapshot,
      ).toBe(g.versionId);
      expect(
        (
          await prisma.sizeGuideVersion.findUniqueOrThrow({
            where: { id: g.versionId },
          })
        ).status,
      ).toBe('RETIRED');
      const after = await buy(o.ids.M);
      expect(after.sizeGuideVersionIdSnapshot).toBe(v2.body.draft_version.id);
      // No guide applies -> null.
      const bag = await offer(s, {
        audiences: ['WOMEN'],
        category: 'BAGS',
        sizes: [null],
      });
      const bagLine = await buy(bag.ids.none);
      expect(bagLine.sizeGuideVersionIdSnapshot).toBeNull();
      // No snapshot -> nothing to show.
      const later = await call(
        'get',
        '/customers/me/orders',
        buyer.token,
      ).expect(200);
      expect(
        later.body
          .flatMap((x: { items: { id: string }[] }) => x.items)
          .find((i: { id: string }) => i.id === bagLine.id).size_guide,
      ).toBeNull();
    });
  });

  describe("phase A+: a product's own size table (kind OFFER)", () => {
    const OWN = {
      keys: ['CHEST', 'LENGTH'],
      values: {
        S: { CHEST: 86, LENGTH: 120 },
        M: { CHEST: 90, LENGTH: 121 },
        L: { CHEST: 96, LENGTH: 122 },
        XL: { CHEST: 102, LENGTH: 123 },
      },
    };
    const own = (s: Store, offerId: string, measurements: object | null) =>
      call(
        'put',
        `/vendors/${s.vendor.id}/offers/${offerId}/measurements`,
        s.owner.token,
      ).send({ measurements });
    const shown = async (s: Store, offerId: string) =>
      (
        await call(
          'get',
          `/storefronts/${s.vendor.slug}/offers/${offerId}/size-guide`,
          null,
        ).expect(200)
      ).body as {
        guides: { kind: string; id: string }[];
        sizes_not_in_guide: string[];
      };

    it('priority: the canonical product guide, then the product own table, then the category guide', async () => {
      const admin = await account('PLATFORM_ADMIN');
      const s = await store();
      const category = await guide(admin, { pairs: WOMEN_DRESSES });
      const o = await offer(s, {
        audiences: ['WOMEN'],
        category: 'DRESSES_WOMEN',
        sizes: ['S', 'M', 'L', 'XL'],
      });
      // The category guide (no XL row) applies first.
      let page = await shown(s, o.offerId);
      expect(page.guides.map((g) => g.id)).toEqual([category.id]);
      expect(page.sizes_not_in_guide).toEqual(['XL']);
      // The product's own table wins over it.
      await own(s, o.offerId, OWN).expect(200);
      page = await shown(s, o.offerId);
      expect(page.guides.map((g) => g.kind)).toEqual(['OFFER']);
      expect(page.sizes_not_in_guide).toEqual([]);
      const ownerView = await call(
        'get',
        `/vendors/${s.vendor.id}/offers/${o.offerId}/size-guide`,
        s.owner.token,
      ).expect(200);
      expect(ownerView.body).toMatchObject({ own_measurements_apply: true });
      // A canonical product guide (platform data) wins over both.
      const product = await guide(admin, {
        kind: 'PRODUCT',
        canonicalProductId: o.canonicalProductId,
        basis: 'GARMENT',
        rows: [
          ...DRESS_ROWS,
          {
            size_code: 'XL',
            values: {
              CHEST: { min: 98, max: 104 },
              WAIST: { min: 80, max: 86 },
            },
          },
        ],
      });
      page = await shown(s, o.offerId);
      expect(page.guides.map((g) => g.id)).toEqual([product.id]);
    });

    it('the category guide gate holds back a size it does not describe - unless the product has its own table', async () => {
      const admin = await account('PLATFORM_ADMIN');
      const s = await store();
      await guide(admin, { pairs: WOMEN_DRESSES });
      const o = await offer(s, {
        audiences: ['WOMEN'],
        category: 'DRESSES_WOMEN',
        sizes: ['S', 'M', 'L', 'XL'],
        status: 'DRAFT',
      });
      const refused = await call(
        'patch',
        `/vendors/${s.vendor.id}/offers/${o.offerId}/status`,
        s.owner.token,
      )
        .send({ status: 'ACTIVE' })
        .expect(400);
      expect(refused.body.error.details).toContain('size_guide');
      const check = await call(
        'get',
        `/vendors/${s.vendor.id}/offers/${o.offerId}/publish-check`,
        s.owner.token,
      ).expect(200);
      expect(check.body).toMatchObject({
        ready: false,
        missing: ['size_guide'],
        sizes_not_in_guide: ['XL'],
      });
      await own(s, o.offerId, OWN).expect(200);
      await call(
        'patch',
        `/vendors/${s.vendor.id}/offers/${o.offerId}/status`,
        s.owner.token,
      )
        .send({ status: 'ACTIVE' })
        .expect(200);
    });

    it("a product's own table is the store's, not the platform's: never in the administrators' list or editor, never created there, not readable by its id", async () => {
      const admin = await account('PLATFORM_ADMIN');
      const s = await store();
      const o = await offer(s, {
        audiences: ['WOMEN'],
        category: 'DRESSES_WOMEN',
        sizes: ['S', 'M', 'L', 'XL'],
      });
      await own(s, o.offerId, OWN).expect(200);
      const g = await prisma.sizeGuide.findUniqueOrThrow({
        where: { vendorOfferId: o.offerId },
      });
      const list = await call('get', '/admin/size-guides', admin.token).expect(
        200,
      );
      expect(list.body.map((x: { id: string }) => x.id)).not.toContain(g.id);
      expect(list.body.some((x: { kind: string }) => x.kind === 'OFFER')).toBe(
        false,
      );
      await call('get', `/admin/size-guides/${g.id}`, admin.token).expect(404);
      await call(
        'post',
        `/admin/size-guides/${g.id}/retire`,
        admin.token,
      ).expect(404);
      await call('get', `/size-guides/${g.id}`, null).expect(404);
      const created = await call('post', '/admin/size-guides', admin.token)
        .send({
          code: unique('own').toLowerCase(),
          name_ar: 'جدول',
          name_en: 'Table',
          kind: 'OFFER',
        })
        .expect(400);
      expect(created.body.error.code).toBe('OFFER_GUIDE_NOT_ALLOWED');
      // A branch employee cannot edit it either.
      await own({ ...s, owner: s.employee }, o.offerId, OWN).expect(403);
    });
  });
});
