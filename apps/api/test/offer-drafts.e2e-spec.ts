import { ThrottlerStorage } from '@nestjs/throttler';
import { normalizeColorName } from '../src/offers/color-name';
import { mkdtempSync } from 'fs';
import { rm, stat } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { DraftUploadSweepService } from './../src/offer-drafts/draft-upload-sweep.service';
import { CanonicalNamingService } from './../src/matching/canonical-naming.service';
import { OfferDraftsService } from './../src/offer-drafts/offer-drafts.service';
import { PrismaService } from './../src/prisma/prisma.service';
import {
  configureUploadServing,
  parseOwnUploadUrl,
} from './../src/uploads/uploads.util';
import { tb26Fixtures } from './helpers/tb26-fixtures';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp = require('sharp') as typeof import('sharp/dist/index.cjs');

const UPLOADS_ROOT = mkdtempSync(
  path.join(os.tmpdir(), 'offer-drafts-uploads-'),
);
process.env.UPLOADS_DIR = UPLOADS_ROOT;

const SIZES = ['EU_36', 'EU_38', 'EU_40', 'EU_42', 'EU_44', 'EU_46'];

// Product-entry wizard drafts: server-side, created only on request, saved
// with a revision (no silent overwrite between two tabs), turned into a
// product in ONE transaction (colour images on every size of that colour),
// brand requests instead of seller-created brands, and the upload clean-up
// that never touches an image something else uses.
describe('Product-entry wizard: offer drafts (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const f = tb26Fixtures(() => app);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // Phase A++: this file uploads well over 100 images within one
      // minute (every test builds its own store and drafts), so the global
      // 100/min-per-route limit is neutralised here the same way
      // sprint16-fixtures.ts's bootApp() and the sprint23 spec do - no test
      // in this file is about rate limiting (that is covered by the auth
      // and tb16 specs).
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
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    configureUploadServing(app);
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
    await rm(UPLOADS_ROOT, { recursive: true, force: true });
  });

  const base = (s: { vendorId: string }) =>
    `/api/v1/vendors/${s.vendorId}/offer-drafts`;
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const code = (r: { body: { error?: { code?: string } } }) =>
    r.body.error?.code;

  async function png(shade: number): Promise<Buffer> {
    return sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: shade, g: 80, b: 120 },
      },
    })
      .png()
      .toBuffer();
  }
  async function upload(
    s: { vendorId: string; owner: { token: string } },
    shade = 100,
  ): Promise<string> {
    const res = await f
      .http()
      .post(`/api/v1/vendors/${s.vendorId}/uploads`)
      .set(as(s.owner.token))
      .attach('file', await png(shade), 'a.png')
      .expect(201);
    return res.body.url as string;
  }
  const fileOf = (url: string) => {
    const own = parseOwnUploadUrl(url)!;
    return path.join(UPLOADS_ROOT, 'vendors', own.vendorId, own.file);
  };
  const exists = async (url: string) =>
    stat(fileOf(url)).then(
      () => true,
      () => false,
    );

  async function newDraft(s: { vendorId: string; owner: { token: string } }) {
    const res = await f.http().post(base(s)).set(as(s.owner.token)).expect(201);
    return res.body as {
      id: string;
      revision: number;
      title: string;
      status: string;
    };
  }
  const save = (
    s: { vendorId: string; owner: { token: string } },
    id: string,
    revision: number,
    payload: object,
  ) =>
    f
      .http()
      .patch(`${base(s)}/${id}`)
      .set(as(s.owner.token))
      .send({ expected_revision: revision, payload });
  /** Edit drafts: a published product's content changes only through its edit draft (open, save, apply). */
  function editPublished(
    s: { vendorId: string; owner: { token: string } },
    offerId: string,
    change: (p: Record<string, unknown>) => Record<string, unknown>,
  ) {
    return {
      expect: async (status: number) => {
        const d = (
          await f
            .http()
            .post(`${base(s)}/edit-of/${offerId}`)
            .set(as(s.owner.token))
        ).body;
        const r = await save(s, d.id, d.revision, change(d.payload)).expect(
          200,
        );
        return f
          .http()
          .post(`${base(s)}/${d.id}/apply`)
          .set(as(s.owner.token))
          .send({ expected_revision: r.body.revision })
          .expect(status);
      },
    };
  }
  const submit = (
    s: { vendorId: string; owner: { token: string } },
    id: string,
    revision: number,
  ) =>
    f
      .http()
      .post(`${base(s)}/${id}/submit`)
      .set(as(s.owner.token))
      .send({ expected_revision: revision });

  /** The evening dress: three colours (own images), six sizes, one price, two branches. */
  async function dressPayload(s: {
    vendorId: string;
    owner: { token: string };
    branchA: string;
    branchB: string;
  }) {
    const brown = [await upload(s, 10), await upload(s, 20)];
    const black = [await upload(s, 30), await upload(s, 40)];
    const olive = [await upload(s, 50)];
    return {
      step: 4,
      audience: 'WOMEN',
      category: 'DRESSES_WOMEN',
      title_ar: `فستان سهرة ${f.unique('x').slice(-5)}`,
      title_en: 'Evening dress',
      brand: { mode: 'none' },
      specs: { material: 'شيفون', sleeve_type: '   ', unknown_spec: 'x' },
      colors: [
        { code: 'BROWN', images: brown },
        { code: 'BLACK', images: black },
        { code: 'OLIVE', images: olive },
      ],
      sizes: { BROWN: SIZES, BLACK: SIZES, OLIVE: SIZES.slice(1, 5) },
      price: 180,
      default_stock: { [s.branchA]: 3, [s.branchB]: 2 },
      stock_overrides: { 'BLACK|EU_46': { [s.branchB]: 0 } },
      sku_overrides: {
        'BROWN|EU_38': `MY-${f.unique('sku').slice(-6)}`,
      } as Record<string, string>,
      description_ar: 'فستان سهرة بأكمام منفوخة',
    };
  }

  describe('drafts', () => {
    it('a draft exists only after «منتج جديد»; it starts as «مسودة جديدة», is listed, and is not a product', async () => {
      const s = await f.store();
      expect(
        (await f.http().get(base(s)).set(as(s.owner.token)).expect(200)).body
          .items,
      ).toEqual([]);
      const d = await newDraft(s);
      expect(d).toMatchObject({
        title: 'مسودة جديدة',
        revision: 1,
        status: 'OPEN',
      });
      const list = (
        await f.http().get(base(s)).set(as(s.owner.token)).expect(200)
      ).body.items;
      expect(list.map((x: { id: string }) => x.id)).toEqual([d.id]);
      expect(
        await prisma.vendorOffer.count({ where: { vendorId: s.vendorId } }),
      ).toBe(0);
    });

    it('every save is on the server and bumps the revision; a save from an older revision (the other tab) is refused with the current revision - never applied', async () => {
      const s = await f.store();
      const d = await newDraft(s);
      const tab1 = await save(s, d.id, 1, {
        step: 1,
        title_ar: 'من التبويب الأول',
      }).expect(200);
      expect(tab1.body).toMatchObject({
        revision: 2,
        title: 'من التبويب الأول',
      });
      const tab2 = await save(s, d.id, 1, {
        step: 1,
        title_ar: 'من التبويب الثاني',
      }).expect(409);
      expect(code(tab2)).toBe('DRAFT_REVISION_CONFLICT');
      expect(tab2.body.error.details[0].revision).toBe(2);
      const now = (
        await f
          .http()
          .get(`${base(s)}/${d.id}`)
          .set(as(s.owner.token))
          .expect(200)
      ).body;
      expect(now.payload.title_ar).toBe('من التبويب الأول');

      // Two saves at the same moment from the same revision: exactly one wins.
      const both = await Promise.all([
        save(s, d.id, 2, { title_ar: 'أ' }),
        save(s, d.id, 2, { title_ar: 'ب' }),
      ]);
      expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
      const after = await prisma.offerDraft.findUniqueOrThrow({
        where: { id: d.id },
      });
      expect(after.revision).toBe(3);
    });

    it("checks what is saved: only this store's own uploads; owners only; a non-member never sees the draft", async () => {
      const s = await f.store();
      const other = await f.store();
      const d = await newDraft(s);
      const foreign = await upload(other);
      expect(
        code(
          await save(s, d.id, 1, {
            colors: [{ code: 'BLACK', images: ['https://example.com/x.png'] }],
          }).expect(400),
        ),
      ).toBe('UPLOAD_NOT_USABLE');
      expect(
        code(
          await save(s, d.id, 1, {
            colors: [{ code: 'BLACK', images: [foreign] }],
          }).expect(400),
        ),
      ).toBe('UPLOAD_NOT_USABLE');
      expect(code(await save(s, d.id, 1, { price: -5 }).expect(400))).toBe(
        'DRAFT_INVALID',
      );
      const employee = await f.member(
        s.vendorId,
        await f.account(),
        'BRANCH_EMPLOYEE',
        s.branchA,
      );
      expect(
        code(await f.http().get(base(s)).set(as(employee.token)).expect(403)),
      ).toBe('VENDOR_ROLE_FORBIDDEN');
      const stranger = await f.account();
      expect(
        code(
          await f
            .http()
            .get(`${base(s)}/${d.id}`)
            .set(as(stranger.token))
            .expect(403),
        ),
      ).toBe('NOT_VENDOR_MEMBER');
      expect(
        code(
          await f
            .http()
            .get(`${base(other)}/${d.id}`)
            .set(as(other.owner.token))
            .expect(404),
        ),
      ).toBe('DRAFT_NOT_FOUND');
    });

    it('creating an incomplete draft says what is missing, by step, as codes', async () => {
      const s = await f.store();
      const d = await newDraft(s);
      const r = await submit(s, d.id, 1).expect(409);
      expect(code(r)).toBe('DRAFT_INCOMPLETE');
      const codes = (
        r.body.error.details as { code: string; step: number }[]
      ).map((p) => `${p.step}:${p.code}`);
      expect(codes).toEqual(
        expect.arrayContaining([
          '1:AUDIENCE_REQUIRED',
          '1:CATEGORY_REQUIRED',
          '1:BRAND_REQUIRED',
          '2:COLOR_REQUIRED',
          '4:PRICE_REQUIRED',
        ]),
      );
      expect(
        await prisma.vendorOffer.count({ where: { vendorId: s.vendorId } }),
      ).toBe(0);
    });
  });

  describe('creating the product', () => {
    it("the evening dress: 3 colours x their sizes = 16 versions, one price, stock per branch with the one exception, each colour's images on every size of that colour (main first), only the known specs, the own SKU; then it publishes", async () => {
      const s = await f.store();
      const d = await newDraft(s);
      const payload = await dressPayload(s);
      const saved = await save(s, d.id, 1, payload).expect(200);
      const r = await submit(s, d.id, saved.body.revision).expect(201);
      expect(r.body.versions).toBe(16);
      expect(r.body.brand_request).toBeNull();

      const offer = await prisma.vendorOffer.findUniqueOrThrow({
        where: { id: r.body.offer_id },
        include: {
          audiences: true,
          categories: true,
          brand: true,
          variants: {
            include: {
              media: { orderBy: { sortOrder: 'asc' } },
              branchStocks: true,
            },
          },
        },
      });
      expect(offer.status).toBe('DRAFT');
      expect(offer.brand?.isNoBrandSentinel).toBe(true);
      expect(offer.audiences.map((a) => a.audience)).toEqual(['WOMEN']);
      expect(offer.categories.map((c) => c.categoryCode)).toEqual([
        'DRESSES_WOMEN',
      ]);
      expect(offer.categoryTemplate).toBe('DRESSES');
      expect(offer.templateAttributes).toEqual({ material: 'شيفون' });
      expect(offer.variants).toHaveLength(16);
      for (const v of offer.variants) {
        expect(Number(v.basePrice)).toBe(180);
        const colour = payload.colors.find((c) => c.code === v.colorCode)!;
        expect(v.media.map((m) => m.url)).toEqual(colour.images);
        expect(v.media.map((m) => m.kind)).toEqual(
          colour.images.map((_, i) => (i === 0 ? 'PRIMARY' : 'ADDITIONAL')),
        );
        const stock = Object.fromEntries(
          v.branchStocks.map((b) => [b.branchId, b.quantity]),
        );
        const expectB =
          v.colorCode === 'BLACK' && v.sizeCode === 'EU_46' ? undefined : 2;
        expect(stock[s.branchA]).toBe(3);
        expect(stock[s.branchB]).toBe(expectB);
        expect(v.specsTextAr).toBe('فستان سهرة بأكمام منفوخة');
      }
      const own = offer.variants.find(
        (v) => v.colorCode === 'BROWN' && v.sizeCode === 'EU_38',
      )!;
      expect(own.sellerSku).toBe(payload.sku_overrides['BROWN|EU_38']);
      expect(
        offer.variants
          .filter((v) => v.colorCode === 'OLIVE')
          .map((v) => v.sizeCode)
          .sort(),
      ).toEqual(SIZES.slice(1, 5));

      const draft = await prisma.offerDraft.findUniqueOrThrow({
        where: { id: d.id },
      });
      expect(draft).toMatchObject({ status: 'SUBMITTED', offerId: offer.id });
      expect(code(await submit(s, d.id, draft.revision).expect(409))).toBe(
        'DRAFT_CLOSED',
      );

      await f
        .http()
        .patch(`/api/v1/vendors/${s.vendorId}/offers/${offer.id}/status`)
        .set(as(s.owner.token))
        .set('Idempotency-Key', f.unique('pub'))
        .send({ status: 'ACTIVE' })
        .expect(200);
    });

    it('all or nothing: when one SKU is already taken the whole creation rolls back - no product, no version, no image, no stock - and the draft stays open, unchanged', async () => {
      const s = await f.store();
      const first = await newDraft(s);
      const p1 = await dressPayload(s);
      const r1 = await save(s, first.id, 1, p1).expect(200);
      await submit(s, first.id, r1.body.revision).expect(201);
      const offersBefore = await prisma.vendorOffer.count({
        where: { vendorId: s.vendorId },
      });
      const variantsBefore = await prisma.offerVariant.count({
        where: { vendorId: s.vendorId },
      });
      const mediaBefore = await prisma.offerVariantMedia.count({
        where: { vendorId: s.vendorId },
      });
      const movesBefore = await prisma.stockMovement.count({
        where: { vendorId: s.vendorId },
      });

      const second = await newDraft(s);
      const p2 = await dressPayload(s);
      p2.sku_overrides = { 'OLIVE|EU_42': p1.sku_overrides['BROWN|EU_38'] };
      const r2 = await save(s, second.id, 1, p2).expect(200);
      expect(
        code(await submit(s, second.id, r2.body.revision).expect(409)),
      ).toBe('SELLER_SKU_ALREADY_EXISTS');
      expect(
        await prisma.vendorOffer.count({ where: { vendorId: s.vendorId } }),
      ).toBe(offersBefore);
      expect(
        await prisma.offerVariant.count({ where: { vendorId: s.vendorId } }),
      ).toBe(variantsBefore);
      expect(
        await prisma.offerVariantMedia.count({
          where: { vendorId: s.vendorId },
        }),
      ).toBe(mediaBefore);
      expect(
        await prisma.stockMovement.count({ where: { vendorId: s.vendorId } }),
      ).toBe(movesBefore);
      const still = await prisma.offerDraft.findUniqueOrThrow({
        where: { id: second.id },
      });
      expect(still).toMatchObject({
        status: 'OPEN',
        revision: r2.body.revision,
        offerId: null,
      });
      for (const url of p2.colors.flatMap((c) => c.images))
        expect(await exists(url)).toBe(true);
    });

    it('two tabs pressing «إنشاء» at once: exactly one product', async () => {
      const s = await f.store();
      const d = await newDraft(s);
      const r = await save(s, d.id, 1, await dressPayload(s)).expect(200);
      const both = await Promise.all([
        submit(s, d.id, r.body.revision),
        submit(s, d.id, r.body.revision),
      ]);
      expect(both.map((x) => x.status).sort()).toEqual([201, 409]);
      expect(
        await prisma.vendorOffer.count({ where: { vendorId: s.vendorId } }),
      ).toBe(1);
    });
  });

  describe('brand requests', () => {
    const decide = (admin: { token: string }, id: string, body: object) =>
      f
        .http()
        .post(`/api/v1/admin/brand-requests/${id}/decision`)
        .set(as(admin.token))
        .send(body);
    const draftView = async (
      s: { vendorId: string; owner: { token: string } },
      id: string,
    ) =>
      (
        await f
          .http()
          .get(`${base(s)}/${id}`)
          .set(as(s.owner.token))
          .expect(200)
      ).body;
    const publish = (
      s: { vendorId: string; owner: { token: string } },
      offerId: string,
    ) =>
      f
        .http()
        .patch(`/api/v1/vendors/${s.vendorId}/offers/${offerId}/status`)
        .set(as(s.owner.token))
        .set('Idempotency-Key', f.unique('pub'))
        .send({ status: 'ACTIVE' });

    it('«بدون علامة تجارية» is a choice of its own: the product carries it and publishes; no request is made', async () => {
      const s = await f.store();
      const d = await newDraft(s);
      const r = await save(s, d.id, 1, await dressPayload(s)).expect(200);
      expect(r.body.brand_request).toBeNull();
      const c = await submit(s, d.id, r.body.revision).expect(201);
      const offer = await prisma.vendorOffer.findUniqueOrThrow({
        where: { id: c.body.offer_id },
        include: { brand: true },
      });
      expect(offer.brand?.isNoBrandSentinel).toBe(true);
      await publish(s, offer.id).expect(200);
      expect(
        await prisma.brandRequest.count({ where: { vendorId: s.vendorId } }),
      ).toBe(0);
    });

    it('a typed new brand: a PENDING request on the draft (renamed while pending, withdrawn when another choice is made); the product keeps that brand - never «بدون علامة» - and cannot be published until approved; approval gives the product the brand and publishing works', async () => {
      const s = await f.store();
      const admin = await f.account('PLATFORM_ADMIN');
      const name = `Lilac Studio ${f.unique('b').slice(-6)}`;
      const d = await newDraft(s);
      let r = await save(s, d.id, 1, {
        brand: { mode: 'request', name: 'Lilac' },
      }).expect(200);
      expect(r.body.brand_request).toMatchObject({
        name: 'Lilac',
        status: 'PENDING',
      });
      r = await save(s, d.id, r.body.revision, {
        brand: { mode: 'request', name: `  ${name}  ` },
      }).expect(200);
      expect(r.body.brand_request).toMatchObject({ name, status: 'PENDING' });
      expect(
        await prisma.brandRequest.count({ where: { draftId: d.id } }),
      ).toBe(1);
      // Another choice withdraws it; asking again opens a fresh one.
      r = await save(s, d.id, r.body.revision, {
        brand: { mode: 'none' },
      }).expect(200);
      expect(
        (
          await prisma.brandRequest.findFirstOrThrow({
            where: { draftId: d.id },
          })
        ).status,
      ).toBe('WITHDRAWN');
      r = await save(s, d.id, r.body.revision, {
        ...(await dressPayload(s)),
        brand: { mode: 'request', name },
      }).expect(200);
      expect(r.body.brand_request).toMatchObject({ name, status: 'PENDING' });
      expect(
        await prisma.brandRequest.count({
          where: { draftId: d.id, status: 'PENDING' },
        }),
      ).toBe(1);

      // Created while under review: no brand at all, not publishable, said as "brand_pending".
      const created = await submit(s, d.id, r.body.revision).expect(201);
      expect(created.body.brand_request).toMatchObject({
        name,
        status: 'PENDING',
      });
      const offer = await prisma.vendorOffer.findUniqueOrThrow({
        where: { id: created.body.offer_id },
      });
      expect(offer.brandId).toBeNull();
      const blocked = await publish(s, offer.id).expect(400);
      expect(code(blocked)).toBe('OFFER_NOT_PUBLISHABLE');
      expect(blocked.body.error.details).toContain('brand_pending');
      expect(await prisma.brand.count({ where: { name } })).toBe(0);

      const mine = (
        await f
          .http()
          .get(`/api/v1/vendors/${s.vendorId}/brand-requests`)
          .set(as(s.owner.token))
          .expect(200)
      ).body.items;
      expect(mine.find((x: { name: string }) => x.name === name)).toMatchObject(
        { status: 'PENDING', draft_id: d.id, offer: { id: offer.id } },
      );

      const req = (
        await prisma.brandRequest.findFirstOrThrow({
          where: { draftId: d.id, status: 'PENDING' },
        })
      ).id;
      await decide(s.owner, req, { decision: 'approve' }).expect(403);
      const ok = await decide(admin, req, { decision: 'approve' }).expect(200);
      expect(ok.body).toMatchObject({
        status: 'APPROVED',
        offer_updated: true,
      });
      const after = await prisma.vendorOffer.findUniqueOrThrow({
        where: { id: offer.id },
        include: { brand: true },
      });
      expect(after.brand?.name).toBe(name);
      await publish(s, offer.id).expect(200);
      expect(
        code(
          await decide(admin, req, {
            decision: 'reject',
            reason: 'متأخر',
          }).expect(409),
        ),
      ).toBe('BRAND_REQUEST_ALREADY_DECIDED');
    });

    it('approved BEFORE the product is created: the draft shows it approved and the product is created with that brand, publishable at once', async () => {
      const s = await f.store();
      const admin = await f.account('PLATFORM_ADMIN');
      const name = `Early ${f.unique('e').slice(-6)}`;
      const d = await newDraft(s);
      const r = await save(s, d.id, 1, {
        ...(await dressPayload(s)),
        brand: { mode: 'request', name },
      }).expect(200);
      await decide(admin, r.body.brand_request.id, {
        decision: 'approve',
      }).expect(200);
      const view = await draftView(s, d.id);
      expect(view.brand_request).toMatchObject({ status: 'APPROVED' });
      const c = await submit(s, d.id, view.revision).expect(201);
      expect(c.body.brand_request).toBeNull();
      const offer = await prisma.vendorOffer.findUniqueOrThrow({
        where: { id: c.body.offer_id },
        include: { brand: true },
      });
      expect(offer.brand?.name).toBe(name);
      await publish(s, offer.id).expect(200);
    });

    it('rejected: the draft stays, shows the reason, cannot be created with that brand; the seller then chooses an existing brand, «بدون علامة» explicitly, or a new request', async () => {
      const s = await f.store();
      const admin = await f.account('PLATFORM_ADMIN');
      const name = `Nope ${f.unique('n').slice(-6)}`;
      const d = await newDraft(s);
      const r = await save(s, d.id, 1, {
        ...(await dressPayload(s)),
        brand: { mode: 'request', name },
      }).expect(200);
      expect(
        code(
          await decide(admin, r.body.brand_request.id, {
            decision: 'reject',
          }).expect(400),
        ),
      ).toBe('REJECTION_REASON_REQUIRED');
      await decide(admin, r.body.brand_request.id, {
        decision: 'reject',
        reason: 'ليست علامة تجارية',
      }).expect(200);

      const view = await draftView(s, d.id);
      expect(view.status).toBe('OPEN');
      expect(view.brand_request).toMatchObject({
        status: 'REJECTED',
        rejection_reason: 'ليست علامة تجارية',
      });
      const refused = await submit(s, d.id, view.revision).expect(409);
      expect(code(refused)).toBe('DRAFT_INCOMPLETE');
      expect(refused.body.error.details).toEqual([
        { code: 'BRAND_REJECTED', step: 1 },
      ]);
      // Saving the same rejected name again does not reopen it by itself.
      const same = await save(s, d.id, view.revision, {
        ...view.payload,
        step: 1,
      }).expect(200);
      expect(same.body.brand_request.status).toBe('REJECTED');

      // A new request with another name.
      const other = await save(s, d.id, same.body.revision, {
        ...view.payload,
        brand: { mode: 'request', name: `${name} Two` },
      }).expect(200);
      expect(other.body.brand_request).toMatchObject({ status: 'PENDING' });
      // Or an existing brand.
      const brand = await prisma.brand.create({
        data: {
          name: `Known ${f.unique('k').slice(-6)}`,
          normalizedName: f.unique('known').toLowerCase(),
        },
      });
      const chosen = await save(s, d.id, other.body.revision, {
        ...view.payload,
        brand: { mode: 'existing', brand_id: brand.id },
      }).expect(200);
      expect(chosen.body.brand_request).toBeNull();
      expect(
        await prisma.brandRequest.count({
          where: { draftId: d.id, status: 'PENDING' },
        }),
      ).toBe(0);
      const c = await submit(s, d.id, chosen.body.revision).expect(201);
      expect(
        (
          await prisma.vendorOffer.findUniqueOrThrow({
            where: { id: c.body.offer_id },
          })
        ).brandId,
      ).toBe(brand.id);
    });

    it('discarding a draft withdraws its pending request', async () => {
      const s = await f.store();
      const d = await newDraft(s);
      const r = await save(s, d.id, 1, {
        brand: { mode: 'request', name: `Gone ${f.unique('g').slice(-6)}` },
      }).expect(200);
      await f
        .http()
        .delete(`${base(s)}/${d.id}?expected_revision=${r.body.revision}`)
        .set(as(s.owner.token))
        .expect(200);
      expect(
        (
          await prisma.brandRequest.findFirstOrThrow({
            where: { draftId: d.id },
          })
        ).status,
      ).toBe('WITHDRAWN');
    });
  });

  describe('wizard phase A: no empty draft, explicit stock per colour x size x branch, one price per product', () => {
    const publish = (
      s: { vendorId: string; owner: { token: string } },
      offerId: string,
    ) =>
      f
        .http()
        .patch(`/api/v1/vendors/${s.vendorId}/offers/${offerId}/status`)
        .set(as(s.owner.token))
        .set('Idempotency-Key', f.unique('pub'))
        .send({ status: 'ACTIVE' });
    const stockRows = async (offerId: string) =>
      (
        await prisma.branchStock.findMany({
          where: { offerVariant: { vendorOfferId: offerId } },
          include: { offerVariant: true },
        })
      )
        .map(
          (r) =>
            `${r.offerVariant.colorCode}|${r.offerVariant.sizeCode}@${r.branchId}=${r.quantity}/${r.reservedQuantity}`,
        )
        .sort();

    /** Fuchsia S/M/L and white M/L; Ramallah (A) and Nablus (B), explicitly. */
    async function phaseAPayload(s: {
      vendorId: string;
      owner: { token: string };
      branchA: string;
      branchB: string;
    }) {
      return {
        step: 3,
        audience: 'WOMEN',
        category: 'DRESSES_WOMEN',
        title_ar: `فستان ${f.unique('a').slice(-5)}`,
        title_en: 'Dress',
        brand: { mode: 'none' },
        colors: [
          { code: 'FUCHSIA', images: [await upload(s, 60)] },
          { code: 'WHITE', images: [await upload(s, 70)] },
        ],
        size_system: 'LETTER',
        sizes: { FUCHSIA: ['S', 'M', 'L'], WHITE: ['M', 'L'] },
        price: 120,
        stock: {
          [s.branchA]: {
            'FUCHSIA|S': 1,
            'FUCHSIA|M': 2,
            'FUCHSIA|L': 3,
            'WHITE|M': 0,
          },
          [s.branchB]: { 'FUCHSIA|M': 4, 'WHITE|L': 5 },
        },
      };
    }

    it('POST with the first real information creates the draft with it (title, image in the clean-up ledger, a typed brand requested); POST without it still starts empty', async () => {
      const s = await f.store();
      const img = await upload(s, 90);
      const r = await f
        .http()
        .post(base(s))
        .set(as(s.owner.token))
        .send({
          payload: {
            audience: 'WOMEN',
            category: 'DRESSES_WOMEN',
            colors: [{ code: 'FUCHSIA', images: [img] }],
          },
        })
        .expect(201);
      // A colour before any name: «مسودة جديدة» until the name is typed.
      expect(r.body).toMatchObject({
        revision: 1,
        status: 'OPEN',
        title: 'مسودة جديدة',
      });
      // Product colours: an older-shape colour reads as the family's product colour.
      expect(r.body.payload.colors).toEqual([
        {
          key: 'FUCHSIA',
          family: 'FUCHSIA',
          name_ar: 'فوشي',
          name_en: 'Fuchsia',
          images: [img],
        },
      ]);
      expect(
        (
          await prisma.offerDraft.findUniqueOrThrow({
            where: { id: r.body.id },
          })
        ).uploads,
      ).toEqual([img]);
      const named = await save(s, r.body.id, 1, {
        ...r.body.payload,
        title_ar: 'عباية كتان',
      }).expect(200);
      expect(named.body.title).toBe('عباية كتان');

      const withBrand = await f
        .http()
        .post(base(s))
        .set(as(s.owner.token))
        .send({
          payload: {
            brand: {
              mode: 'request',
              name: `First ${f.unique('b').slice(-6)}`,
            },
          },
        })
        .expect(201);
      expect(withBrand.body.brand_request).toMatchObject({ status: 'PENDING' });

      const empty = await f
        .http()
        .post(base(s))
        .set(as(s.owner.token))
        .expect(201);
      expect(empty.body.payload).toEqual({ step: 1 });
      // The first information is checked exactly like a save.
      expect(
        code(
          await f
            .http()
            .post(base(s))
            .set(as(s.owner.token))
            .send({ payload: { stock: { x: { 'A|B': -1 } } } })
            .expect(400),
        ),
      ).toBe('DRAFT_INVALID');
    });

    it('creating: every colour x size x branch exactly as entered (no row for 0 or nothing), one price for every colour x size; then it publishes', async () => {
      const s = await f.store();
      const d = await newDraft(s);
      const r = await save(s, d.id, 1, await phaseAPayload(s)).expect(200);
      const c = await submit(s, d.id, r.body.revision).expect(201);
      expect(await stockRows(c.body.offer_id)).toEqual(
        [
          `FUCHSIA|S@${s.branchA}=1/0`,
          `FUCHSIA|M@${s.branchA}=2/0`,
          `FUCHSIA|L@${s.branchA}=3/0`,
          `FUCHSIA|M@${s.branchB}=4/0`,
          `WHITE|L@${s.branchB}=5/0`,
        ].sort(),
      );
      const prices = await prisma.offerVariant.findMany({
        where: { vendorOfferId: c.body.offer_id },
        select: { basePrice: true },
      });
      expect(prices.map((v) => Number(v.basePrice))).toEqual([
        120, 120, 120, 120, 120,
      ]);
      await publish(s, c.body.offer_id).expect(200);
    });

    it('a purchase takes ONLY that colour x size from that branch (fuchsia M in Ramallah): fuchsia L, fuchsia M in Nablus and white are untouched', async () => {
      const s = await f.store();
      const d = await newDraft(s);
      const r = await save(s, d.id, 1, await phaseAPayload(s)).expect(200);
      const c = await submit(s, d.id, r.body.revision).expect(201);
      await publish(s, c.body.offer_id).expect(200);
      const before = await stockRows(c.body.offer_id);
      const fuchsiaM = await prisma.offerVariant.findFirstOrThrow({
        where: {
          vendorOfferId: c.body.offer_id,
          colorCode: 'FUCHSIA',
          sizeCode: 'M',
        },
      });
      await f.buy(await f.account(), s, fuchsiaM.id);
      const after = await stockRows(c.body.offer_id);
      const changed = after.filter((row) => !before.includes(row));
      expect(changed).toHaveLength(1);
      // That one row only: the unit is held for the order (reserved), or already taken off the shelf.
      expect(changed[0]).toMatch(
        new RegExp(`^FUCHSIA\\|M@${s.branchA}=(2/1|1/0)$`),
      );
      expect(after).toContain(`FUCHSIA|M@${s.branchB}=4/0`);
      expect(after).toContain(`FUCHSIA|L@${s.branchA}=3/0`);
      expect(after).toContain(`FUCHSIA|S@${s.branchA}=1/0`);
      expect(after).toContain(`WHITE|L@${s.branchB}=5/0`);
    });

    it('one size system per product (step 3), and a price (step 4): said as codes', async () => {
      const s = await f.store();
      const d = await newDraft(s);
      const p = await phaseAPayload(s);
      const mixed = await save(s, d.id, 1, {
        ...p,
        sizes: { FUCHSIA: ['M', 'EU_38'], WHITE: ['M'] },
      }).expect(200);
      const refused = await submit(s, d.id, mixed.body.revision).expect(409);
      expect(refused.body.error.details).toEqual([
        { code: 'SIZE_SYSTEM_MIXED', step: 3 },
      ]);
      // No price at all.
      const unpriced = await save(s, d.id, mixed.body.revision, {
        ...p,
        price: null,
      }).expect(200);
      const again = await submit(s, d.id, unpriced.body.revision).expect(409);
      expect(again.body.error.details).toEqual([
        { code: 'PRICE_REQUIRED', step: 4 },
      ]);
      expect(
        await prisma.vendorOffer.count({ where: { vendorId: s.vendorId } }),
      ).toBe(0);
    });
  });

  describe('wizard phase A: the owner-only «not published yet» cards', () => {
    it('the owner sees open drafts and created-but-unpublished products (labelled «مسودة» / «بانتظار اعتماد العلامة»), each with its audience and category; the public storefront and discovery never list them; nobody else can read them', async () => {
      const s = await f.store();
      const img = await upload(s, 33);
      // An open draft (first information only).
      const draft = await f
        .http()
        .post(base(s))
        .set(as(s.owner.token))
        .send({
          payload: {
            audience: 'MEN',
            category: 'TOPS',
            title_ar: 'قميص كتان',
            colors: [{ code: 'BLACK', images: [img] }],
          },
        })
        .expect(201);
      // A product created while its typed brand is under review (cannot be published yet).
      const d = await newDraft(s);
      const p = await dressPayload(s);
      const r = await save(s, d.id, 1, {
        ...p,
        brand: { mode: 'request', name: `Pending ${f.unique('p').slice(-6)}` },
      }).expect(200);
      const pending = await submit(s, d.id, r.body.revision).expect(201);
      // And one created with no brand, simply not published.
      const d2 = await newDraft(s);
      const r2 = await save(s, d2.id, 1, await dressPayload(s)).expect(200);
      const plain = await submit(s, d2.id, r2.body.revision).expect(201);

      const res = await f
        .http()
        .get(`/api/v1/vendors/${s.vendorId}/unpublished-products`)
        .set(as(s.owner.token))
        .expect(200);
      const byId = new Map(
        (res.body.items as { id: string; thumbnail: string | null }[]).map(
          (x) => [x.id, x],
        ),
      );
      expect(byId.get(draft.body.id)).toMatchObject({
        kind: 'draft',
        label: 'DRAFT',
        title: 'قميص كتان',
        audience: 'MEN',
        category: 'TOPS',
        thumbnail: img,
      });
      expect(byId.get(pending.body.offer_id)).toMatchObject({
        kind: 'offer',
        label: 'BRAND_PENDING',
        audience: 'WOMEN',
        category: 'DRESSES_WOMEN',
      });
      expect(byId.get(plain.body.offer_id)).toMatchObject({
        kind: 'offer',
        label: 'DRAFT',
        audience: 'WOMEN',
        category: 'DRESSES_WOMEN',
      });
      expect(byId.get(plain.body.offer_id)!.thumbnail).toBeTruthy();

      // Never public: the store's own product list and discovery.
      const { slug } = await prisma.vendor.findUniqueOrThrow({
        where: { id: s.vendorId },
        select: { slug: true },
      });
      const listed = JSON.stringify(
        (await f.http().get(`/api/v1/storefronts/${slug}/products`).expect(200))
          .body,
      );
      const discovered = JSON.stringify(
        (await f.http().get('/api/v1/discovery/all?audience=WOMEN').expect(200))
          .body,
      );
      for (const id of [
        pending.body.offer_id,
        plain.body.offer_id,
        draft.body.id,
      ]) {
        expect(listed).not.toContain(id);
        expect(discovered).not.toContain(id);
      }
      // Owner only.
      const other = await f.store();
      await f
        .http()
        .get(`/api/v1/vendors/${s.vendorId}/unpublished-products`)
        .set(as(other.owner.token))
        .expect(403);
      await f
        .http()
        .get(`/api/v1/vendors/${s.vendorId}/unpublished-products`)
        .expect(401);
    });
  });

  describe('wizard phase A+: one read-only publish judgement, publishing once, the product size table, the English name optional', () => {
    const check = (
      s: { vendorId: string; owner: { token: string } },
      id: string,
    ) =>
      f
        .http()
        .get(`${base(s)}/${id}/publish-check`)
        .set(as(s.owner.token));
    const publishDraft = (
      s: { vendorId: string; owner: { token: string } },
      id: string,
      revision: number,
    ) =>
      f
        .http()
        .post(`${base(s)}/${id}/publish`)
        .set(as(s.owner.token))
        .send({ expected_revision: revision });
    const pairs = (r: {
      body: { problems?: { code: string; step: number }[] };
    }) => (r.body.problems ?? []).map((p) => `${p.step}:${p.code}`);
    const slugOf = async (vendorId: string) =>
      (await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } })).slug;

    /** A complete dress: fuchsia S/M/L, stock in branch A, one price, no brand. */
    async function readyPayload(s: {
      vendorId: string;
      owner: { token: string };
      branchA: string;
    }) {
      return {
        layout: 5,
        step: 5,
        audience: 'WOMEN',
        category: 'DRESSES_WOMEN',
        title_ar: `فستان ${f.unique('n').slice(-5)}`,
        brand: { mode: 'none' },
        colors: [{ code: 'FUCHSIA', images: [await upload(s, 61)] }],
        size_system: 'LETTER',
        sizes: { FUCHSIA: ['S', 'M', 'L'] },
        price: 150,
        stock: {
          [s.branchA]: { 'FUCHSIA|S': 2, 'FUCHSIA|M': 3, 'FUCHSIA|L': 1 },
        },
      };
    }
    const TABLE = {
      keys: ['CHEST', 'WAIST', 'LENGTH'],
      values: {
        S: { CHEST: 86, WAIST: 68, LENGTH: 120 },
        M: { CHEST: 90, WAIST: 72, LENGTH: 121 },
        L: { CHEST: 96, WAIST: 78, LENGTH: 122 },
      },
    };

    it('«مجموعات المتجر» on publish: the product joins the chosen collections (last in each); one deleted after the draft was saved, or full, does not refuse the publish but is returned with why - and the draft keeps its choice', async () => {
      const s = await f.store();
      const collection = async (name: string) =>
        (
          await f
            .http()
            .post(`/api/v1/vendors/${s.vendorId}/sections`)
            .set(as(s.owner.token))
            .send({ name_ar: name })
            .expect(201)
        ).body.id as string;
      const kept = await collection('فساتين سهرة');
      const deleted = await collection('تُحذف');
      const full = await collection('ممتلئة');
      // an earlier product already in «فساتين سهرة»: the new one goes after it
      const earlier = await prisma.vendorOffer.create({
        data: { vendorId: s.vendorId, titleAr: 'سابق', titleEn: 'Earlier' },
      });
      await f
        .http()
        .post(`/api/v1/vendors/${s.vendorId}/sections/${kept}/offers`)
        .set(as(s.owner.token))
        .send({ offer_ids: [earlier.id] })
        .expect(200);
      // «ممتلئة» holds 500 products already
      const fillers = await Promise.all(
        Array.from({ length: 500 }, (_, i) =>
          prisma.vendorOffer.create({
            data: {
              vendorId: s.vendorId,
              titleAr: `ملء ${i}`,
              titleEn: `F ${i}`,
            },
          }),
        ),
      );
      await prisma.storeSectionOffer.createMany({
        data: fillers.map((o, i) => ({
          vendorId: s.vendorId,
          sectionId: full,
          offerId: o.id,
          sortOrder: i,
        })),
      });

      const d = await newDraft(s);
      const saved = await save(s, d.id, 1, {
        ...(await readyPayload(s)),
        sections: [kept, deleted, full],
      }).expect(200);
      // deleted between saving the draft and publishing it
      await f
        .http()
        .delete(`/api/v1/vendors/${s.vendorId}/sections/${deleted}`)
        .set(as(s.owner.token))
        .expect(200);
      const r = await publishDraft(s, d.id, saved.body.revision).expect(201);
      expect(r.body.collections_skipped).toEqual([
        { id: deleted, name: null, reason: 'DELETED' },
        { id: full, name: 'ممتلئة', reason: 'FULL' },
      ]);
      const offerId = r.body.offer_id as string;
      const inKept = await prisma.storeSectionOffer.findMany({
        where: { sectionId: kept },
        orderBy: { sortOrder: 'asc' },
        select: { offerId: true },
      });
      expect(inKept.map((x) => x.offerId)).toEqual([earlier.id, offerId]);
      expect(
        await prisma.storeSectionOffer.count({
          where: { sectionId: full, offerId },
        }),
      ).toBe(0);
      expect(
        await prisma.storeSectionOffer.count({ where: { sectionId: full } }),
      ).toBe(500);
      // the draft's choice is kept as it was
      const after = await prisma.offerDraft.findUniqueOrThrow({
        where: { id: d.id },
      });
      expect((after.payload as { sections?: string[] }).sections).toEqual([
        kept,
        deleted,
        full,
      ]);
    });

    it('publish-check is read-only and names every missing thing by its step (1-4) - no audit row, no notification, no product, the draft untouched', async () => {
      const s = await f.store();
      const d = await newDraft(s);
      const saved = await save(s, d.id, 1, {
        layout: 5,
        step: 2,
        audience: 'WOMEN',
        category: 'DRESSES_WOMEN',
        brand: { mode: 'none' },
        colors: [{ code: 'FUCHSIA', images: [] }],
        price: null,
      }).expect(200);
      const before = await prisma.offerDraft.findUniqueOrThrow({
        where: { id: d.id },
      });
      const audits = () =>
        prisma.auditLog.count({ where: { actorId: s.owner.userId } });
      const outbox = () =>
        prisma.outboxEvent.count({
          where: { payload: { path: ['vendor_id'], equals: s.vendorId } },
        });
      const a0 = await audits();
      const o0 = await outbox();
      const r1 = await check(s, d.id).expect(200);
      const r2 = await check(s, d.id).expect(200);
      expect(r1.body).toMatchObject({
        ready: false,
        revision: saved.body.revision,
        status: 'OPEN',
      });
      expect(pairs(r1)).toEqual(
        expect.arrayContaining([
          '1:TITLE_AR_REQUIRED',
          '2:COLOR_IMAGE_REQUIRED:FUCHSIA',
          '3:COLOR_SIZE_REQUIRED:FUCHSIA',
          '4:PRICE_REQUIRED',
        ]),
      );
      // The English name is never asked for.
      expect(pairs(r1).some((p) => p.includes('TITLE_EN'))).toBe(false);
      expect(r2.body).toEqual(r1.body);
      const after = await prisma.offerDraft.findUniqueOrThrow({
        where: { id: d.id },
      });
      expect(after.revision).toBe(before.revision);
      expect(after.updatedAt.toISOString()).toBe(
        before.updatedAt.toISOString(),
      );
      expect(await audits()).toBe(a0);
      expect(await outbox()).toBe(o0);
      expect(
        await prisma.vendorOffer.count({ where: { vendorId: s.vendorId } }),
      ).toBe(0);
    });

    it('«نشر» with something missing (no stock at all): refused with the reasons, NO product is created and the draft stays exactly as it was', async () => {
      const s = await f.store();
      const d = await newDraft(s);
      const p = await readyPayload(s);
      const saved = await save(s, d.id, 1, {
        ...p,
        stock: { [s.branchA]: { 'FUCHSIA|S': 0 } },
      }).expect(200);
      const c = await check(s, d.id).expect(200);
      expect(pairs(c)).toEqual(['4:STOCK_REQUIRED']);
      const r = await publishDraft(s, d.id, saved.body.revision).expect(409);
      expect(code(r)).toBe('DRAFT_NOT_PUBLISHABLE');
      expect(r.body.error.details).toEqual([
        { code: 'STOCK_REQUIRED', step: 4 },
      ]);
      expect(
        await prisma.vendorOffer.count({ where: { vendorId: s.vendorId } }),
      ).toBe(0);
      const after = await prisma.offerDraft.findUniqueOrThrow({
        where: { id: d.id },
      });
      expect(after).toMatchObject({
        status: 'OPEN',
        revision: saved.body.revision,
        offerId: null,
      });
    });

    it('«نشر» creates AND publishes in one go: ACTIVE, first published now, one status audit row, one followers notification; the draft is closed on that product', async () => {
      const s = await f.store();
      const d = await newDraft(s);
      const saved = await save(s, d.id, 1, await readyPayload(s)).expect(200);
      const c = await check(s, d.id).expect(200);
      expect(c.body).toMatchObject({ ready: true, problems: [] });
      const r = await publishDraft(s, d.id, saved.body.revision).expect(201);
      expect(r.body).toMatchObject({ status: 'ACTIVE', versions: 3 });
      const offer = await prisma.vendorOffer.findUniqueOrThrow({
        where: { id: r.body.offer_id },
      });
      expect(offer.status).toBe('ACTIVE');
      expect(offer.firstPublishedAt).not.toBeNull();
      expect(offer.titleEn).toBe('');
      expect(
        await prisma.auditLog.count({
          where: { entityId: offer.id, action: 'vendor_offer.status_updated' },
        }),
      ).toBe(1);
      expect(
        await prisma.outboxEvent.count({
          where: {
            eventType: 'offer.published_for_followers',
            payload: { path: ['offer_id'], equals: offer.id },
          },
        }),
      ).toBe(1);
      const draft = await prisma.offerDraft.findUniqueOrThrow({
        where: { id: d.id },
      });
      expect(draft).toMatchObject({ status: 'SUBMITTED', offerId: offer.id });
      // Afterwards the check says so (and still writes nothing).
      expect((await check(s, d.id).expect(200)).body).toMatchObject({
        status: 'SUBMITTED',
        offer_id: offer.id,
        ready: false,
      });
    });

    it('published once only: a double click / two tabs pressing «نشر» together make exactly ONE product; the other request is told which product it already is', async () => {
      const s = await f.store();
      const d = await newDraft(s);
      const saved = await save(s, d.id, 1, await readyPayload(s)).expect(200);
      const [a, b] = await Promise.all([
        publishDraft(s, d.id, saved.body.revision),
        publishDraft(s, d.id, saved.body.revision),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]);
      const won = a.status === 201 ? a : b;
      const lost = a.status === 201 ? b : a;
      expect(code(lost)).toBe('DRAFT_CLOSED');
      expect(lost.body.error.details).toEqual([
        { status: 'SUBMITTED', offer_id: won.body.offer_id },
      ]);
      expect(
        await prisma.vendorOffer.count({ where: { vendorId: s.vendorId } }),
      ).toBe(1);
      // A late third press (old page) gets the same answer, still one product.
      const third = await publishDraft(s, d.id, saved.body.revision).expect(
        409,
      );
      expect(code(third)).toBe('DRAFT_CLOSED');
      expect(
        await prisma.vendorOffer.count({ where: { vendorId: s.vendorId } }),
      ).toBe(1);
      expect(
        await prisma.outboxEvent.count({
          where: {
            eventType: 'offer.published_for_followers',
            payload: { path: ['offer_id'], equals: won.body.offer_id },
          },
        }),
      ).toBe(1);
    });

    it('a brand still waiting for approval is a clear blocking item on step 1; publishing is refused and nothing is created', async () => {
      const s = await f.store();
      const d = await newDraft(s);
      const saved = await save(s, d.id, 1, {
        ...(await readyPayload(s)),
        brand: { mode: 'request', name: `Waiting ${f.unique('w').slice(-6)}` },
      }).expect(200);
      expect(pairs(await check(s, d.id).expect(200))).toEqual([
        '1:BRAND_PENDING',
      ]);
      const r = await publishDraft(s, d.id, saved.body.revision).expect(409);
      expect(r.body.error.details).toEqual([
        { code: 'BRAND_PENDING', step: 1 },
      ]);
      expect(
        await prisma.vendorOffer.count({ where: { vendorId: s.vendorId } }),
      ).toBe(0);
    });

    it('measurements are optional: without them a gentle hint (never blocking); started but incomplete, a clear step-3 item; a measurement of another category is refused', async () => {
      const s = await f.store();
      const d = await newDraft(s);
      const p = await readyPayload(s);
      const r0 = await save(s, d.id, 1, p).expect(200);
      const c0 = await check(s, d.id).expect(200);
      expect(c0.body).toMatchObject({ ready: true, problems: [] });
      expect(c0.body.hints).toEqual([
        { code: 'MEASUREMENTS_SUGGESTED', step: 3 },
        // fabric composition and country of origin (2026-11-19): quiet, never blocking
        { code: 'COMPOSITION_SUGGESTED', step: 1 },
        { code: 'ORIGIN_SUGGESTED', step: 1 },
      ]);
      const r1 = await save(s, d.id, r0.body.revision, {
        ...p,
        measurements: { keys: ['CHEST'], values: { S: { CHEST: 86 } } },
      }).expect(200);
      expect(pairs(await check(s, d.id).expect(200))).toEqual([
        '3:MEASUREMENTS:SIZE_GUIDE_INCOMPLETE',
      ]);
      await save(s, d.id, r1.body.revision, {
        ...p,
        measurements: {
          keys: ['INSEAM'],
          values: { S: { INSEAM: 80 }, M: { INSEAM: 81 }, L: { INSEAM: 82 } },
        },
      }).expect(200);
      expect(pairs(await check(s, d.id).expect(200))).toEqual([
        '3:MEASUREMENTS:MEASUREMENT_NOT_FOR_CATEGORY',
      ]);
    });

    it('the size table: published with the product (its own guide, garment cm), shown on the product page; editable after publishing - each edit a NEW version while an order keeps the one it was bought under; removed, the page has none again', async () => {
      const s = await f.store();
      const d = await newDraft(s);
      const saved = await save(s, d.id, 1, {
        ...(await readyPayload(s)),
        measurements: TABLE,
      }).expect(200);
      const pub = await publishDraft(s, d.id, saved.body.revision).expect(201);
      const offerId = pub.body.offer_id as string;
      const guide = await prisma.sizeGuide.findUniqueOrThrow({
        where: { vendorOfferId: offerId },
        include: { versions: true },
      });
      expect(guide.kind).toBe('OFFER');
      expect(guide.versions.map((v) => [v.version, v.status, v.basis])).toEqual(
        [[1, 'PUBLISHED', 'GARMENT']],
      );
      const slug = await slugOf(s.vendorId);
      const page = await f
        .http()
        .get(`/api/v1/storefronts/${slug}/offers/${offerId}/size-guide`)
        .expect(200);
      expect(page.body.guides).toHaveLength(1);
      expect(page.body.guides[0]).toMatchObject({
        kind: 'OFFER',
        basis: 'GARMENT',
        unit: 'cm',
        version: 1,
      });
      expect(
        page.body.guides[0].rows.map((r: { size_code: string }) => r.size_code),
      ).toEqual(['S', 'M', 'L']);
      expect(page.body.guides[0].rows[1].values.CHEST).toEqual({
        min: 90,
        max: null,
      });
      expect(page.body.sizes_not_in_guide).toEqual([]);

      // An order now keeps version 1.
      const m = await prisma.offerVariant.findFirstOrThrow({
        where: { vendorOfferId: offerId, sizeCode: 'M' },
      });
      const first = await f.buy(await f.account(), s, m.id);
      const v1 = guide.versions[0].id;
      expect(
        (
          await prisma.branchOrderItem.findUniqueOrThrow({
            where: { id: first.itemId },
          })
        ).sizeGuideVersionIdSnapshot,
      ).toBe(v1);

      // The owner reads and edits the table on the product page: version 2.
      const mUrl = `/api/v1/vendors/${s.vendorId}/offers/${offerId}/measurements`;
      const read = await f.http().get(mUrl).set(as(s.owner.token)).expect(200);
      expect(read.body).toMatchObject({
        version: 1,
        allowed_keys: ['CHEST', 'WAIST', 'HIP', 'LENGTH'],
        measurements: { keys: ['CHEST', 'WAIST', 'LENGTH'] },
      });
      expect(read.body.measurements.values.M).toEqual({
        CHEST: 90,
        WAIST: 72,
        LENGTH: 121,
      });
      // after publishing, the table changes through the product's edit draft
      await editPublished(s, offerId, (p) => ({
        ...p,
        measurements: {
          ...TABLE,
          values: {
            ...TABLE.values,
            M: { CHEST: 91, WAIST: 73, LENGTH: 121 },
          },
        },
      })).expect(200);
      const versions = await prisma.sizeGuideVersion.findMany({
        where: { guideId: guide.id },
        orderBy: { version: 'asc' },
      });
      expect(versions.map((v) => [v.version, v.status])).toEqual([
        [1, 'RETIRED'],
        [2, 'PUBLISHED'],
      ]);
      expect(
        (
          await prisma.branchOrderItem.findUniqueOrThrow({
            where: { id: first.itemId },
          })
        ).sizeGuideVersionIdSnapshot,
      ).toBe(v1);
      const second = await f.buy(await f.account(), s, m.id);
      expect(
        (
          await prisma.branchOrderItem.findUniqueOrThrow({
            where: { id: second.itemId },
          })
        ).sizeGuideVersionIdSnapshot,
      ).toBe(versions[1].id);
      const page2 = await f
        .http()
        .get(`/api/v1/storefronts/${slug}/offers/${offerId}/size-guide`)
        .expect(200);
      expect(page2.body.guides[0].rows[1].values.CHEST).toEqual({
        min: 91,
        max: null,
      });

      // Refused: the direct route of a published product (edit drafts only);
      // through the edit draft, a measurement of another category never applies.
      expect(
        code(
          await f
            .http()
            .put(mUrl)
            .set(as(s.owner.token))
            .send({ measurements: null })
            .expect(409),
        ),
      ).toBe('EDIT_VIA_DRAFT');
      const bad = await editPublished(s, offerId, (p) => ({
        ...p,
        measurements: { keys: ['INSEAM'], values: { S: { INSEAM: 80 } } },
      })).expect(409);
      expect(code(bad)).toBe('DRAFT_NOT_PUBLISHABLE');
      await f
        .http()
        .delete(
          `${base(s)}/${(await prisma.offerDraft.findFirstOrThrow({ where: { editOfOfferId: offerId, status: 'OPEN' } })).id}?expected_revision=${(await prisma.offerDraft.findFirstOrThrow({ where: { editOfOfferId: offerId, status: 'OPEN' } })).revision}`,
        )
        .set(as(s.owner.token))
        .expect(200);
      const stranger = await f.account();
      await f.http().get(mUrl).set(as(stranger.token)).expect(403);

      // Removed (through the edit draft): no table of its own; the order still has its version.
      await editPublished(s, offerId, (p) => ({
        ...p,
        measurements: null,
      })).expect(200);
      const page3 = await f
        .http()
        .get(`/api/v1/storefronts/${slug}/offers/${offerId}/size-guide`)
        .expect(200);
      expect(page3.body.guides).toEqual([]);
      expect(
        (
          await prisma.branchOrderItem.findUniqueOrThrow({
            where: { id: second.itemId },
          })
        ).sizeGuideVersionIdSnapshot,
      ).toBe(versions[1].id);
    });

    it('a partial table is legitimate: a dress with chest, waist and length only publishes (hip never asked for); a measurement chosen but left empty is a step-3 item; versions and the order snapshot as before', async () => {
      const s = await f.store();
      const d = await newDraft(s);
      const p = await readyPayload(s);
      // Chosen, nothing entered yet: the table is started - its cells are required.
      const r0 = await save(s, d.id, 1, {
        ...p,
        measurements: { keys: ['CHEST', 'WAIST', 'LENGTH'], values: {} },
      }).expect(200);
      expect(pairs(await check(s, d.id).expect(200))).toEqual([
        '3:MEASUREMENTS:SIZE_GUIDE_INCOMPLETE',
      ]);
      const partial = {
        keys: ['CHEST', 'WAIST', 'LENGTH'],
        values: {
          S: { CHEST: 86, WAIST: 68, LENGTH: 120 },
          M: { CHEST: 90, WAIST: 72, LENGTH: 121 },
          L: { CHEST: 96, WAIST: 78, LENGTH: 122 },
        },
      };
      const r1 = await save(s, d.id, r0.body.revision, {
        ...p,
        measurements: partial,
      }).expect(200);
      expect((await check(s, d.id).expect(200)).body).toMatchObject({
        ready: true,
        problems: [],
        // no measurements hint (the table is there); the composition and
        // origin hints stay until they are given (quiet, never blocking)
        hints: [
          { code: 'COMPOSITION_SUGGESTED', step: 1 },
          { code: 'ORIGIN_SUGGESTED', step: 1 },
        ],
      });
      const pub = await publishDraft(s, d.id, r1.body.revision).expect(201);
      const offerId = pub.body.offer_id as string;
      const v1 = await prisma.sizeGuideVersion.findFirstOrThrow({
        where: { guide: { vendorOfferId: offerId }, status: 'PUBLISHED' },
        include: { measurements: { orderBy: { sortOrder: 'asc' } } },
      });
      expect(v1.measurements.map((m) => m.key)).toEqual([
        'CHEST',
        'WAIST',
        'LENGTH',
      ]);
      const slug = await slugOf(s.vendorId);
      const page = await f
        .http()
        .get(`/api/v1/storefronts/${slug}/offers/${offerId}/size-guide`)
        .expect(200);
      expect(
        page.body.guides[0].measurements.map((m: { key: string }) => m.key),
      ).toEqual(['CHEST', 'WAIST', 'LENGTH']);
      expect(page.body.guides[0].rows[0].values.HIP).toBeUndefined();
      const m = await prisma.offerVariant.findFirstOrThrow({
        where: { vendorOfferId: offerId, sizeCode: 'M' },
      });
      const bought = await f.buy(await f.account(), s, m.id);
      // An edit (adding hip now) is a new version; the order keeps v1.
      await editPublished(s, offerId, (p) => ({
        ...p,
        measurements: {
          keys: ['CHEST', 'WAIST', 'HIP', 'LENGTH'],
          values: {
            S: { CHEST: 86, WAIST: 68, HIP: 92, LENGTH: 120 },
            M: { CHEST: 90, WAIST: 72, HIP: 96, LENGTH: 121 },
            L: { CHEST: 96, WAIST: 78, HIP: 102, LENGTH: 122 },
          },
        },
      })).expect(200);
      expect(
        (
          await prisma.branchOrderItem.findUniqueOrThrow({
            where: { id: bought.itemId },
          })
        ).sizeGuideVersionIdSnapshot,
      ).toBe(v1.id);
      expect(
        (
          await prisma.sizeGuideVersion.findUniqueOrThrow({
            where: { id: v1.id },
          })
        ).status,
      ).toBe('RETIRED');
    });

    it('the size table on a product created earlier but not published yet (and on an imported one): added on its product page, then published from there with the same judgement', async () => {
      const s = await f.store();
      const d = await newDraft(s);
      const saved = await save(s, d.id, 1, await readyPayload(s)).expect(200);
      const created = await submit(s, d.id, saved.body.revision).expect(201);
      const offerId = created.body.offer_id as string;
      const mUrl = `/api/v1/vendors/${s.vendorId}/offers/${offerId}/measurements`;
      await f
        .http()
        .put(mUrl)
        .set(as(s.owner.token))
        .send({ measurements: TABLE })
        .expect(200);
      const pc = await f
        .http()
        .get(`/api/v1/vendors/${s.vendorId}/offers/${offerId}/publish-check`)
        .set(as(s.owner.token))
        .expect(200);
      expect(pc.body).toMatchObject({
        status: 'DRAFT',
        ready: true,
        missing: [],
      });
      await f
        .http()
        .patch(`/api/v1/vendors/${s.vendorId}/offers/${offerId}/status`)
        .set(as(s.owner.token))
        .set('Idempotency-Key', f.unique('pub'))
        .send({ status: 'ACTIVE' })
        .expect(200);
      const versions = await prisma.sizeGuideVersion.findMany({
        where: { guide: { vendorOfferId: offerId } },
      });
      expect(versions.map((v) => v.status)).toEqual(['PUBLISHED']);
    });

    it("the product page's publish check is read-only and says what is missing (an imported product: no image, no stock), the same reasons the status change refuses with", async () => {
      const s = await f.store();
      const sku = f.unique('imp');
      const csv = [
        'title_ar,seller_sku,base_price',
        `منتج مستورد,${sku},25`,
      ].join('\n');
      const imported = await f
        .http()
        .post(`/api/v1/vendors/${s.vendorId}/offers/import`)
        .set(as(s.owner.token))
        .set('Idempotency-Key', f.unique('import'))
        .attach('file', Buffer.from(csv, 'utf-8'), 'products.csv')
        .expect(201);
      expect(imported.body.invalid_rows).toEqual([]);
      const v = await prisma.offerVariant.findFirstOrThrow({
        where: { vendorId: s.vendorId, sellerSku: sku },
        include: { vendorOffer: true },
      });
      // Imported without an English name: '' (never required), a DRAFT.
      expect(v.vendorOffer).toMatchObject({
        titleAr: 'منتج مستورد',
        titleEn: '',
        status: 'DRAFT',
      });
      const audits = await prisma.auditLog.count({
        where: { entityId: v.vendorOfferId },
      });
      const pc = await f
        .http()
        .get(
          `/api/v1/vendors/${s.vendorId}/offers/${v.vendorOfferId}/publish-check`,
        )
        .set(as(s.owner.token))
        .expect(200);
      expect(pc.body.ready).toBe(false);
      expect(pc.body.missing).toEqual(
        expect.arrayContaining(['primary_image', 'available_stock']),
      );
      expect(pc.body.missing).not.toContain('title');
      expect(
        await prisma.auditLog.count({ where: { entityId: v.vendorOfferId } }),
      ).toBe(audits);
      const refused = await f
        .http()
        .patch(`/api/v1/vendors/${s.vendorId}/offers/${v.vendorOfferId}/status`)
        .set(as(s.owner.token))
        .set('Idempotency-Key', f.unique('pub'))
        .send({ status: 'ACTIVE' })
        .expect(400);
      expect(refused.body.error.details).toEqual(pc.body.missing);
    });

    it('the English name is optional everywhere: a product created and edited without one keeps it empty (whitespace is empty too)', async () => {
      const s = await f.store();
      const created = await f
        .http()
        .post(`/api/v1/vendors/${s.vendorId}/offers`)
        .set(as(s.owner.token))
        .set('Idempotency-Key', f.unique('offer'))
        .send({ title_ar: 'بلوزة', audiences: ['WOMEN'], categories: ['TOPS'] })
        .expect(201);
      expect(created.body.title_en).toBe('');
      const patched = await f
        .http()
        .put(`/api/v1/vendors/${s.vendorId}/offers/${created.body.id}`)
        .set(as(s.owner.token))
        .set('Idempotency-Key', f.unique('offer'))
        .send({ title_en: 'Blouse' })
        .expect(200);
      expect(patched.body.title_en).toBe('Blouse');
      const cleared = await f
        .http()
        .put(`/api/v1/vendors/${s.vendorId}/offers/${created.body.id}`)
        .set(as(s.owner.token))
        .set('Idempotency-Key', f.unique('offer'))
        .send({ title_en: '   ' })
        .expect(200);
      expect(cleared.body.title_en).toBe('');
    });

    it('matching and canonical naming never use an empty English name: no canonical product is ever named "", the first one who has an English name provides it', async () => {
      const naming = app.get(CanonicalNamingService);
      const s = await f.store();
      const brand = await prisma.brand.create({
        data: { name: f.unique('B'), normalizedName: f.unique('b') },
      });
      const category = await prisma.category.create({
        data: { nameAr: f.unique('ف'), nameEn: f.unique('C') },
      });
      const product = await prisma.canonicalProduct.create({
        data: {
          brandId: brand.id,
          categoryId: category.id,
          modelName: f.unique('M'),
          status: 'PUBLISHED',
        },
      });
      const offer = (titleAr: string, titleEn: string) =>
        prisma.vendorOffer.create({
          data: { vendorId: s.vendorId, titleAr, titleEn, brandId: brand.id },
        });
      const noEn = await offer('فستان كتان', '   ');
      const withEn = await offer('فستان آخر', 'Linen dress');
      const confirm = (offerId: string) =>
        prisma.$transaction((tx) =>
          naming.applyOnConfirm(
            tx,
            product.id,
            offerId,
            s.owner.userId,
            f.unique('c'),
          ),
        );
      await confirm(noEn.id);
      let p = await prisma.canonicalProduct.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(p.canonicalNameAr).toBe('فستان كتان');
      expect(p.canonicalNameEn).toBeNull();
      await confirm(withEn.id);
      p = await prisma.canonicalProduct.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(p.canonicalNameEn).toBe('Linen dress');
      // The second offer adopts the Arabic canonical name and keeps the English one.
      expect(
        await prisma.vendorOffer.findUniqueOrThrow({
          where: { id: withEn.id },
        }),
      ).toMatchObject({
        titleAr: 'فستان كتان',
        titleEn: 'Linen dress',
      });
      // An approved rename with a blank English name keeps the current one - never ''.
      await prisma.$transaction((tx) =>
        naming.applyApprovedRename(
          tx,
          product.id,
          ' فستان الكتان ',
          '  ',
          s.owner.userId,
          f.unique('r'),
        ),
      );
      p = await prisma.canonicalProduct.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(p).toMatchObject({
        canonicalNameAr: 'فستان الكتان',
        canonicalNameEn: 'Linen dress',
      });
      expect(
        await prisma.canonicalProduct.count({ where: { canonicalNameEn: '' } }),
      ).toBe(0);
    });
  });

  describe('wizard phase A++', () => {
    const check = (
      s: { vendorId: string; owner: { token: string } },
      id: string,
    ) =>
      f
        .http()
        .get(`${base(s)}/${id}/publish-check`)
        .set(as(s.owner.token));
    const publishDraft = (
      s: { vendorId: string; owner: { token: string } },
      id: string,
      revision: number,
    ) =>
      f
        .http()
        .post(`${base(s)}/${id}/publish`)
        .set(as(s.owner.token))
        .send({ expected_revision: revision });
    const pairs = (r: {
      body: { problems?: { code: string; step: number }[] };
    }) => (r.body.problems ?? []).map((p) => `${p.step}:${p.code}`);
    /** One image per store for every ready() draft (keeps the suite well under the upload rate limit). */
    const readyImage = new Map<string, Promise<string>>();
    async function ready(s: {
      vendorId: string;
      owner: { token: string };
      branchA: string;
    }) {
      if (!readyImage.has(s.vendorId))
        readyImage.set(s.vendorId, upload(s, 81));
      const image = await readyImage.get(s.vendorId)!;
      return {
        layout: 5,
        step: 5,
        audience: 'WOMEN',
        category: 'DRESSES_WOMEN',
        title_ar: `فستان ${f.unique('d').slice(-5)}`,
        brand: { mode: 'none' },
        colors: [{ code: 'FUCHSIA', images: [image] }],
        size_system: 'LETTER',
        sizes: { FUCHSIA: ['S', 'M', 'L'] },
        price: 200,
        stock: {
          [s.branchA]: { 'FUCHSIA|S': 1, 'FUCHSIA|M': 1, 'FUCHSIA|L': 1 },
        },
      };
    }
    const prices = async (offerId: string) =>
      (
        await prisma.offerVariant.findMany({
          where: { vendorOfferId: offerId },
          select: {
            basePrice: true,
            salePrice: true,
            discountPercent: true,
            discountStartAt: true,
            discountEndAt: true,
          },
        })
      ).map((v) =>
        JSON.stringify([
          Number(v.basePrice),
          v.salePrice === null ? null : Number(v.salePrice),
          v.discountPercent === null ? null : Number(v.discountPercent),
          v.discountStartAt?.toISOString() ?? null,
          v.discountEndAt?.toISOString() ?? null,
        ]),
      );

    it('item 4: fit / stretch / occasion / care are closed lists - an unknown value is a step-1 item; known codes publish and reach the public product', async () => {
      const s = await f.store();
      const d = await newDraft(s);
      const p = await ready(s);
      const r0 = await save(s, d.id, 1, {
        ...p,
        specs: { material: 'شيفون', occasion: 'PARTY', care: 'HAND_WASH,BOIL' },
      }).expect(200);
      // (the draft is stored as jsonb, which orders keys its own way)
      expect(pairs(await check(s, d.id).expect(200)).sort()).toEqual([
        '1:SPEC_INVALID:care',
        '1:SPEC_INVALID:occasion',
      ]);
      const r1 = await save(s, d.id, r0.body.revision, {
        ...p,
        specs: {
          material: 'شيفون',
          fit: 'REGULAR',
          stretch: 'SLIGHT',
          occasion: 'EVENING',
          care: 'HAND_WASH,NO_BLEACH',
        },
      }).expect(200);
      const pub = await publishDraft(s, d.id, r1.body.revision).expect(201);
      const slug = (
        await prisma.vendor.findUniqueOrThrow({ where: { id: s.vendorId } })
      ).slug;
      const pdp = await f
        .http()
        .get(`/api/v1/storefronts/${slug}/offers/${pub.body.offer_id}`)
        .expect(200);
      expect(pdp.body.template_attributes).toEqual({
        material: 'شيفون',
        fit: 'REGULAR',
        stretch: 'SLIGHT',
        occasion: 'EVENING',
        care: 'HAND_WASH,NO_BLEACH',
      });
    });

    it('item 4: the import applies the same closed lists - an unknown value names its key and the accepted codes; a known one is imported', async () => {
      const s = await f.store();
      const bad = f.unique('spec');
      const good = f.unique('spec');
      const csv = [
        'title_ar,seller_sku,base_price,category_template,template_attributes_json',
        `فستان,${bad},40,DRESSES,"{""occasion"":""PARTY""}"`,
        `فستان,${good},40,DRESSES,"{""occasion"":""EVENING"",""care"":""HAND_WASH""}"`,
      ].join('\n');
      const res = await f
        .http()
        .post(`/api/v1/vendors/${s.vendorId}/offers/import`)
        .set(as(s.owner.token))
        .set('Idempotency-Key', f.unique('import'))
        .attach('file', Buffer.from(csv, 'utf-8'), 'products.csv')
        .expect(201);
      expect(res.body.imported).toHaveLength(1);
      expect(res.body.invalid_rows).toHaveLength(1);
      expect(res.body.invalid_rows[0].reason).toContain('occasion');
      expect(res.body.invalid_rows[0].reason).toContain('EVENING');
    });

    it('condition 7: a value the import does not take yet (model, shared images, measurements, a dated discount) or an unknown column is never silently dropped - the result names the column and its rows; the template says which fields', async () => {
      const s = await f.store();
      const template = await f
        .http()
        .get(`/api/v1/vendors/${s.vendorId}/offers/import/template`)
        .set(as(s.owner.token))
        .expect(200);
      expect(template.body.not_imported_yet).toEqual(
        expect.arrayContaining([
          'model_height_cm',
          'model_size',
          'shared_images',
          'measurements_json',
          'discount_percent',
          'discount_start_at',
          'discount_end_at',
        ]),
      );
      const a = f.unique('ni');
      const b = f.unique('ni');
      const csv = [
        'title_ar,seller_sku,base_price,model_height_cm,model_size,discount_percent,colour_name,error_reason',
        `فستان,${a},40,170,M,,أحمر,old reason`,
        `فستان,${b},40,,,20,,`,
      ].join('\n');
      const res = await f
        .http()
        .post(`/api/v1/vendors/${s.vendorId}/offers/import`)
        .set(as(s.owner.token))
        .set('Idempotency-Key', f.unique('import'))
        .attach('file', Buffer.from(csv, 'utf-8'), 'products.csv')
        .expect(201);
      // The rows themselves are imported (their template columns are valid)...
      expect(res.body.imported).toHaveLength(2);
      // ...and every value that was not is named, with its rows.
      expect(res.body.not_imported).toEqual([
        {
          column: 'colour_name',
          reason: 'UNKNOWN_COLUMN',
          field: null,
          rows: [2],
        },
        {
          column: 'discount_percent',
          reason: 'NOT_IMPORTED_YET',
          field: 'DISCOUNT_WINDOW',
          rows: [3],
        },
        {
          column: 'model_height_cm',
          reason: 'NOT_IMPORTED_YET',
          field: 'MODEL',
          rows: [2],
        },
        {
          column: 'model_size',
          reason: 'NOT_IMPORTED_YET',
          field: 'MODEL',
          rows: [2],
        },
      ]);
      // Nothing of it reached the product.
      const offer = await prisma.vendorOffer.findFirstOrThrow({
        where: { vendorId: s.vendorId, variants: { some: { sellerSku: a } } },
      });
      expect([offer.modelHeightCm, offer.modelSize]).toEqual([null, null]);
    });

    const copy = (
      s: { vendorId: string; owner: { token: string } },
      body: object,
    ) => f.http().post(base(s)).set(as(s.owner.token)).send(body);
    const TABLE = {
      keys: ['CHEST', 'LENGTH'],
      values: {
        S: { CHEST: 86, LENGTH: 120 },
        M: { CHEST: 90, LENGTH: 121 },
        L: { CHEST: 96, LENGTH: 122 },
      },
    };

    it('item 1: «نسخ كمنتج جديد» from a published product WITHOUT images - a new draft with its category, specs, brand, colours, sizes, table, price and description; the name «(نسخة)»; never quantities, SKUs, status; it waits for its own images', async () => {
      const s = await f.store();
      const d = await newDraft(s);
      const r = await save(s, d.id, 1, {
        ...(await ready(s)),
        title_en: 'Dress',
        specs: { material: 'شيفون', occasion: 'EVENING' },
        measurements: TABLE,
        sku_overrides: { 'FUCHSIA|S': `MINE-${f.unique('k').slice(-6)}` },
        description_ar: 'وصف الفستان',
      }).expect(200);
      const pub = await publishDraft(s, d.id, r.body.revision).expect(201);
      const c = await copy(s, {
        copy_from: { offer_id: pub.body.offer_id },
      }).expect(201);
      const p = c.body.payload;
      expect(c.body.status).toBe('OPEN');
      expect(p.title_ar).toMatch(/ \(نسخة\)$/);
      expect(p.title_en).toBe('Dress (copy)');
      expect(p).toMatchObject({
        layout: 5,
        step: 1,
        audience: 'WOMEN',
        category: 'DRESSES_WOMEN',
        brand: { mode: 'none' },
        specs: { material: 'شيفون', occasion: 'EVENING' },
        colors: [
          { key: 'FUCHSIA', family: 'FUCHSIA', name_ar: 'فوشي', images: [] },
        ],
        size_system: 'LETTER',
        sizes: { FUCHSIA: ['S', 'M', 'L'] },
        price: 200,
        measurements: TABLE,
        description_ar: 'وصف الفستان',
      });
      expect(p.stock).toBeUndefined();
      expect(p.sku_overrides).toBeUndefined();
      expect(pairs(await check(s, c.body.id).expect(200))).toEqual(
        expect.arrayContaining([
          '2:COLOR_IMAGE_REQUIRED:FUCHSIA',
          '4:STOCK_REQUIRED',
        ]),
      );
      expect(
        await prisma.auditLog.count({
          where: { entityId: c.body.id, action: 'offer_draft.copied' },
        }),
      ).toBe(1);
      // Another store can never copy it.
      const other = await f.store();
      await copy(other, { copy_from: { offer_id: pub.body.offer_id } }).expect(
        404,
      );
    });

    it('item 1: copied WITH images and published - two products, two separate size tables (OFFER guides), each versioned on its own', async () => {
      const s = await f.store();
      const d = await newDraft(s);
      const p0 = { ...(await ready(s)), measurements: TABLE };
      const r = await save(s, d.id, 1, p0).expect(200);
      const original = (
        await publishDraft(s, d.id, r.body.revision).expect(201)
      ).body.offer_id as string;
      const c = await copy(s, {
        copy_from: { offer_id: original },
        with_images: true,
      }).expect(201);
      expect(
        c.body.payload.colors.map((x: { key: string; images: string[] }) => [
          x.key,
          x.images,
        ]),
      ).toEqual(p0.colors.map((x) => [x.code, x.images]));
      const r2 = await save(s, c.body.id, c.body.revision, {
        ...c.body.payload,
        stock: { [s.branchA]: { 'FUCHSIA|S': 2 } },
      }).expect(200);
      const copied = (
        await publishDraft(s, c.body.id, r2.body.revision).expect(201)
      ).body.offer_id as string;
      const guides = await prisma.sizeGuide.findMany({
        where: { vendorOfferId: { in: [original, copied] } },
        include: { versions: true },
      });
      expect(guides).toHaveLength(2);
      expect(new Set(guides.map((g) => g.id)).size).toBe(2);
      await editPublished(s, copied, (p) => ({
        ...p,
        measurements: {
          ...TABLE,
          values: { ...TABLE.values, M: { CHEST: 91, LENGTH: 121 } },
        },
      })).expect(200);
      const after = await prisma.sizeGuide.findMany({
        where: { vendorOfferId: { in: [original, copied] } },
        include: { versions: { orderBy: { version: 'asc' } } },
      });
      const byOffer = new Map(
        after.map((g) => [
          g.vendorOfferId,
          g.versions.map((v) => `${v.version}:${v.status}`),
        ]),
      );
      expect(byOffer.get(original)).toEqual(['1:PUBLISHED']);
      expect(byOffer.get(copied)).toEqual(['1:RETIRED', '2:PUBLISHED']);
    });

    it('item 1 (images): the same file, each its own link - removing it from the copy never touches the original; discarding the original keeps a file the copy uses; a file is deleted only once nothing uses it', async () => {
      const s = await f.store();
      const img = await upload(s, 91);
      const extra = await upload(s, 92);
      // The original: a draft with two images.
      const d = await newDraft(s);
      const p0 = {
        ...(await ready(s)),
        colors: [{ code: 'FUCHSIA', images: [img, extra] }],
      };
      const r0 = await save(s, d.id, 1, p0).expect(200);
      const c = await copy(s, {
        copy_from: { draft_id: d.id },
        with_images: true,
      }).expect(201);
      expect(c.body.payload.colors[0].images).toEqual([img, extra]);
      // Removing `extra` from the copy: the original still has it, the file stays.
      await save(s, c.body.id, c.body.revision, {
        ...c.body.payload,
        colors: [{ code: 'FUCHSIA', images: [img] }],
        // (a copy never carries quantities - its own)
        stock: { [s.branchA]: { 'FUCHSIA|S': 1 } },
      }).expect(200);
      expect(
        (
          (await prisma.offerDraft.findUniqueOrThrow({ where: { id: d.id } }))
            .payload as { colors: { images: string[] }[] }
        ).colors[0].images,
      ).toEqual([img, extra]);
      expect(await exists(extra)).toBe(true);
      // Discarding the original: `img` is still used by the copy -> kept; `extra`
      // too, for now - the open copy's own upload ledger still lists it (the
      // clean-up never deletes a file any open draft refers to).
      await f
        .http()
        .delete(`${base(s)}/${d.id}?expected_revision=${r0.body.revision}`)
        .set(as(s.owner.token))
        .expect(200);
      expect(await exists(img)).toBe(true);
      expect(await exists(extra)).toBe(true);
      // Publishing the copy closes it: its clean-up deletes `extra` (used by
      // nothing now) and keeps `img` (the new product's image).
      const cur = await prisma.offerDraft.findUniqueOrThrow({
        where: { id: c.body.id },
      });
      const pub = await publishDraft(s, c.body.id, cur.revision).expect(201);
      expect(await exists(img)).toBe(true);
      expect(await exists(extra)).toBe(false);
      const media = await prisma.offerVariantMedia.findMany({
        where: { offerVariant: { vendorOfferId: pub.body.offer_id } },
      });
      expect(new Set(media.map((m) => m.url))).toEqual(new Set([img]));
    });

    it('item 1: copying a draft never re-requests its typed brand; the seller chooses again', async () => {
      const s = await f.store();
      const d = await newDraft(s);
      await save(s, d.id, 1, {
        ...(await ready(s)),
        brand: {
          mode: 'request',
          name: `Copy Brand ${f.unique('b').slice(-5)}`,
        },
      }).expect(200);
      const c = await copy(s, { copy_from: { draft_id: d.id } }).expect(201);
      expect(c.body.payload.brand).toBeUndefined();
      expect(
        await prisma.brandRequest.count({ where: { draftId: c.body.id } }),
      ).toBe(0);
      // Exactly one source.
      await copy(s, { copy_from: {} }).expect(400);
    });

    const copyStock = (
      s: { vendorId: string; owner: { token: string } },
      id: string,
      body: object,
    ) =>
      f
        .http()
        .post(`${base(s)}/${id}/copy-stock`)
        .set(as(s.owner.token))
        .send(body);
    const stockOf = async (id: string) =>
      (
        (await prisma.offerDraft.findUniqueOrThrow({ where: { id } }))
          .payload as { stock?: unknown }
      ).stock;

    it('item 2: «نسخ من فرع…» - ONE change at the current revision: every cell of the target takes the source quantity (0 where it has none), the rest of the draft untouched', async () => {
      const s = await f.store();
      const d = await newDraft(s);
      const p0 = await ready(s);
      const r = await save(s, d.id, 1, {
        ...p0,
        colors: [
          { code: 'FUCHSIA', images: p0.colors[0].images },
          { code: 'WHITE', images: p0.colors[0].images },
        ],
        sizes: { FUCHSIA: ['S', 'M', 'L'], WHITE: ['M'] },
        stock: {
          [s.branchA]: { 'FUCHSIA|S': 4, 'FUCHSIA|L': 2, 'WHITE|M': 7 },
          [s.branchB]: { 'FUCHSIA|S': 9, 'FUCHSIA|M': 9, 'WHITE|M': 9 },
        },
      }).expect(200);
      const c = await copyStock(s, d.id, {
        expected_revision: r.body.revision,
        from_branch_id: s.branchA,
        to_branch_id: s.branchB,
      }).expect(200);
      expect(c.body.revision).toBe(r.body.revision + 1);
      expect(c.body.payload.stock).toEqual({
        [s.branchA]: { 'FUCHSIA|S': 4, 'FUCHSIA|L': 2, 'WHITE|M': 7 },
        [s.branchB]: { 'FUCHSIA|S': 4, 'FUCHSIA|L': 2, 'WHITE|M': 7 },
      });
      expect(c.body.payload.price).toBe(200);
      expect(c.body.payload.sizes).toEqual({
        FUCHSIA: ['S', 'M', 'L'],
        WHITE: ['M'],
      });
      const audit = await prisma.auditLog.findMany({
        where: { entityId: d.id, action: 'offer_draft.stock_copied' },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0].afterState).toMatchObject({
        from_branch_id: s.branchA,
        to_branch_id: s.branchB,
        cells: 4,
      });
    });

    it("item 2: all or nothing - a stale revision (another tab saved first), the same branch, or a branch that is not this store's leaves every quantity exactly as it was", async () => {
      const s = await f.store();
      const d = await newDraft(s);
      const r = await save(s, d.id, 1, {
        ...(await ready(s)),
        stock: {
          [s.branchA]: { 'FUCHSIA|S': 3 },
          [s.branchB]: { 'FUCHSIA|M': 5 },
        },
      }).expect(200);
      // Another tab saves a change first.
      const newer = await save(s, d.id, r.body.revision, {
        ...r.body.payload,
        stock: {
          [s.branchA]: { 'FUCHSIA|S': 3 },
          [s.branchB]: { 'FUCHSIA|M': 6 },
        },
      }).expect(200);
      const before = await stockOf(d.id);
      const stale = await copyStock(s, d.id, {
        expected_revision: r.body.revision,
        from_branch_id: s.branchA,
        to_branch_id: s.branchB,
      }).expect(409);
      expect(code(stale)).toBe('DRAFT_REVISION_CONFLICT');
      expect(await stockOf(d.id)).toEqual(before);
      const same = await copyStock(s, d.id, {
        expected_revision: newer.body.revision,
        from_branch_id: s.branchA,
        to_branch_id: s.branchA,
      }).expect(400);
      expect(code(same)).toBe('SAME_BRANCH');
      const other = await f.store();
      const foreign = await copyStock(s, d.id, {
        expected_revision: newer.body.revision,
        from_branch_id: other.branchA,
        to_branch_id: s.branchB,
      }).expect(400);
      expect(code(foreign)).toBe('BRANCH_NOT_FOUND');
      const row = await prisma.offerDraft.findUniqueOrThrow({
        where: { id: d.id },
      });
      expect(row.revision).toBe(newer.body.revision);
      expect(row.payload).toMatchObject({ stock: before });
      expect(
        await prisma.auditLog.count({
          where: { entityId: d.id, action: 'offer_draft.stock_copied' },
        }),
      ).toBe(0);
      // Another store cannot touch this draft at all.
      await copyStock(other, d.id, {
        expected_revision: newer.body.revision,
        from_branch_id: other.branchA,
        to_branch_id: other.branchB,
      }).expect(404);
    });

    const slugOfStore = async (vendorId: string) =>
      (await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } })).slug;
    const offersBase = (s: { vendorId: string }, offerId: string) =>
      `/api/v1/vendors/${s.vendorId}/offers/${offerId}`;

    it("item 5: model information - optional; when given, both a height of 100-220 cm and one of THIS product's sizes, checked in the draft (step 3), stored on the product and shown on its page", async () => {
      const s = await f.store();
      const d = await newDraft(s);
      const p0 = await ready(s);
      let r = await save(s, d.id, 1, {
        ...p0,
        model: { height_cm: 170, size: 'XL' },
      }).expect(200);
      expect(pairs(await check(s, d.id).expect(200))).toContain(
        '3:MODEL_SIZE_NOT_IN_PRODUCT',
      );
      r = await save(s, d.id, r.body.revision, {
        ...p0,
        model: { height_cm: 95, size: 'M' },
      }).expect(200);
      expect(pairs(await check(s, d.id).expect(200))).toContain(
        '3:MODEL_HEIGHT_RANGE',
      );
      r = await save(s, d.id, r.body.revision, {
        ...p0,
        model: { height_cm: 170, size: null },
      }).expect(200);
      expect(pairs(await check(s, d.id).expect(200))).toContain(
        '3:MODEL_INCOMPLETE',
      );
      await publishDraft(s, d.id, r.body.revision).expect(409);
      // Not a whole number: refused as a shape, never stored.
      await save(s, d.id, r.body.revision, {
        ...p0,
        model: { height_cm: 170.5, size: 'M' },
      }).expect(400);
      r = await save(s, d.id, r.body.revision, {
        ...p0,
        model: { height_cm: 170, size: 'M' },
      }).expect(200);
      expect(pairs(await check(s, d.id).expect(200))).toEqual([]);
      const offerId = (await publishDraft(s, d.id, r.body.revision).expect(201))
        .body.offer_id as string;
      expect(
        await prisma.vendorOffer.findUniqueOrThrow({
          where: { id: offerId },
          select: { modelHeightCm: true, modelSize: true },
        }),
      ).toEqual({ modelHeightCm: 170, modelSize: 'M' });
      const page = await f
        .http()
        .get(
          `/api/v1/storefronts/${await slugOfStore(s.vendorId)}/offers/${offerId}`,
        )
        .expect(200);
      expect(page.body.model).toEqual({
        height_cm: 170,
        size_code: 'M',
        size_label: 'M',
      });
      // Without model information: none, and nothing to complete.
      const d2 = await newDraft(s);
      const r2 = await save(s, d2.id, 1, await ready(s)).expect(200);
      const plain = (await publishDraft(s, d2.id, r2.body.revision).expect(201))
        .body.offer_id as string;
      expect(
        (
          await f
            .http()
            .get(
              `/api/v1/storefronts/${await slugOfStore(s.vendorId)}/offers/${plain}`,
            )
            .expect(200)
        ).body.model,
      ).toBeNull();
    });

    it('item 5 (product page): the same rule on PUT .../model - one of its own sizes only, 100-220 cm, both or neither; null clears it; another store reads 404', async () => {
      const s = await f.store();
      const d = await newDraft(s);
      const r = await save(s, d.id, 1, await ready(s)).expect(200);
      // created, not published: its content is still edited directly
      const offerId = (await submit(s, d.id, r.body.revision).expect(201)).body
        .offer_id as string;
      const put = (body: object, who = s) =>
        f
          .http()
          .put(`${offersBase(who, offerId)}/model`)
          .set(as(who.owner.token))
          .send(body);
      expect(code(await put({ height_cm: 168, size: 'XL' }).expect(400))).toBe(
        'MODEL_SIZE_NOT_IN_PRODUCT',
      );
      expect(code(await put({ height_cm: 230, size: 'S' }).expect(400))).toBe(
        'MODEL_HEIGHT_RANGE',
      );
      expect(code(await put({ height_cm: null, size: 'S' }).expect(400))).toBe(
        'MODEL_INCOMPLETE',
      );
      const ok = await put({ height_cm: 168, size: 'S' }).expect(200);
      expect(ok.body.model).toEqual({ height_cm: 168, size: 'S' });
      expect(ok.body.sizes.map((x: { code: string }) => x.code)).toEqual([
        'S',
        'M',
        'L',
      ]);
      expect(
        (await put({ height_cm: null, size: null }).expect(200)).body.model,
      ).toBeNull();
      // The database itself refuses half of it.
      await expect(
        prisma.vendorOffer.update({
          where: { id: offerId },
          data: { modelHeightCm: 170 },
        }),
      ).rejects.toThrow();
      const other = await f.store();
      await f
        .http()
        .put(`${offersBase(s, offerId)}/model`)
        .set(as(other.owner.token))
        .send({ height_cm: 168, size: 'S' })
        .expect(403);
      await f
        .http()
        .get(`${offersBase(other, offerId)}/presentation`)
        .set(as(other.owner.token))
        .expect(404);
    });

    it("item 6: shared images - never a colour's main image; created as the product's own links, shown after the colour images; the upload reports the image size", async () => {
      const s = await f.store();
      const up = await f
        .http()
        .post(`/api/v1/vendors/${s.vendorId}/uploads`)
        .set(as(s.owner.token))
        .attach('file', await png(33), 'a.png')
        .expect(201);
      expect(up.body).toMatchObject({ width: 8, height: 8 });
      const shared = up.body.url as string;
      const d = await newDraft(s);
      const p0 = await ready(s);
      // A colour without its own image is still incomplete, whatever is shared.
      let r = await save(s, d.id, 1, {
        ...p0,
        colors: [{ code: 'FUCHSIA', images: [] }],
        shared_images: [shared],
      }).expect(200);
      expect(pairs(await check(s, d.id).expect(200))).toContain(
        '2:COLOR_IMAGE_REQUIRED:FUCHSIA',
      );
      // At most six, and only this store's own uploads.
      await save(s, d.id, r.body.revision, {
        ...p0,
        shared_images: Array.from({ length: 7 }, () => shared),
      }).expect(400);
      const other = await f.store();
      const foreign = shared.replace(s.vendorId, other.vendorId);
      await save(s, d.id, r.body.revision, {
        ...p0,
        shared_images: [foreign],
      }).expect(400);
      r = await save(s, d.id, r.body.revision, {
        ...p0,
        shared_images: [shared],
      }).expect(200);
      const offerId = (await publishDraft(s, d.id, r.body.revision).expect(201))
        .body.offer_id as string;
      expect(
        (
          await prisma.vendorOfferSharedMedia.findMany({
            where: { vendorOfferId: offerId },
          })
        ).map((m) => [m.url, m.sortOrder]),
      ).toEqual([[shared, 0]]);
      // Not copied into any version's own images.
      const media = await prisma.offerVariantMedia.findMany({
        where: { offerVariant: { vendorOfferId: offerId } },
      });
      expect(media.some((m) => m.url === shared)).toBe(false);
      const page = await f
        .http()
        .get(
          `/api/v1/storefronts/${await slugOfStore(s.vendorId)}/offers/${offerId}`,
        )
        .expect(200);
      expect(page.body.shared_images).toEqual([shared]);
    });

    it('item 6 (independence): the same shared file, each product its own link - removing it from the copy never touches the original; the clean-up never deletes a file a product still shares', async () => {
      const s = await f.store();
      const shared = await upload(s, 35);
      const d = await newDraft(s);
      const r = await save(s, d.id, 1, {
        ...(await ready(s)),
        shared_images: [shared],
      }).expect(200);
      const original = (
        await publishDraft(s, d.id, r.body.revision).expect(201)
      ).body.offer_id as string;
      const c = await copy(s, {
        copy_from: { offer_id: original },
        with_images: true,
      }).expect(201);
      expect(c.body.payload.shared_images).toEqual([shared]);
      const r2 = await save(s, c.body.id, c.body.revision, {
        ...c.body.payload,
        stock: { [s.branchA]: { 'FUCHSIA|S': 1 } },
      }).expect(200);
      const copied = (
        await publishDraft(s, c.body.id, r2.body.revision).expect(201)
      ).body.offer_id as string;
      const links = await prisma.vendorOfferSharedMedia.findMany({
        where: { url: shared },
      });
      expect(new Set(links.map((l) => l.vendorOfferId))).toEqual(
        new Set([original, copied]),
      );
      // Removing it from the copy: the original keeps its link and the file.
      await editPublished(s, copied, (p) => ({
        ...p,
        shared_images: [],
      })).expect(200);
      expect(
        (
          await f
            .http()
            .get(`${offersBase(s, original)}/presentation`)
            .set(as(s.owner.token))
            .expect(200)
        ).body.shared_images,
      ).toEqual([shared]);
      expect(await exists(shared)).toBe(true);
      // A draft that held it and is discarded: the product still shares it, so the file stays.
      const d3 = await newDraft(s);
      const r3 = await save(s, d3.id, 1, {
        shared_images: [shared],
        title_ar: 'مؤقت',
      }).expect(200);
      await f
        .http()
        .delete(`${base(s)}/${d3.id}?expected_revision=${r3.body.revision}`)
        .set(as(s.owner.token))
        .expect(200);
      expect(await exists(shared)).toBe(true);
      // Removing it from the original too: no product links it; the file is never deleted by an offer edit.
      await editPublished(s, original, (p) => ({
        ...p,
        shared_images: [],
      })).expect(200);
      expect(
        await prisma.vendorOfferSharedMedia.count({ where: { url: shared } }),
      ).toBe(0);
      expect(await exists(shared)).toBe(true);
      // Without images, a copy shares nothing.
      const bare = await copy(s, { copy_from: { draft_id: d.id } }).expect(201);
      expect(bare.body.payload.shared_images ?? []).toEqual([]);
    });

    const previewOf = (
      s: { vendorId: string; owner: { token: string } },
      id: string,
    ) =>
      f
        .http()
        .get(`${base(s)}/${id}/preview`)
        .set(as(s.owner.token));
    /** The parts of a size-guide content a draft cannot know yet (ids, versions, dates, the guide's code). */
    const guideBody = (g: Record<string, unknown>) => {
      const { id, code, version_id, version, status, published_at, ...rest } =
        g;
      void id;
      void code;
      void version_id;
      void version;
      void status;
      void published_at;
      return rest;
    };

    it('item 3: «معاينة» shows exactly what the published page then shows - price and discount, names, images (main first, then shared), specifications, model, the size table, the choices', async () => {
      const s = await f.store();
      const shared = await upload(s, 44);
      const p0 = await ready(s);
      const d = await newDraft(s);
      const r = await save(s, d.id, 1, {
        ...p0,
        title_en: 'Evening dress',
        colors: [
          { code: 'FUCHSIA', images: p0.colors[0].images },
          { code: 'WHITE', images: [shared, ...p0.colors[0].images] },
        ],
        sizes: { FUCHSIA: ['S', 'M', 'L'], WHITE: ['M', 'L'] },
        stock: {
          [s.branchA]: { 'FUCHSIA|S': 2, 'FUCHSIA|M': 1, 'WHITE|M': 4 },
        },
        specs: {
          material: 'شيفون',
          occasion: 'EVENING',
          care: 'HAND_WASH,NO_BLEACH',
        },
        discount: { mode: 'sale', sale_price: 150 },
        model: { height_cm: 172, size: 'M' },
        shared_images: [shared],
        measurements: TABLE,
        description_ar: 'وصف المعاينة',
      }).expect(200);
      const before = {
        audit: await prisma.auditLog.count({ where: { entityId: d.id } }),
        revision: (
          await prisma.offerDraft.findUniqueOrThrow({ where: { id: d.id } })
        ).revision,
      };
      const pv = (await previewOf(s, d.id).expect(200)).body;
      // Read-only: nothing changed, nothing recorded.
      expect(await prisma.auditLog.count({ where: { entityId: d.id } })).toBe(
        before.audit,
      );
      expect(
        (await prisma.offerDraft.findUniqueOrThrow({ where: { id: d.id } }))
          .revision,
      ).toBe(before.revision);
      expect(pv.offer.purchasable).toBe(false);
      // The discounted price is there, as the shopper will see it.
      expect(pv.offer.variants[0]).toMatchObject({
        base_price: '200',
        sale_price: '150',
      });

      const offerId = (await publishDraft(s, d.id, r.body.revision).expect(201))
        .body.offer_id as string;
      const slug = await slugOfStore(s.vendorId);
      const live = (
        await f
          .http()
          .get(`/api/v1/storefronts/${slug}/offers/${offerId}`)
          .expect(200)
      ).body;
      const liveOptions = (
        await f
          .http()
          .get(`/api/v1/storefronts/${slug}/offers/${offerId}/options`)
          .expect(200)
      ).body;
      const liveGuide = (
        await f
          .http()
          .get(`/api/v1/storefronts/${slug}/offers/${offerId}/size-guide`)
          .expect(200)
      ).body;

      const pick = (o: Record<string, unknown>) => ({
        title_ar: o.title_ar,
        title_en: o.title_en,
        category_template: o.category_template,
        template_attributes: o.template_attributes,
        model: o.model,
        shared_images: o.shared_images,
        // The legacy flat list's order follows the public read's unordered
        // versions; the page uses each version's own ordered media (compared below).
        images: [...(o.images as string[])].sort(),
        size_guide_available: o.size_guide_available,
        size_guide_kind: o.size_guide_kind,
        vendor_display_name: o.vendor_display_name,
      });
      expect(pick(pv.offer)).toEqual(pick(live));
      type V = { color_code: string; size_code: string } & Record<
        string,
        unknown
      >;
      const byKey = (vs: V[]) =>
        Object.fromEntries(
          vs.map((v) => [
            `${v.color_code}|${v.size_code}`,
            {
              base_price: v.base_price,
              sale_price: v.sale_price,
              color_label: v.color_label,
              size_label: v.size_label,
              availability: v.availability,
              specs_text_ar: v.specs_text_ar,
              media: (
                v.media as {
                  url: string;
                  kind: string;
                  media_type: string;
                  sort_order: number;
                }[]
              ).map((m) => [m.url, m.kind, m.media_type, m.sort_order]),
            },
          ]),
        );
      expect(byKey(pv.offer.variants)).toEqual(byKey(live.variants));
      expect(pv.offer.model).toEqual({
        height_cm: 172,
        size_code: 'M',
        size_label: 'M',
      });
      expect(pv.offer.shared_images).toEqual([shared]);
      const optionView = (o: {
        colors: unknown;
        sizes: unknown;
        combinations: {
          color_code: string;
          size_code: string;
          availability: string;
        }[];
        audiences: unknown;
        categories: unknown;
      }) => ({
        // a draft colour's id is its key, a product colour's its own id - all else equal
        colors: (o.colors as { id: string }[]).map(({ id, ...rest }) => {
          void id;
          return rest;
        }),
        sizes: o.sizes,
        audiences: o.audiences,
        categories: o.categories,
        combinations: o.combinations
          .map((c) => `${c.color_code}|${c.size_code}:${c.availability}`)
          .sort(),
      });
      expect(optionView(pv.options)).toEqual(optionView(liveOptions));
      // WHITE|L and FUCHSIA|L have no stock: a sold-out choice in BOTH (the
      // published page lets a shopper ask for an alert on exactly that colour x size)
      for (const soldOut of ['WHITE|L:sold_out', 'FUCHSIA|L:sold_out']) {
        expect(optionView(pv.options).combinations).toContain(soldOut);
        expect(optionView(liveOptions).combinations).toContain(soldOut);
      }
      expect(pv.size_guide.guides).toHaveLength(1);
      expect(pv.size_guide.guides[0].kind).toBe('OFFER');
      expect(pv.size_guide.guides.map(guideBody)).toEqual(
        liveGuide.guides.map(guideBody),
      );
      expect(pv.size_guide.offer_sizes).toEqual(liveGuide.offer_sizes);
    });

    it('item 3: a dated percentage shows only while live; an unfinished discount or model is not shown; owner of this store only', async () => {
      const s = await f.store();
      const d = await newDraft(s);
      const hour = 3_600_000;
      const r = await save(s, d.id, 1, {
        ...(await ready(s)),
        discount: {
          mode: 'window',
          percent: 25,
          start_at: new Date(Date.now() - hour).toISOString(),
          end_at: new Date(Date.now() + 48 * hour).toISOString(),
        },
      }).expect(200);
      expect(
        (await previewOf(s, d.id).expect(200)).body.offer.variants[0],
      ).toMatchObject({ base_price: '200', sale_price: '150' });
      const r2 = await save(s, d.id, r.body.revision, {
        ...r.body.payload,
        discount: {
          mode: 'window',
          percent: 25,
          start_at: new Date(Date.now() + 24 * hour).toISOString(),
          end_at: new Date(Date.now() + 48 * hour).toISOString(),
        },
      }).expect(200);
      expect(
        (await previewOf(s, d.id).expect(200)).body.offer.variants[0]
          .sale_price,
      ).toBeNull();
      await save(s, d.id, r2.body.revision, {
        ...r2.body.payload,
        discount: { mode: 'window', percent: 25, start_at: null, end_at: null },
        model: { height_cm: 170, size: null },
      }).expect(200);
      const pv = (await previewOf(s, d.id).expect(200)).body;
      expect(pv.offer.variants[0].sale_price).toBeNull();
      expect(pv.offer.model).toBeNull();
      const other = await f.store();
      await f
        .http()
        .get(`${base(s)}/${d.id}/preview`)
        .set(as(other.owner.token))
        .expect(403);
      await f
        .http()
        .get(`${base(other)}/${d.id}/preview`)
        .set(as(other.owner.token))
        .expect(404);
    });

    it('item 7: a sale price (immediate, no dates) reaches EVERY version alike through the system price rules; the product says its price is offer-level', async () => {
      const s = await f.store();
      const d = await newDraft(s);
      const r = await save(s, d.id, 1, {
        ...(await ready(s)),
        discount: { mode: 'sale', sale_price: 150 },
      }).expect(200);
      expect((await check(s, d.id).expect(200)).body).toMatchObject({
        ready: true,
        problems: [],
      });
      const pub = await publishDraft(s, d.id, r.body.revision).expect(201);
      expect(new Set(await prices(pub.body.offer_id))).toEqual(
        new Set([JSON.stringify([200, 150, null, null, null])]),
      );
      const offer = await f
        .http()
        .get(`/api/v1/vendors/${s.vendorId}/offers/${pub.body.offer_id}`)
        .set(as(s.owner.token))
        .expect(200);
      expect(offer.body.price_is_offer_level).toBe(true);
    });

    it('item 7: a percentage for a window (start and end) reaches every version alike', async () => {
      const s = await f.store();
      const d = await newDraft(s);
      const start = '2026-12-01T08:00:00.000Z';
      const end = '2026-12-10T20:00:00.000Z';
      const r = await save(s, d.id, 1, {
        ...(await ready(s)),
        discount: { mode: 'window', percent: 20, start_at: start, end_at: end },
      }).expect(200);
      const pub = await publishDraft(s, d.id, r.body.revision).expect(201);
      expect(new Set(await prices(pub.body.offer_id))).toEqual(
        new Set([JSON.stringify([200, null, 20, start, end])]),
      );
    });

    it('item 7: the same rules refuse what PUT .../price refuses - each a step-4 item, nothing created', async () => {
      const s = await f.store();
      const d = await newDraft(s);
      const p = await ready(s);
      const cases: [object, string][] = [
        [{ mode: 'sale', sale_price: 250 }, 'DISCOUNT:INVALID_SALE_PRICE'],
        [
          {
            mode: 'window',
            percent: 120,
            start_at: '2026-12-01T00:00:00Z',
            end_at: '2026-12-02T00:00:00Z',
          },
          'DISCOUNT:DISCOUNT_PERCENT_OUT_OF_RANGE',
        ],
        [
          {
            mode: 'window',
            percent: 20,
            start_at: '2026-12-05T00:00:00Z',
            end_at: '2026-12-01T00:00:00Z',
          },
          'DISCOUNT:INVALID_DISCOUNT_WINDOW',
        ],
      ];
      let revision = 1;
      for (const [discount, code] of cases) {
        const r = await save(s, d.id, revision, { ...p, discount }).expect(200);
        revision = r.body.revision;
        expect(pairs(await check(s, d.id).expect(200))).toEqual([`4:${code}`]);
        const refused = await publishDraft(s, d.id, revision).expect(409);
        expect(refused.body.error.details).toEqual([{ code: code, step: 4 }]);
      }
      // Unfinished (chosen, not typed yet): saved as a draft, named by the check.
      for (const [discount, code] of [
        [{ mode: 'sale', sale_price: null }, 'DISCOUNT:INVALID_SALE_PRICE'],
        [
          { mode: 'window', percent: 20, start_at: null, end_at: null },
          'DISCOUNT:INCOMPLETE_DISCOUNT_WINDOW',
        ],
      ] as [object, string][]) {
        const r = await save(s, d.id, revision, { ...p, discount }).expect(200);
        revision = r.body.revision;
        expect(pairs(await check(s, d.id).expect(200))).toEqual([`4:${code}`]);
      }
      // A shape the rules do not know is refused when saved.
      await save(s, d.id, revision, {
        ...p,
        discount: { mode: 'sale-with-dates', sale_price: 100 },
      }).expect(400);
      expect(
        await prisma.vendorOffer.count({ where: { vendorId: s.vendorId } }),
      ).toBe(0);
    });
  });

  describe('product colours (offer_colors)', () => {
    const publish = (
      st: { vendorId: string; owner: { token: string } },
      id: string,
      revision: number,
    ) =>
      f
        .http()
        .post(`${base(st)}/${id}/publish`)
        .set(as(st.owner.token))
        .send({ expected_revision: revision });
    const checkOf = (
      st: { vendorId: string; owner: { token: string } },
      id: string,
    ) =>
      f
        .http()
        .get(`${base(st)}/${id}/publish-check`)
        .set(as(st.owner.token));
    const slugOf = async (vendorId: string) =>
      (await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } })).slug;
    /** A dress in two shades of beige (one family), S and M, stock in branch A. */
    async function twoBeiges(st: {
      vendorId: string;
      owner: { token: string };
      branchA: string;
    }) {
      const sand = await upload(st, 140);
      const dark = await upload(st, 141);
      return {
        payload: {
          layout: 5,
          step: 5,
          audience: 'WOMEN',
          category: 'DRESSES_WOMEN',
          title_ar: `فستان درجات ${f.unique('c').slice(-5)}`,
          brand: { mode: 'none' },
          colors: [
            {
              key: 'BEIGE',
              family: 'BEIGE',
              name_ar: 'بيج رملي',
              name_en: 'Sand beige',
              hex: '#D8C3A0',
              images: [sand],
            },
            {
              key: 'BEIGE-2',
              family: 'BEIGE',
              name_ar: 'بيج غامق',
              images: [dark],
            },
          ],
          size_system: 'LETTER',
          sizes: { BEIGE: ['S', 'M'], 'BEIGE-2': ['S', 'M'] },
          price: 120,
          stock: {
            [st.branchA]: { 'BEIGE|S': 2, 'BEIGE|M': 1, 'BEIGE-2|S': 3 },
          },
        },
        sand,
        dark,
      };
    }

    it('two shades of ONE family in one product: two product colours in the seller order, four versions (colour x size), the family kept for filters, stock per colour x size x branch, SKUs that never collide', async () => {
      const st = await f.store();
      const { payload, sand } = await twoBeiges(st);
      const d = await newDraft(st);
      const r = await save(st, d.id, 1, payload).expect(200);
      expect(
        r.body.payload.colors.map((c: { key: string; hex?: string }) => [
          c.key,
          c.hex ?? null,
        ]),
      ).toEqual([
        ['BEIGE', '#d8c3a0'],
        ['BEIGE-2', null],
      ]);
      const offerId = (await publish(st, d.id, r.body.revision).expect(201))
        .body.offer_id as string;
      const colors = await prisma.offerColor.findMany({
        where: { vendorOfferId: offerId },
        orderBy: { sortOrder: 'asc' },
      });
      expect(
        colors.map((c) => [
          c.sortOrder,
          c.familyCode,
          c.nameAr,
          c.nameEn,
          c.hex,
        ]),
      ).toEqual([
        [0, 'BEIGE', 'بيج رملي', 'Sand beige', '#d8c3a0'],
        [1, 'BEIGE', 'بيج غامق', null, null],
      ]);
      const variants = await prisma.offerVariant.findMany({
        where: { vendorOfferId: offerId },
        include: { branchStocks: true, media: true },
        orderBy: { sellerSku: 'asc' },
      });
      expect(variants).toHaveLength(4);
      expect(new Set(variants.map((v) => v.colorCode))).toEqual(
        new Set(['BEIGE']),
      );
      const p8 = offerId.slice(0, 8);
      expect(variants.map((v) => v.sellerSku).sort()).toEqual(
        [
          `${p8}-BEIGE-M`,
          `${p8}-BEIGE-S`,
          `${p8}-BEIGE2-M`,
          `${p8}-BEIGE2-S`,
        ].sort(),
      );
      const qty = (name: string, size: string) =>
        variants.find((v) => v.colour === name && v.sizeCode === size)!
          .branchStocks[0]?.quantity ?? 0;
      expect([
        qty('بيج رملي', 'S'),
        qty('بيج رملي', 'M'),
        qty('بيج غامق', 'S'),
        qty('بيج غامق', 'M'),
      ]).toEqual([2, 1, 3, 0]);
      // Each shade's own images.
      expect(
        variants
          .filter((v) => v.offerColorId === colors[0].id)
          .every((v) => v.media[0]?.url === sand),
      ).toBe(true);
      // The shopper: both shades by name, in order; the card shows the first.
      const slug = await slugOf(st.vendorId);
      const options = (
        await f
          .http()
          .get(`/api/v1/storefronts/${slug}/offers/${offerId}/options`)
          .expect(200)
      ).body;
      expect(
        options.colors.map(
          (c: { name_ar: string; family_code: string; hex: string | null }) => [
            c.name_ar,
            c.family_code,
            c.hex,
          ],
        ),
      ).toEqual([
        ['بيج رملي', 'BEIGE', '#d8c3a0'],
        ['بيج غامق', 'BEIGE', null],
      ]);
      expect(
        options.combinations.every((c: { color_id: string }) =>
          colors.some((x) => x.id === c.color_id),
        ),
      ).toBe(true);
      const detail = (
        await f
          .http()
          .get(`/api/v1/storefronts/${slug}/offers/${offerId}`)
          .expect(200)
      ).body;
      expect(
        new Set(
          detail.variants.map((v: { color_label: string }) => v.color_label),
        ),
      ).toEqual(new Set(['بيج رملي', 'بيج غامق']));
      const list = (
        await f.http().get(`/api/v1/storefronts/${slug}/products`).expect(200)
      ).body;
      const card = (list.items as { id: string; image_url: string }[]).find(
        (i) => i.id === offerId,
      )!;
      expect(card.image_url).toBe(sand);
      // Filtered by family, found by a shade's name (also normalised).
      const byFamily = (
        await f
          .http()
          .get(`/api/v1/storefronts/${slug}/products?colors=BEIGE`)
          .expect(200)
      ).body;
      expect(
        (byFamily.items as { id: string }[]).some((i) => i.id === offerId),
      ).toBe(true);
      const byName = (
        await f
          .http()
          .get(
            `/api/v1/storefronts/${slug}/products?q=${encodeURIComponent('غامق')}`,
          )
          .expect(200)
      ).body;
      expect(
        (byName.items as { id: string }[]).some((i) => i.id === offerId),
      ).toBe(true);
    });

    it('a colour name used twice (after normalisation: أ/ا, ة/ه, ى/ي, tashkeel, spaces, case) is refused with COLOR_NAME_TAKEN and the draft stays exactly as it was - never dropped', async () => {
      const st = await f.store();
      const d = await newDraft(st);
      const img = await upload(st, 142);
      const r = await save(st, d.id, 1, {
        colors: [
          { key: 'RED', family: 'RED', name_ar: 'أحمر قاني', images: [img] },
        ],
      }).expect(200);
      const bad = await save(st, d.id, r.body.revision, {
        colors: [
          { key: 'RED', family: 'RED', name_ar: 'أحمر قاني', images: [img] },
          {
            key: 'RED-2',
            family: 'BURGUNDY',
            name_ar: '  احمر   قانى ',
            images: [],
          },
        ],
      }).expect(409);
      expect(code(bad)).toBe('COLOR_NAME_TAKEN');
      const row = await prisma.offerDraft.findUniqueOrThrow({
        where: { id: d.id },
      });
      expect(row.revision).toBe(r.body.revision);
      expect((row.payload as { colors: unknown[] }).colors).toHaveLength(1);
      // Case for Latin names too; a different shade name is fine.
      await save(st, d.id, r.body.revision, {
        colors: [
          { key: 'RED', family: 'RED', name_ar: 'Wine', images: [img] },
          { key: 'RED-2', family: 'RED', name_ar: 'WINE', images: [] },
        ],
      }).expect(409);
      await save(st, d.id, r.body.revision, {
        colors: [
          { key: 'RED', family: 'RED', name_ar: 'أحمر قاني', images: [img] },
          { key: 'RED-2', family: 'RED', name_ar: 'أحمر فاتح', images: [] },
        ],
      }).expect(200);
    });

    it('the seller order: the first colour is the default (card image); a name and a family are needed before publishing; at most 30 colours', async () => {
      const st = await f.store();
      const { payload, dark } = await twoBeiges(st);
      const d = await newDraft(st);
      const r = await save(st, d.id, 1, {
        ...payload,
        colors: [payload.colors[1], payload.colors[0]],
      }).expect(200);
      const offerId = (await publish(st, d.id, r.body.revision).expect(201))
        .body.offer_id as string;
      const colors = await prisma.offerColor.findMany({
        where: { vendorOfferId: offerId },
        orderBy: { sortOrder: 'asc' },
      });
      expect(colors.map((c) => c.nameAr)).toEqual(['بيج غامق', 'بيج رملي']);
      const list = (
        await f
          .http()
          .get(`/api/v1/storefronts/${await slugOf(st.vendorId)}/products`)
          .expect(200)
      ).body;
      expect(
        (list.items as { id: string; image_url: string }[]).find(
          (i) => i.id === offerId,
        )!.image_url,
      ).toBe(dark);
      // unfinished colours are named in the check
      const d2 = await newDraft(st);
      await save(st, d2.id, 1, {
        colors: [{ key: 'c1', family: null, name_ar: '', images: [] }],
      }).expect(200);
      const pairs = (
        (await checkOf(st, d2.id).expect(200)).body.problems as {
          code: string;
          step: number;
        }[]
      ).map((p) => `${p.step}:${p.code}`);
      expect(pairs).toEqual(
        expect.arrayContaining([
          '2:COLOR_FAMILY_REQUIRED:c1',
          '2:COLOR_NAME_REQUIRED:c1',
        ]),
      );
      const many = Array.from({ length: 31 }, (_, i) => ({
        key: `k${i}`,
        family: 'RED',
        name_ar: `أحمر ${i}`,
        images: [],
      }));
      await save(st, d2.id, 2, { colors: many }).expect(400);
    });

    it('the combinations endpoint: color_code alone works only when the family is not ambiguous - two shades -> COLOR_AMBIGUOUS (nothing created); offer_color_id names the shade; a new family becomes a new product colour named after it', async () => {
      const st = await f.store();
      const { payload } = await twoBeiges(st);
      const d = await newDraft(st);
      const r = await save(st, d.id, 1, payload).expect(200);
      // created, not published: the combinations endpoint is still used directly
      const offerId = (
        await f
          .http()
          .post(`${base(st)}/${d.id}/submit`)
          .set(as(st.owner.token))
          .send({ expected_revision: r.body.revision })
          .expect(201)
      ).body.offer_id as string;
      const url = `/api/v1/vendors/${st.vendorId}/offers/${offerId}/combinations`;
      const before = await prisma.offerVariant.count({
        where: { vendorOfferId: offerId },
      });
      const amb = await f
        .http()
        .post(url)
        .set(as(st.owner.token))
        .send({ items: [{ color_code: 'BEIGE', size_code: 'L', stock: [] }] })
        .expect(409);
      expect(code(amb)).toBe('COLOR_AMBIGUOUS');
      expect(
        await prisma.offerVariant.count({ where: { vendorOfferId: offerId } }),
      ).toBe(before);
      const dark = await prisma.offerColor.findFirstOrThrow({
        where: { vendorOfferId: offerId, sortOrder: 1 },
      });
      const ok = await f
        .http()
        .post(url)
        .set(as(st.owner.token))
        .send({
          items: [{ offer_color_id: dark.id, size_code: 'L', stock: [] }],
        })
        .expect(201);
      expect(ok.body.created[0].seller_sku).toBe(
        `${offerId.slice(0, 8)}-BEIGE2-L`,
      );
      await f
        .http()
        .post(url)
        .set(as(st.owner.token))
        .send({
          items: [{ offer_color_id: dark.id, size_code: 'L', stock: [] }],
        })
        .expect(409);
      await f
        .http()
        .post(url)
        .set(as(st.owner.token))
        .send({ items: [{ color_code: 'BLACK', size_code: 'S', stock: [] }] })
        .expect(201);
      const black = await prisma.offerColor.findFirstOrThrow({
        where: { vendorOfferId: offerId, familyCode: 'BLACK' },
      });
      expect([black.nameAr, black.sortOrder]).toEqual(['أسود', 2]);
    });

    it('the database itself: one name per product (its normalize_color_name equals the API rule), a colour is never deleted, a version only uses a colour of its own product', async () => {
      for (const [input, expected] of [
        ['أحمر', 'احمر'],
        ['  بيج   رملي ', 'بيج رملي'],
        ['فوشية', 'فوشيه'],
        ['مشمشى', 'مشمشي'],
        ['\u200Fبُنـّي', 'بني'],
        ['Sand  BEIGE', 'sand beige'],
      ]) {
        const db = await prisma.$queryRaw<
          { n: string }[]
        >`SELECT normalize_color_name(${input}) AS n`;
        expect([input, db[0].n]).toEqual([input, expected]);
        expect(normalizeColorName(input)).toBe(expected);
      }
      const st = await f.store();
      const { payload } = await twoBeiges(st);
      const d = await newDraft(st);
      const r = await save(st, d.id, 1, payload).expect(200);
      const offerId = (await publish(st, d.id, r.body.revision).expect(201))
        .body.offer_id as string;
      const sand = await prisma.offerColor.findFirstOrThrow({
        where: { vendorOfferId: offerId, sortOrder: 0 },
      });
      await expect(
        prisma.offerColor.create({
          data: {
            vendorId: st.vendorId,
            vendorOfferId: offerId,
            familyCode: 'BEIGE',
            nameAr: 'بيج رملى',
            sortOrder: 5,
          },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.offerColor.delete({ where: { id: sand.id } }),
      ).rejects.toThrow(/COLOR_NOT_DELETABLE/);
      const other = await f.store();
      const { payload: p2 } = await twoBeiges(other);
      const d2 = await newDraft(other);
      const r2 = await save(other, d2.id, 1, p2).expect(200);
      const otherOffer = (
        await publish(other, d2.id, r2.body.revision).expect(201)
      ).body.offer_id as string;
      const foreignVariant = await prisma.offerVariant.findFirstOrThrow({
        where: { vendorOfferId: otherOffer },
      });
      await expect(
        prisma.$executeRaw`UPDATE offer_variants SET "offerColorId" = ${sand.id} WHERE id = ${foreignVariant.id}`,
      ).rejects.toThrow();
    });

    it('cart and order: the line shows the shade (name, HEX) and size; the order keeps a snapshot of the colour as bought, which a later rename never changes', async () => {
      const st = await f.store();
      const { payload } = await twoBeiges(st);
      const d = await newDraft(st);
      const r = await save(st, d.id, 1, payload).expect(200);
      const offerId = (await publish(st, d.id, r.body.revision).expect(201))
        .body.offer_id as string;
      const sand = await prisma.offerColor.findFirstOrThrow({
        where: { vendorOfferId: offerId, sortOrder: 0 },
      });
      const variant = await prisma.offerVariant.findFirstOrThrow({
        where: { offerColorId: sand.id, sizeCode: 'S' },
      });
      const shopper = await f.account();
      const added = await f
        .http()
        .post('/api/v1/cart/items')
        .set(as(shopper.token))
        .set('Idempotency-Key', f.unique('cart'))
        .send({
          vendor_id: st.vendorId,
          offer_variant_id: variant.id,
          quantity: 1,
        })
        .expect(201);
      const cart = (
        await f.http().get('/api/v1/cart').set(as(shopper.token)).expect(200)
      ).body;
      const line = (cart.items ?? cart) as {
        id: string;
        color_name_ar: string;
        color_hex: string;
        size_label: string;
      }[];
      expect(line.find((l) => l.id === added.body.id)).toMatchObject({
        color_name_ar: 'بيج رملي',
        color_hex: '#d8c3a0',
        size_label: 'S',
      });
      const reserved = await f
        .http()
        .post('/api/v1/checkout/reserve')
        .set(as(shopper.token))
        .set('Idempotency-Key', f.unique('reserve'))
        .send({
          terms_accepted: true,
          terms_version: '2026-10-v1',
          groups: [
            {
              cart_item_ids: [added.body.id],
              branch_id: st.branchA,
              fulfilment_method: 'PICKUP',
              payment_method: 'ONLINE',
            },
          ],
        });
      expect(reserved.status).toBe(201);
      await f
        .http()
        .post('/api/v1/checkout/confirm')
        .set(as(shopper.token))
        .set('Idempotency-Key', f.unique('confirm'))
        .send({ reservation_id: reserved.body.reservation_id })
        .expect(201);
      const item = await prisma.branchOrderItem.findFirstOrThrow({
        where: { offerVariantId: variant.id },
      });
      expect([
        item.offerColorIdSnapshot,
        item.colorNameArSnapshot,
        item.colorNameEnSnapshot,
        item.colorHexSnapshot,
        item.colorCodeSnapshot,
        item.colorLabelSnapshot,
      ]).toEqual([
        sand.id,
        'بيج رملي',
        'Sand beige',
        '#d8c3a0',
        'BEIGE',
        'بيج رملي',
      ]);
      await prisma.offerColor.update({
        where: { id: sand.id },
        data: { nameAr: 'بيج صحراوي' },
      });
      expect(
        (
          await prisma.offerVariant.findUniqueOrThrow({
            where: { id: variant.id },
          })
        ).colour,
      ).toBe('بيج صحراوي');
      const orders = (
        await f
          .http()
          .get('/api/v1/customers/me/orders')
          .set(as(shopper.token))
          .expect(200)
      ).body;
      const lines = JSON.stringify(orders);
      expect(lines).toContain('بيج رملي');
      expect(lines).not.toContain('بيج صحراوي');
    });
  });

  describe('edit drafts of a published product', () => {
    type St = Awaited<ReturnType<typeof f.store>>;
    const slugOfStore = async (vendorId: string) =>
      (await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } })).slug;
    const offers = (st: St, offerId: string) =>
      `/api/v1/vendors/${st.vendorId}/offers/${offerId}`;
    const openEdit = (st: St, offerId: string, token = st.owner.token) =>
      f
        .http()
        .post(`${base(st)}/edit-of/${offerId}`)
        .set(as(token));
    const applyEdit = (
      st: St,
      id: string,
      revision: number,
      failAfter?: string,
    ) => {
      const r = f
        .http()
        .post(`${base(st)}/${id}/apply`)
        .set(as(st.owner.token));
      if (failAfter) r.set('x-e2e-edit-fail-after', failAfter);
      return r.send({ expected_revision: revision });
    };
    const revisionOf = async (offerId: string) =>
      (await prisma.vendorOffer.findUniqueOrThrow({ where: { id: offerId } }))
        .contentRevision;

    /** A published dress: two beiges (S, M), price 200, stock in branch A. */
    async function published(st: St) {
      const sand = await upload(st, 150);
      const dark = await upload(st, 151);
      const d = await newDraft(st);
      const r = await save(st, d.id, 1, {
        layout: 5,
        step: 5,
        audience: 'WOMEN',
        category: 'DRESSES_WOMEN',
        title_ar: `فستان للتعديل ${f.unique('e').slice(-5)}`,
        brand: { mode: 'none' },
        specs: { material: 'شيفون' },
        colors: [
          {
            key: 'BEIGE',
            family: 'BEIGE',
            name_ar: 'بيج رملي',
            images: [sand],
          },
          {
            key: 'BEIGE-2',
            family: 'BEIGE',
            name_ar: 'بيج غامق',
            images: [dark],
          },
        ],
        size_system: 'LETTER',
        sizes: { BEIGE: ['S', 'M'], 'BEIGE-2': ['S', 'M'] },
        price: 200,
        measurements: {
          keys: ['CHEST'],
          values: { S: { CHEST: 86 }, M: { CHEST: 90 } },
        },
        stock: {
          [st.branchA]: {
            'BEIGE|S': 3,
            'BEIGE|M': 2,
            'BEIGE-2|S': 1,
            'BEIGE-2|M': 4,
          },
        },
        description_ar: 'الوصف الأول',
      }).expect(200);
      const offerId = (
        await f
          .http()
          .post(`${base(st)}/${d.id}/publish`)
          .set(as(st.owner.token))
          .send({ expected_revision: r.body.revision })
          .expect(201)
      ).body.offer_id as string;
      return { offerId, sand, dark };
    }

    it('one open edit draft per product, shared by the store team: the second member gets the same draft (no second one), a generic «being edited» note (no name), and the list tags it «تعديل»', async () => {
      const st = await f.store();
      const { offerId } = await published(st);
      const first = await openEdit(st, offerId).expect(201);
      expect(first.body.edit).toMatchObject({
        offer_id: offerId,
        base_revision: await revisionOf(offerId),
      });
      expect(
        first.body.payload.colors.map((c: { key: string }) => c.key),
      ).toEqual(['BEIGE', 'BEIGE-2']);
      const second = await f.account();
      await f.member(st.vendorId, second, 'OWNER', null);
      const again = await openEdit(st, offerId, second.token).expect(200);
      expect(again.body.id).toBe(first.body.id);
      expect(again.body.edit.edited_by_other_recently).toBe(true);
      expect(JSON.stringify(again.body)).not.toContain(st.owner.phone);
      expect(
        await prisma.offerDraft.count({
          where: { editOfOfferId: offerId, status: 'OPEN' },
        }),
      ).toBe(1);
      const list = (
        await f
          .http()
          .get(`/api/v1/vendors/${st.vendorId}/unpublished-products`)
          .set(as(st.owner.token))
          .expect(200)
      ).body.items;
      expect(
        list.find((i: { id: string }) => i.id === first.body.id),
      ).toMatchObject({ label: 'EDIT', edit_of_offer_id: offerId });
      // and never published as a new product (API, and the database itself)
      expect(
        code(
          await f
            .http()
            .post(`${base(st)}/${first.body.id}/publish`)
            .set(as(st.owner.token))
            .send({ expected_revision: first.body.revision })
            .expect(409),
        ),
      ).toBe('EDIT_DRAFT_USE_APPLY');
      await expect(
        prisma.offerDraft.update({
          where: { id: first.body.id },
          data: { status: 'SUBMITTED' },
        }),
      ).rejects.toThrow(/EDIT_DRAFT_NOT_SUBMITTABLE/);
    });

    it('content: the public page is unchanged while editing, the preview shows the change; applying changes name, description, specs and model at once', async () => {
      const st = await f.store();
      const { offerId } = await published(st);
      const slug = await slugOfStore(st.vendorId);
      const d = (await openEdit(st, offerId).expect(201)).body;
      const r = await save(st, d.id, d.revision, {
        ...d.payload,
        title_ar: 'فستان بعد التعديل',
        description_ar: 'وصف جديد',
        specs: { material: 'شيفون', occasion: 'EVENING' },
        model: { height_cm: 170, size: 'M' },
      }).expect(200);
      const live = (
        await f
          .http()
          .get(`/api/v1/storefronts/${slug}/offers/${offerId}`)
          .expect(200)
      ).body;
      expect(live.title_ar).not.toBe('فستان بعد التعديل');
      const pv = (
        await f
          .http()
          .get(`${base(st)}/${d.id}/preview`)
          .set(as(st.owner.token))
          .expect(200)
      ).body;
      expect(pv.offer.title_ar).toBe('فستان بعد التعديل');
      const review = (
        await f
          .http()
          .get(`${base(st)}/${d.id}/review`)
          .set(as(st.owner.token))
          .expect(200)
      ).body;
      expect(
        review.groups.map((g: { group: string }) => g.group).sort(),
      ).toEqual(['description', 'model', 'specs', 'title']);
      const before = await revisionOf(offerId);
      const done = await applyEdit(st, d.id, r.body.revision).expect(200);
      expect(done.body).toMatchObject({
        offer_id: offerId,
        status: 'ACTIVE',
        new_versions: 0,
      });
      const after = (
        await f
          .http()
          .get(`/api/v1/storefronts/${slug}/offers/${offerId}`)
          .expect(200)
      ).body;
      expect(after.title_ar).toBe('فستان بعد التعديل');
      expect(after.template_attributes).toMatchObject({ occasion: 'EVENING' });
      expect(after.model).toMatchObject({ height_cm: 170, size_code: 'M' });
      expect(
        after.variants.every(
          (v: { specs_text_ar: string }) => v.specs_text_ar === 'وصف جديد',
        ),
      ).toBe(true);
      expect(await revisionOf(offerId)).toBeGreaterThan(before);
      expect(
        (await prisma.offerDraft.findUniqueOrThrow({ where: { id: d.id } }))
          .status,
      ).toBe('APPLIED');
      expect(
        await prisma.auditLog.count({
          where: { entityId: offerId, action: 'vendor_offer.edit_applied' },
        }),
      ).toBe(1);
    });

    it('a new colour «موكا» and a new size for an existing colour, with opening quantities for the new versions only; existing stock and SKUs untouched; an existing colour or size is never removed and an existing version takes no quantity here', async () => {
      const st = await f.store();
      const { offerId } = await published(st);
      const mocha = await upload(st, 152);
      const d = (await openEdit(st, offerId).expect(201)).body;
      const p = d.payload;
      await save(st, d.id, d.revision, {
        ...p,
        colors: [p.colors[0]],
        sizes: { BEIGE: ['S', 'M'] },
      }).expect(400);
      expect(
        code(
          await save(st, d.id, d.revision, {
            ...p,
            sizes: { ...p.sizes, BEIGE: ['S'] },
          }),
        ),
      ).toBe('EDIT_REMOVE_NOT_ALLOWED');
      expect(
        code(
          await save(st, d.id, d.revision, {
            ...p,
            stock: { [st.branchA]: { 'BEIGE|S': 9 } },
          }),
        ),
      ).toBe('EDIT_STOCK_EXISTING');
      expect(
        code(
          await save(st, d.id, d.revision, { ...p, category: 'TOPS_WOMEN' }),
        ),
      ).toBe('EDIT_LOCKED_FIELD');
      const stockBefore = await prisma.branchStock.findMany({
        where: { offerVariant: { vendorOfferId: offerId } },
        select: { offerVariantId: true, quantity: true },
      });
      const skusBefore = (
        await prisma.offerVariant.findMany({
          where: { vendorOfferId: offerId },
        })
      )
        .map((v) => v.sellerSku)
        .sort();
      const r = await save(st, d.id, d.revision, {
        ...p,
        colors: [
          ...p.colors,
          {
            key: 'BROWN',
            family: 'BROWN',
            name_ar: 'موكا',
            name_en: 'Mocha',
            images: [mocha],
          },
        ],
        sizes: { ...p.sizes, BEIGE: ['S', 'M', 'L'], BROWN: ['M'] },
        stock: { [st.branchA]: { 'BEIGE|L': 2, 'BROWN|M': 5 } },
        // a new size needs its row in the product's own table
        measurements: {
          keys: ['CHEST'],
          values: { S: { CHEST: 86 }, M: { CHEST: 90 }, L: { CHEST: 94 } },
        },
      }).expect(200);
      const done = await applyEdit(st, d.id, r.body.revision).expect(200);
      expect(done.body.new_versions).toBe(2);
      const variants = await prisma.offerVariant.findMany({
        where: { vendorOfferId: offerId },
        include: { branchStocks: true, media: true, offerColor: true },
      });
      expect(variants).toHaveLength(6);
      const brownM = variants.find((v) => v.offerColor?.nameAr === 'موكا')!;
      expect([
        brownM.colorCode,
        brownM.sellerSku,
        brownM.branchStocks[0]?.quantity,
        brownM.media[0]?.url,
      ]).toEqual(['BROWN', `${offerId.slice(0, 8)}-BROWN-M`, 5, mocha]);
      const beigeL = variants.find(
        (v) => v.offerColor?.nameAr === 'بيج رملي' && v.sizeCode === 'L',
      )!;
      expect(beigeL.branchStocks[0]?.quantity).toBe(2);
      expect(beigeL.media.length).toBeGreaterThan(0);
      for (const b of stockBefore) {
        expect(
          variants.find((v) => v.id === b.offerVariantId)!.branchStocks[0]
            .quantity,
        ).toBe(b.quantity);
      }
      expect(
        skusBefore.every((sku) => variants.some((v) => v.sellerSku === sku)),
      ).toBe(true);
      expect(
        await prisma.stockMovement.count({
          where: {
            offerVariantId: { in: [brownM.id, beigeL.id] },
            reason: 'INITIAL_STOCK',
          },
        }),
      ).toBe(2);
    });

    it('the price and discount through the one price path: history per version, one follower notification (outbox, same transaction); the size table gets a new version; a requested brand still under review blocks the apply with nothing changed', async () => {
      const st = await f.store();
      const { offerId } = await published(st);
      const follower = await f.account();
      await prisma.storeFollow.create({
        data: { userId: follower.userId, vendorId: st.vendorId },
      });
      const d = (await openEdit(st, offerId).expect(201)).body;
      // a brand request still pending: nothing is applied
      const pending = await save(st, d.id, d.revision, {
        ...d.payload,
        discount: { mode: 'sale', sale_price: 150 },
        brand: {
          mode: 'request',
          name: `Edit Brand ${f.unique('b').slice(-5)}`,
        },
      }).expect(200);
      const blocked = await applyEdit(st, d.id, pending.body.revision).expect(
        409,
      );
      expect(code(blocked)).toBe('DRAFT_NOT_PUBLISHABLE');
      expect(blocked.body.error.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'BRAND_PENDING' }),
        ]),
      );
      expect(
        await prisma.priceHistory.count({
          where: {
            offerVariant: { vendorOfferId: offerId },
            salePrice: { not: null },
          },
        }),
      ).toBe(0);
      const r = await save(st, d.id, pending.body.revision, {
        ...d.payload,
        discount: { mode: 'sale', sale_price: 150 },
        measurements: {
          keys: ['CHEST'],
          values: { S: { CHEST: 87 }, M: { CHEST: 91 } },
        },
      }).expect(200);
      await applyEdit(st, d.id, r.body.revision).expect(200);
      const variants = await prisma.offerVariant.findMany({
        where: { vendorOfferId: offerId },
      });
      expect(new Set(variants.map((v) => String(v.salePrice)))).toEqual(
        new Set(['150']),
      );
      expect(
        await prisma.priceHistory.count({
          where: {
            offerVariantId: { in: variants.map((v) => v.id) },
            salePrice: { not: null },
          },
        }),
      ).toBe(4);
      expect(
        await prisma.outboxEvent.count({
          where: {
            eventType: 'offer.discount_activated_for_followers',
            payload: { path: ['vendor_id'], equals: st.vendorId },
          },
        }),
      ).toBe(1);
      const guide = await prisma.sizeGuide.findUniqueOrThrow({
        where: { vendorOfferId: offerId },
        include: { versions: { orderBy: { version: 'asc' } } },
      });
      expect(guide.versions.map((v) => `${v.version}:${v.status}`)).toEqual([
        '1:RETIRED',
        '2:PUBLISHED',
      ]);
    });

    it('conflicts: a stock change while editing never blocks; a price changed on the quick screen does - the groups are named, a group changed in both needs an explicit choice, and «تحديث المسودة» then lets it apply; two tabs on the draft are refused as before', async () => {
      const st = await f.store();
      const { offerId } = await published(st);
      const d = (await openEdit(st, offerId).expect(201)).body;
      const r = await save(st, d.id, d.revision, {
        ...d.payload,
        title_ar: 'اسم من المسودة',
        discount: { mode: 'sale', sale_price: 180 },
      }).expect(200);
      // two tabs: a stale save is refused
      expect(
        code(await save(st, d.id, d.revision, d.payload).expect(409)),
      ).toBe('DRAFT_REVISION_CONFLICT');
      // a stock movement: no content change
      const variant = await prisma.offerVariant.findFirstOrThrow({
        where: { vendorOfferId: offerId },
      });
      const rev = await revisionOf(offerId);
      await f
        .http()
        .post(
          `/api/v1/vendors/${st.vendorId}/branches/${st.branchA}/stock/${variant.id}/movements`,
        )
        .set(as(st.owner.token))
        .set('Idempotency-Key', f.unique('mv'))
        .send({
          quantity_delta: 2,
          reason: 'COUNT_CORRECTION',
          reason_note: 'edit test',
        })
        .expect(201);
      expect(await revisionOf(offerId)).toBe(rev);
      // the quick price screen: a content change elsewhere
      await f
        .http()
        .put(`${offers(st, offerId)}/price`)
        .set(as(st.owner.token))
        .send({ base_price: 210 })
        .expect(200);
      const c = await applyEdit(st, d.id, r.body.revision).expect(409);
      expect(code(c)).toBe('EDIT_CONFLICT');
      expect(c.body.error.details).toEqual([
        expect.objectContaining({
          group: 'price',
          kind: 'both',
          current: [210, null],
        }),
      ]);
      expect(
        (await prisma.vendorOffer.findUniqueOrThrow({ where: { id: offerId } }))
          .titleAr,
      ).not.toBe('اسم من المسودة');
      const review = (
        await f
          .http()
          .get(`${base(st)}/${d.id}/review`)
          .set(as(st.owner.token))
          .expect(200)
      ).body;
      expect(review.conflict.map((g: { group: string }) => g.group)).toEqual([
        'price',
      ]);
      expect(
        code(
          await f
            .http()
            .post(`${base(st)}/${d.id}/rebase`)
            .set(as(st.owner.token))
            .send({ expected_revision: r.body.revision })
            .expect(409),
        ),
      ).toBe('EDIT_CHOICE_REQUIRED');
      const rb = await f
        .http()
        .post(`${base(st)}/${d.id}/rebase`)
        .set(as(st.owner.token))
        .send({
          expected_revision: r.body.revision,
          choices: { price: 'current' },
        })
        .expect(200);
      expect([
        rb.body.payload.price,
        rb.body.payload.discount ?? null,
        rb.body.payload.title_ar,
      ]).toEqual([210, null, 'اسم من المسودة']);
      await applyEdit(st, d.id, rb.body.revision).expect(200);
      const now = await prisma.vendorOffer.findUniqueOrThrow({
        where: { id: offerId },
        include: { variants: true },
      });
      expect([
        now.titleAr,
        String(now.variants[0].basePrice),
        now.variants[0].salePrice,
      ]).toEqual(['اسم من المسودة', '210', null]);
    });

    it('a failure in the middle of applying changes nothing: price, history, notifications, colours, versions, images, revision, and the draft stays open', async () => {
      const st = await f.store();
      const { offerId } = await published(st);
      const follower = await f.account();
      await prisma.storeFollow.create({
        data: { userId: follower.userId, vendorId: st.vendorId },
      });
      const extra = await upload(st, 153);
      const d = (await openEdit(st, offerId).expect(201)).body;
      const r = await save(st, d.id, d.revision, {
        ...d.payload,
        title_ar: 'لن يُطبَّق',
        discount: { mode: 'sale', sale_price: 120 },
        colors: [
          ...d.payload.colors,
          { key: 'BROWN', family: 'BROWN', name_ar: 'موكا', images: [extra] },
        ],
        sizes: { ...d.payload.sizes, BROWN: ['S'] },
      }).expect(200);
      const snap = async () => ({
        revision: await revisionOf(offerId),
        title: (
          await prisma.vendorOffer.findUniqueOrThrow({ where: { id: offerId } })
        ).titleAr,
        prices: (
          await prisma.offerVariant.findMany({
            where: { vendorOfferId: offerId },
            orderBy: { id: 'asc' },
          })
        ).map((v) => `${v.basePrice}/${v.salePrice}`),
        history: await prisma.priceHistory.count({
          where: { offerVariant: { vendorOfferId: offerId } },
        }),
        events: await prisma.outboxEvent.count({
          where: { payload: { path: ['vendor_id'], equals: st.vendorId } },
        }),
        colors: await prisma.offerColor.count({
          where: { vendorOfferId: offerId },
        }),
        media: await prisma.offerVariantMedia.count({
          where: { offerVariant: { vendorOfferId: offerId } },
        }),
      });
      const before = await snap();
      const was = process.env.E2E_TEST_SUPPORT;
      process.env.E2E_TEST_SUPPORT = '1';
      for (const step of [
        'price',
        'colors',
        'versions',
        'images',
        'stock',
        'end',
      ]) {
        await applyEdit(st, d.id, r.body.revision, step).expect(500);
        expect(await snap()).toEqual(before);
      }
      if (was === undefined) delete process.env.E2E_TEST_SUPPORT;
      else process.env.E2E_TEST_SUPPORT = was;
      expect(
        (await prisma.offerDraft.findUniqueOrThrow({ where: { id: d.id } }))
          .status,
      ).toBe('OPEN');
      await applyEdit(st, d.id, r.body.revision).expect(200);
      expect((await snap()).title).toBe('لن يُطبَّق');
    });

    it('a paused (INACTIVE) product: the edit is applied and it stays paused (no automatic republish)', async () => {
      const st = await f.store();
      const { offerId } = await published(st);
      await f
        .http()
        .patch(`${offers(st, offerId)}/status`)
        .set(as(st.owner.token))
        .send({ status: 'INACTIVE' })
        .expect(200);
      const d = (await openEdit(st, offerId).expect(201)).body;
      const r = await save(st, d.id, d.revision, {
        ...d.payload,
        title_ar: 'معدّل وهو موقوف',
      }).expect(200);
      const done = await applyEdit(st, d.id, r.body.revision).expect(200);
      expect(done.body.status).toBe('INACTIVE');
      const o = await prisma.vendorOffer.findUniqueOrThrow({
        where: { id: offerId },
      });
      expect([o.status, o.titleAr]).toEqual(['INACTIVE', 'معدّل وهو موقوف']);
    });

    it('the server stops direct content edits of a published, classified product (409 EDIT_VIA_DRAFT) - but not its price, status or stock; an unclassified product keeps direct editing and gets no edit draft', async () => {
      const st = await f.store();
      const { offerId } = await published(st);
      const variant = await prisma.offerVariant.findFirstOrThrow({
        where: { vendorOfferId: offerId },
      });
      const tries: [string, string, object][] = [
        ['put', offers(st, offerId), { title_ar: 'مباشر' }],
        ['put', `${offers(st, offerId)}/model`, { height_cm: 170, size: 'S' }],
        ['put', `${offers(st, offerId)}/shared-images`, { urls: [] }],
        [
          'put',
          `/api/v1/vendors/${st.vendorId}/offers/${offerId}/measurements`,
          { measurements: null },
        ],
        [
          'post',
          `${offers(st, offerId)}/combinations`,
          { items: [{ color_code: 'BLACK', size_code: 'S', stock: [] }] },
        ],
        [
          'delete',
          `${offers(st, offerId)}/variants/${variant.id}/media/${'00000000-0000-4000-8000-000000000000'}`,
          {},
        ],
      ];
      for (const [m, url, body] of tries) {
        const res = await (
          f.http() as unknown as Record<
            string,
            (u: string) => {
              set: (h: object) => {
                send: (b: object) => Promise<{
                  status: number;
                  body: { error?: { code?: string } };
                }>;
              };
            }
          >
        )
          [m](url)
          .set(as(st.owner.token))
          .send(body);
        expect([url, res.status, res.body.error?.code]).toEqual([
          url,
          409,
          'EDIT_VIA_DRAFT',
        ]);
      }
      await f
        .http()
        .put(`${offers(st, offerId)}/price`)
        .set(as(st.owner.token))
        .send({ base_price: 199 })
        .expect(200);
      await f
        .http()
        .patch(`${offers(st, offerId)}/status`)
        .set(as(st.owner.token))
        .send({ status: 'INACTIVE' })
        .expect(200);
      await f
        .http()
        .post(
          `/api/v1/vendors/${st.vendorId}/branches/${st.branchA}/stock/${variant.id}/movements`,
        )
        .set(as(st.owner.token))
        .set('Idempotency-Key', f.unique('mv'))
        .send({
          quantity_delta: 1,
          reason: 'COUNT_CORRECTION',
          reason_note: 'guard test',
        })
        .expect(201);
      // an unclassified product (an older one): direct editing stays, no edit draft
      const legacy = await prisma.vendorOffer.create({
        data: {
          vendorId: st.vendorId,
          titleAr: 'قديم',
          titleEn: '',
          status: 'ACTIVE',
          firstPublishedAt: new Date(),
        },
      });
      await f
        .http()
        .put(offers(st, legacy.id))
        .set(as(st.owner.token))
        .send({ title_ar: 'قديم معدّل' })
        .expect(200);
      expect(code(await openEdit(st, legacy.id).expect(409))).toBe(
        'OFFER_NOT_CLASSIFIED_FOR_EDIT',
      );
    });

    it('checkout and holds keep their rules: a hold keeps the price the shopper saw; after an edit draft applies a new price, confirming is refused with CHECKOUT_PRICE_CHANGED (old -> new) - exactly as after the quick price screen', async () => {
      const st = await f.store();
      const { offerId } = await published(st);
      const variant = await prisma.offerVariant.findFirstOrThrow({
        where: {
          vendorOfferId: offerId,
          sizeCode: 'S',
          offerColor: { nameAr: 'بيج رملي' },
        },
      });
      const hold = async () => {
        const shopper = await f.account();
        const item = await f
          .http()
          .post('/api/v1/cart/items')
          .set(as(shopper.token))
          .set('Idempotency-Key', f.unique('cart'))
          .send({
            vendor_id: st.vendorId,
            offer_variant_id: variant.id,
            quantity: 1,
          })
          .expect(201);
        const res = await f
          .http()
          .post('/api/v1/checkout/reserve')
          .set(as(shopper.token))
          .set('Idempotency-Key', f.unique('reserve'))
          .send({
            terms_accepted: true,
            terms_version: '2026-10-v1',
            groups: [
              {
                cart_item_ids: [item.body.id],
                branch_id: st.branchA,
                fulfilment_method: 'PICKUP',
                payment_method: 'ONLINE',
              },
            ],
          })
          .expect(201);
        return { shopper, reservationId: res.body.reservation_id as string };
      };
      const confirm = (h: {
        shopper: { token: string };
        reservationId: string;
      }) =>
        f
          .http()
          .post('/api/v1/checkout/confirm')
          .set(as(h.shopper.token))
          .set('Idempotency-Key', f.unique('confirm'))
          .send({ reservation_id: h.reservationId });
      // through the edit draft
      const h1 = await hold();
      const d = (await openEdit(st, offerId).expect(201)).body;
      const r = await save(st, d.id, d.revision, {
        ...d.payload,
        price: 230,
      }).expect(200);
      await applyEdit(st, d.id, r.body.revision).expect(200);
      const c1 = await confirm(h1).expect(409);
      expect(code(c1)).toBe('CHECKOUT_PRICE_CHANGED');
      expect(c1.body.error.details).toEqual([
        expect.objectContaining({
          type: 'price_change',
          offer_variant_id: variant.id,
          old_price: 200,
          new_price: 230,
        }),
      ]);
      const kept = await prisma.checkoutReservationItem.findFirstOrThrow({
        where: { reservationId: h1.reservationId },
      });
      expect(String(kept.unitPriceAtReserve)).toBe('200');
      expect(
        await prisma.branchOrderItem.count({
          where: { offerVariantId: variant.id },
        }),
      ).toBe(0);
      // the same through the quick price screen
      const h2 = await hold();
      await f
        .http()
        .put(`${offers(st, offerId)}/price`)
        .set(as(st.owner.token))
        .send({ base_price: 240 })
        .expect(200);
      const c2 = await confirm(h2).expect(409);
      expect(code(c2)).toBe('CHECKOUT_PRICE_CHANGED');
      expect(c2.body.error.details).toEqual([
        expect.objectContaining({
          type: 'price_change',
          old_price: 230,
          new_price: 240,
        }),
      ]);
    });
  });

  describe('upload clean-up', () => {
    it("discarding removes the draft's images that nothing else uses - never one used by a product, a storefront or another open draft", async () => {
      const s = await f.store();
      const onlyMine = await upload(s, 60);
      const sharedWithDraft = await upload(s, 70);
      const logo = await upload(s, 80);
      const inProduct = await upload(s, 90);
      await prisma.vendor.update({
        where: { id: s.vendorId },
        data: { logoUrl: logo },
      });
      const other = await newDraft(s);
      await save(s, other.id, 1, {
        colors: [{ code: 'BLACK', images: [sharedWithDraft] }],
      }).expect(200);
      const product = await newDraft(s);
      const pr = await save(s, product.id, 1, {
        ...(await dressPayload(s)),
        colors: [{ code: 'BROWN', images: [inProduct] }],
        sizes: { BROWN: ['EU_38'] },
      }).expect(200);
      await submit(s, product.id, pr.body.revision).expect(201);

      const d = await newDraft(s);
      const saved = await save(s, d.id, 1, {
        colors: [
          {
            code: 'BROWN',
            images: [onlyMine, sharedWithDraft, logo, inProduct],
          },
        ],
      }).expect(200);
      const gone = await f
        .http()
        .delete(`${base(s)}/${d.id}?expected_revision=${saved.body.revision}`)
        .set(as(s.owner.token))
        .expect(200);
      expect(gone.body).toMatchObject({
        status: 'DISCARDED',
        removed_images: 1,
      });
      expect(await exists(onlyMine)).toBe(false);
      expect(await exists(sharedWithDraft)).toBe(true);
      expect(await exists(logo)).toBe(true);
      expect(await exists(inProduct)).toBe(true);
      expect(
        (
          await f.http().get(base(s)).set(as(s.owner.token)).expect(200)
        ).body.items.map((x: { id: string }) => x.id),
      ).not.toContain(d.id);
    });

    it('creating the product removes images taken out of the draft earlier; its own images stay', async () => {
      const s = await f.store();
      const d = await newDraft(s);
      const removedEarlier = await upload(s, 15);
      const r1 = await save(s, d.id, 1, {
        colors: [{ code: 'BLACK', images: [removedEarlier] }],
      }).expect(200);
      const p = await dressPayload(s);
      const r2 = await save(s, d.id, r1.body.revision, p).expect(200);
      await submit(s, d.id, r2.body.revision).expect(201);
      expect(await exists(removedEarlier)).toBe(false);
      for (const url of p.colors.flatMap((c) => c.images))
        expect(await exists(url)).toBe(true);
    });

    it('the sweep is off by default; on, it closes a draft untouched for 90 days (ABANDONED) and removes its unused images', async () => {
      const s = await f.store();
      const sweep = app.get(DraftUploadSweepService);
      const d = await newDraft(s);
      const img = await upload(s, 33);
      await save(s, d.id, 1, {
        colors: [{ code: 'BLACK', images: [img] }],
      }).expect(200);
      await prisma.$executeRaw`UPDATE offer_drafts SET "updatedAt" = now() - interval '91 days' WHERE id = ${d.id}`;
      await prisma.featureFlag.deleteMany({
        where: { key: 'offer_draft_cleanup_enabled' },
      });
      expect(await sweep.runOnce()).toMatchObject({ disabled: true });
      expect(
        (await prisma.offerDraft.findUniqueOrThrow({ where: { id: d.id } }))
          .status,
      ).toBe('OPEN');
      // On: run the work itself (other test files' drafts are never 90 days old).
      const r = await app.get(OfferDraftsService).sweepOnce();
      expect(r.abandoned).toBeGreaterThanOrEqual(1);
      expect(
        (await prisma.offerDraft.findUniqueOrThrow({ where: { id: d.id } }))
          .status,
      ).toBe('ABANDONED');
      expect(await exists(img)).toBe(false);
    });
  });
});
