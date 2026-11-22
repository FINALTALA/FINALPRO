import { execFileSync } from 'child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Client } from 'pg';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { OutboxRelayService } from './../src/outbox/outbox-relay.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { API_ROOT } from './helpers/seed-demo-db';
import { tb26Fixtures } from './helpers/tb26-fixtures';
import {
  createDisposableDatabase,
  dropDisposableDatabase,
} from './helpers/test-databases';

const MIGRATION = '20261120120000_store_collections';
const MIGRATIONS_DIR = join(API_ROOT, 'prisma', 'migrations');

// «مجموعات المتجر» (2026-11-18): the store's own manual collections on the
// store sections - the migration (nothing lost: names become Arabic names,
// visible, links keep their order), the owner API (Arabic name required,
// English optional, own-upload cover, visible/hidden, at most 20
// collections and 500 products each, bulk add at the end, moving, removing,
// a product in several collections), what shoppers see (only visible
// collections with a product they can buy; drafts, unpublished and sold-out
// products stay linked but hidden; the owner's order), the product's own
// collections set directly (no edit draft, audited), and where a version
// lives (the store notifications' deep link).
describe('Store collections (e2e)', () => {
  describe('migration', () => {
    const sharedUrl = process.env.DATABASE_URL!;
    const work = mkdtempSync(join(tmpdir(), 'collections-mig-'));
    const created: string[] = [];

    afterAll(async () => {
      for (const name of created) await dropDisposableDatabase(sharedUrl, name);
      rmSync(work, { recursive: true, force: true });
    });

    function migrationsCopy(label: string, withNew: boolean): string {
      const dir = join(work, label);
      const migrations = join(dir, 'migrations');
      for (const entry of readdirSync(MIGRATIONS_DIR, {
        withFileTypes: true,
      })) {
        if (entry.isDirectory() && entry.name >= MIGRATION && !withNew)
          continue;
        cpSync(join(MIGRATIONS_DIR, entry.name), join(migrations, entry.name), {
          recursive: true,
        });
      }
      const config = join(dir, 'prisma.config.mjs');
      writeFileSync(
        config,
        `export default ${JSON.stringify({
          schema: join(API_ROOT, 'prisma', 'schema.prisma'),
          migrations: { path: migrations },
          datasource: { url: 'env:unused' },
        })};\n`.replace('"env:unused"', 'process.env.DATABASE_URL'),
      );
      return config;
    }
    function deploy(config: string, url: string) {
      execFileSync(
        process.execPath,
        [
          require.resolve('prisma/build/index.js'),
          'migrate',
          'deploy',
          '--config',
          config,
        ],
        {
          cwd: API_ROOT,
          env: { ...process.env, DATABASE_URL: url },
          stdio: 'pipe',
        },
      );
    }

    it('existing sections become collections without loss: the name is the Arabic name, visible, no English name or cover; every link kept, in the order it was added', async () => {
      const name = `finalpro_collections_mig_${process.pid}`;
      const url = await createDisposableDatabase(sharedUrl, name);
      created.push(name);
      deploy(migrationsCopy('before', false), url);
      const db = new Client({ connectionString: url });
      await db.connect();
      try {
        const q = (sql: string, params: unknown[] = []) =>
          db.query(sql, params);
        const id = (p: string) =>
          `${p}-${Math.random().toString(36).slice(2, 10)}`;
        const vendor = id('v');
        await q(
          `INSERT INTO vendors (id, "legalName", slug) VALUES ($1, $1, $1)`,
          [vendor],
        );
        const offers: string[] = [];
        for (let i = 0; i < 3; i += 1) {
          const o = id('o');
          offers.push(o);
          await q(
            `INSERT INTO vendor_offers (id, "vendorId", "titleAr", "titleEn") VALUES ($1, $2, 'قديم', 'Legacy')`,
            [o, vendor],
          );
        }
        const s1 = id('s');
        const s2 = id('s');
        await q(
          `INSERT INTO store_sections (id, "vendorId", name, "sortOrder") VALUES ($1, $2, 'فساتين سهرة', 1), ($3, $2, 'اختيارات العيد', 0)`,
          [s1, vendor, s2],
        );
        // added out of id order: the order is the time they were added
        const link = (section: string, offer: string, minutesAgo: number) =>
          q(
            `INSERT INTO store_section_offers (id, "vendorId", "sectionId", "offerId", "createdAt") VALUES ($1, $2, $3, $4, now() - ($5 || ' minutes')::interval)`,
            [id('l'), vendor, section, offer, String(minutesAgo)],
          );
        await link(s1, offers[2], 30);
        await link(s1, offers[0], 20);
        await link(s1, offers[1], 10);
        await link(s2, offers[1], 5);

        deploy(migrationsCopy('after', true), url);

        const sections = await q(
          `SELECT id, name, "nameEn", "coverUrl", "isVisible", "sortOrder" FROM store_sections ORDER BY "sortOrder"`,
        );
        expect(sections.rows).toEqual([
          {
            id: s2,
            name: 'اختيارات العيد',
            nameEn: null,
            coverUrl: null,
            isVisible: true,
            sortOrder: 0,
          },
          {
            id: s1,
            name: 'فساتين سهرة',
            nameEn: null,
            coverUrl: null,
            isVisible: true,
            sortOrder: 1,
          },
        ]);
        const links = await q(
          `SELECT "sectionId", "offerId", "sortOrder" FROM store_section_offers ORDER BY "sectionId", "sortOrder"`,
        );
        expect(links.rows.filter((r) => r.sectionId === s1)).toEqual([
          { sectionId: s1, offerId: offers[2], sortOrder: 0 },
          { sectionId: s1, offerId: offers[0], sortOrder: 1 },
          { sectionId: s1, offerId: offers[1], sortOrder: 2 },
        ]);
        expect(links.rows.filter((r) => r.sectionId === s2)).toEqual([
          { sectionId: s2, offerId: offers[1], sortOrder: 0 },
        ]);
      } finally {
        await db.end();
      }
    });
  });

  describe('API', () => {
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
    const base = (vendorId: string) => `/api/v1/vendors/${vendorId}/sections`;
    /** A classified ACTIVE product with stock (the fixture's), its offer id. */
    async function product(s: Awaited<ReturnType<typeof f.store>>, qty = 5) {
      const variantId = await f.offer(s, qty);
      const v = await prisma.offerVariant.findUniqueOrThrow({
        where: { id: variantId },
      });
      return { offerId: v.vendorOfferId, variantId };
    }
    async function slugOf(vendorId: string) {
      return (
        await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } })
      ).slug;
    }
    const create = (
      token: string,
      vendorId: string,
      body: Record<string, unknown>,
    ) => f.http().post(base(vendorId)).set(auth(token)).send(body);

    it("create and edit: the Arabic name is required (also through the older `name`), English optional, a cover only from this store's uploads, visible by default; hide/show; at most 20 collections", async () => {
      const s = await f.store();
      const t = s.owner.token;
      await create(t, s.vendorId, { name_en: 'Evening' })
        .expect(400)
        .expect((r) =>
          expect(r.body.error.code).toBe('STORE_COLLECTION_NAME_REQUIRED'),
        );
      await create(t, s.vendorId, { name_ar: '   ' }).expect(400);
      await create(t, s.vendorId, {
        name_ar: 'غلاف',
        cover_url: 'https://example.com/x.png',
      })
        .expect(400)
        .expect((r) => expect(r.body.error.code).toBe('UPLOAD_NOT_USABLE'));
      const c = await create(t, s.vendorId, {
        name_ar: 'فساتين سهرة',
        name_en: 'Evening dresses',
      }).expect(201);
      expect(c.body).toMatchObject({
        name: 'فساتين سهرة',
        name_ar: 'فساتين سهرة',
        name_en: 'Evening dresses',
        cover_url: null,
        visible: true,
        sort_order: 0,
      });
      const legacy = await create(t, s.vendorId, { name: 'العيد' }).expect(201);
      expect(legacy.body).toMatchObject({ name_ar: 'العيد', sort_order: 1 });

      const hidden = await f
        .http()
        .patch(`${base(s.vendorId)}/${c.body.id}`)
        .set(auth(t))
        .send({ visible: false, name_en: '' })
        .expect(200);
      expect(hidden.body).toMatchObject({
        visible: false,
        name_en: null,
        name_ar: 'فساتين سهرة',
      });
      await f
        .http()
        .patch(`${base(s.vendorId)}/${c.body.id}`)
        .set(auth(t))
        .send({ name_ar: '' })
        .expect(400);

      for (let i = 2; i < 20; i += 1) {
        await create(t, s.vendorId, { name_ar: `مجموعة ${i}` }).expect(201);
      }
      await create(t, s.vendorId, { name_ar: 'الحادية والعشرون' })
        .expect(403)
        .expect((r) =>
          expect(r.body.error.code).toBe('STORE_SECTION_LIMIT_REACHED'),
        );
    });

    it("permissions: only the owner of this store - an employee and another store's owner are refused; another store's product or collection is a 404", async () => {
      const s = await f.store();
      const other = await f.store();
      const employee = await f.member(
        s.vendorId,
        await f.account(),
        'BRANCH_EMPLOYEE',
        s.branchA,
      );
      const c = await create(s.owner.token, s.vendorId, {
        name_ar: 'خاصة',
      }).expect(201);
      await f
        .http()
        .get(base(s.vendorId))
        .set(auth(employee.token))
        .expect(403);
      await create(employee.token, s.vendorId, { name_ar: 'x' }).expect(403);
      await f
        .http()
        .get(base(s.vendorId))
        .set(auth(other.owner.token))
        .expect(403);
      const foreign = await product(other);
      await f
        .http()
        .post(`${base(s.vendorId)}/${c.body.id}/offers`)
        .set(auth(s.owner.token))
        .send({ offer_ids: [foreign.offerId] })
        .expect(404);
      const otherCollection = await create(other.owner.token, other.vendorId, {
        name_ar: 'لهم',
      }).expect(201);
      await f
        .http()
        .get(`${base(s.vendorId)}/${otherCollection.body.id}`)
        .set(auth(s.owner.token))
        .expect(404);
    });

    it('bulk add goes to the END in the given order (already-in products keep their place); move and remove; a product in several collections; 500 products at most - the whole add is refused past it', async () => {
      const s = await f.store();
      const t = s.owner.token;
      const p = [];
      for (let i = 0; i < 4; i += 1) p.push(await product(s));
      const a = await create(t, s.vendorId, { name_ar: 'أ' }).expect(201);
      const b = await create(t, s.vendorId, { name_ar: 'ب' }).expect(201);
      const add = (sectionId: string, ids: string[]) =>
        f
          .http()
          .post(`${base(s.vendorId)}/${sectionId}/offers`)
          .set(auth(t))
          .send({ offer_ids: ids });
      const order = async (sectionId: string) =>
        (
          await f
            .http()
            .get(`${base(s.vendorId)}/${sectionId}`)
            .set(auth(t))
            .expect(200)
        ).body.items.map((i: { offer_id: string }) => i.offer_id);

      await add(a.body.id, [p[2].offerId, p[0].offerId]).expect(200);
      const r = await add(a.body.id, [p[0].offerId, p[3].offerId]).expect(200);
      expect(r.body).toMatchObject({
        added: [p[3].offerId],
        already_in: [p[0].offerId],
        product_count: 3,
      });
      expect(await order(a.body.id)).toEqual([
        p[2].offerId,
        p[0].offerId,
        p[3].offerId,
      ]);
      // the same product in a second collection
      await add(b.body.id, [p[0].offerId]).expect(200);
      expect(await order(b.body.id)).toEqual([p[0].offerId]);

      await f
        .http()
        .post(`${base(s.vendorId)}/${a.body.id}/offers/move`)
        .set(auth(t))
        .send({ offer_id: p[3].offerId, position: 0 })
        .expect(200);
      expect(await order(a.body.id)).toEqual([
        p[3].offerId,
        p[2].offerId,
        p[0].offerId,
      ]);
      await f
        .http()
        .post(`${base(s.vendorId)}/${a.body.id}/offers/remove`)
        .set(auth(t))
        .send({ offer_ids: [p[2].offerId] })
        .expect(200);
      expect(await order(a.body.id)).toEqual([p[3].offerId, p[0].offerId]);
      // a new one still goes last
      await f
        .http()
        .put(`${base(s.vendorId)}/${a.body.id}/offers/${p[1].offerId}`)
        .set(auth(t))
        .expect(200);
      expect(await order(a.body.id)).toEqual([
        p[3].offerId,
        p[0].offerId,
        p[1].offerId,
      ]);
      // the other collection is untouched by all of it
      expect(await order(b.body.id)).toEqual([p[0].offerId]);

      // 500 at most: 498 more fit exactly (3 + 497 = 500), one more does not.
      const many = await Promise.all(
        Array.from({ length: 498 }, async (_, i) => {
          const o = await prisma.vendorOffer.create({
            data: {
              vendorId: s.vendorId,
              titleAr: `منتج ${i}`,
              titleEn: `P ${i}`,
            },
          });
          return o.id;
        }),
      );
      await add(a.body.id, many.slice(0, 497)).expect(200);
      await add(a.body.id, many.slice(497))
        .expect(409)
        .expect((res) =>
          expect(res.body.error.code).toBe('STORE_COLLECTION_FULL'),
        );
      expect(
        await prisma.storeSectionOffer.count({
          where: { sectionId: a.body.id },
        }),
      ).toBe(500);
      const page2 = await f
        .http()
        .get(`${base(s.vendorId)}/${a.body.id}?page=2&page_size=100`)
        .set(auth(t))
        .expect(200);
      expect(page2.body).toMatchObject({
        product_count: 500,
        page: 2,
        page_size: 100,
      });
      expect(page2.body.items).toHaveLength(100);
      expect(page2.body.items[0].position).toBe(100);
    });

    it("what shoppers see: only visible collections with a product they can buy, in the owner's order; drafts, unpublished and sold-out products stay linked but are not shown; a hidden collection is refused like an unknown one; the owner sees why", async () => {
      const s = await f.store();
      const t = s.owner.token;
      const slug = await slugOf(s.vendorId);
      const inStock1 = await product(s, 5);
      const inStock2 = await product(s, 5);
      const soldOut = await product(s, 0);
      const paused = await product(s, 5);
      await prisma.vendorOffer.update({
        where: { id: paused.offerId },
        data: { status: 'INACTIVE' },
      });
      const draft = await prisma.vendorOffer.create({
        data: { vendorId: s.vendorId, titleAr: 'مسودة', titleEn: 'Draft' },
      });
      const shown = await create(t, s.vendorId, { name_ar: 'ظاهرة' }).expect(
        201,
      );
      const empty = await create(t, s.vendorId, {
        name_ar: 'بلا متاح',
      }).expect(201);
      const hidden = await create(t, s.vendorId, {
        name_ar: 'مخفية',
        visible: false,
      }).expect(201);
      const add = (sectionId: string, ids: string[]) =>
        f
          .http()
          .post(`${base(s.vendorId)}/${sectionId}/offers`)
          .set(auth(t))
          .send({ offer_ids: ids })
          .expect(200);
      await add(shown.body.id, [
        inStock2.offerId,
        soldOut.offerId,
        inStock1.offerId,
        draft.id,
      ]);
      await add(empty.body.id, [soldOut.offerId, paused.offerId, draft.id]);
      await add(hidden.body.id, [inStock1.offerId]);

      const list = await f
        .http()
        .get(`/api/v1/storefronts/${slug}/store-collections`)
        .expect(200);
      expect(list.body.items).toEqual([
        {
          id: shown.body.id,
          name_ar: 'ظاهرة',
          name_en: null,
          cover_url: null,
          count: 2,
        },
      ]);
      const products = await f
        .http()
        .get(`/api/v1/storefronts/${slug}/products?section=${shown.body.id}`)
        .expect(200);
      expect(products.body.items.map((i: { id: string }) => i.id)).toEqual([
        inStock2.offerId,
        inStock1.offerId,
      ]);
      await f
        .http()
        .get(`/api/v1/storefronts/${slug}/products?section=${hidden.body.id}`)
        .expect(400)
        .expect((r) => expect(r.body.error.code).toBe('UNKNOWN_SECTION'));
      const legacy = await f
        .http()
        .get(`/api/v1/storefronts/${slug}/sections`)
        .expect(200);
      expect(
        legacy.body.custom.map((c: { id: string }) => c.id).sort(),
      ).toEqual([shown.body.id, empty.body.id].sort());

      // the owner: every link, with whether shoppers see it and why not
      const owner = await f
        .http()
        .get(base(s.vendorId))
        .set(auth(t))
        .expect(200);
      const byId = new Map(owner.body.map((c: { id: string }) => [c.id, c]));
      expect(byId.get(shown.body.id)).toMatchObject({
        product_count: 4,
        shopper_count: 2,
        shown_to_shoppers: true,
      });
      expect(byId.get(empty.body.id)).toMatchObject({
        product_count: 3,
        shopper_count: 0,
        shown_to_shoppers: false,
      });
      expect(byId.get(hidden.body.id)).toMatchObject({
        visible: false,
        shopper_count: 1,
        shown_to_shoppers: false,
      });
      const detail = await f
        .http()
        .get(`${base(s.vendorId)}/${shown.body.id}`)
        .set(auth(t))
        .expect(200);
      expect(
        detail.body.items.map(
          (i: { offer_id: string; shown_to_shoppers: boolean }) => [
            i.offer_id,
            i.shown_to_shoppers,
          ],
        ),
      ).toEqual([
        [inStock2.offerId, true],
        [soldOut.offerId, false],
        [inStock1.offerId, true],
        [draft.id, false],
      ]);
    });

    it("a product's own collections are set directly (no edit draft, even published and classified), added last in a new one, audited; another store's collection is a 404", async () => {
      const s = await f.store();
      const other = await f.store();
      const t = s.owner.token;
      const first = await product(s);
      const p = await product(s);
      const a = await create(t, s.vendorId, { name_ar: 'أ' }).expect(201);
      const b = await create(t, s.vendorId, { name_ar: 'ب' }).expect(201);
      await f
        .http()
        .post(`${base(s.vendorId)}/${a.body.id}/offers`)
        .set(auth(t))
        .send({ offer_ids: [first.offerId] })
        .expect(200);
      const url = `/api/v1/vendors/${s.vendorId}/offers/${p.offerId}/sections`;
      await f
        .http()
        .put(url)
        .set(auth(t))
        .send({ section_ids: [a.body.id, b.body.id] })
        .expect(200);
      expect(
        (
          await f.http().get(url).set(auth(t)).expect(200)
        ).body.section_ids.sort(),
      ).toEqual([a.body.id, b.body.id].sort());
      const inA = await f
        .http()
        .get(`${base(s.vendorId)}/${a.body.id}`)
        .set(auth(t))
        .expect(200);
      expect(
        inA.body.items.map((i: { offer_id: string }) => i.offer_id),
      ).toEqual([first.offerId, p.offerId]);
      await f
        .http()
        .put(url)
        .set(auth(t))
        .send({ section_ids: [b.body.id] })
        .expect(200);
      expect(
        (await f.http().get(url).set(auth(t)).expect(200)).body.section_ids,
      ).toEqual([b.body.id]);
      const audit = await prisma.auditLog.findMany({
        where: { action: 'offer.collections_set', entityId: p.offerId },
      });
      expect(audit).toHaveLength(2);
      const theirs = await create(other.owner.token, other.vendorId, {
        name_ar: 'لهم',
      }).expect(201);
      await f
        .http()
        .put(url)
        .set(auth(t))
        .send({ section_ids: [theirs.body.id] })
        .expect(404);
    });

    it("where a version lives (store notifications): its product, colour and size - for the owner and the employee; another store's version is a 404", async () => {
      const s = await f.store();
      const other = await f.store();
      const p = await product(s);
      const employee = await f.member(
        s.vendorId,
        await f.account(),
        'BRANCH_EMPLOYEE',
        s.branchA,
      );
      for (const token of [s.owner.token, employee.token]) {
        const r = await f
          .http()
          .get(
            `/api/v1/vendors/${s.vendorId}/offer-variants/${p.variantId}/locate`,
          )
          .set(auth(token))
          .expect(200);
        expect(r.body).toMatchObject({
          variant_id: p.variantId,
          offer_id: p.offerId,
          color_code: 'BLACK',
          size_code: 'M',
        });
      }
      await f
        .http()
        .get(
          `/api/v1/vendors/${other.vendorId}/offer-variants/${p.variantId}/locate`,
        )
        .set(auth(other.owner.token))
        .expect(404);
    });
  });
});
