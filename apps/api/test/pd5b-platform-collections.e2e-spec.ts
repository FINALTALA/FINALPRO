import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';

// PD-5b.1: the platform editorial collections' admin API - PLATFORM_ADMIN
// only, slug rules, the DRAFT/PUBLISHED/ARCHIVED lifecycle, the publish
// window, ≤24 canonical products (API + database + concurrency), no
// duplicates, item order, the delete policy, archived/merged products,
// AuditLog and Idempotency-Key. Nothing public exists yet.
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

describe('PD-5b.1 platform collections admin API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

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
  });

  afterEach(async () => {
    await app.close();
  });

  const call = (
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    url: string,
    token: string | null,
    idem: string | false = unique('idem'),
  ) => {
    let r = request(app.getHttpServer())[method](`/api/v1${url}`);
    if (method !== 'get' && idem) r = r.set('Idempotency-Key', idem);
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };

  async function account(platformRole?: 'PLATFORM_ADMIN') {
    const phone = `+994${Date.now()}${(counter += 1)}`;
    const user = await prisma.user.create({
      data: {
        phone,
        passwordHash: 'not-used',
        phoneVerifiedAt: new Date(),
        platformRole,
      },
    });
    await prisma.customerProfile.create({ data: { userId: user.id } });
    const token = await app.get(SessionService).create({
      userId: user.id,
      phone,
      phoneVerifiedAt: user.phoneVerifiedAt!.toISOString(),
      sessionVersion: user.sessionVersion,
    });
    return { token, userId: user.id };
  }

  async function product(
    status: 'PUBLISHED' | 'ARCHIVED' | 'MERGED' | 'DRAFT' = 'PUBLISHED',
    mergedIntoId?: string,
  ) {
    const brand = await prisma.brand.create({
      data: { name: unique('Brand'), normalizedName: unique('b') },
    });
    const category = await prisma.category.create({
      data: { nameAr: unique('فئة'), nameEn: unique('C') },
    });
    const p = await prisma.canonicalProduct.create({
      data: {
        brandId: brand.id,
        categoryId: category.id,
        modelName: unique('M'),
        canonicalNameAr: unique('منتج'),
        status,
        ...(mergedIntoId ? { mergedIntoId } : {}),
      },
    });
    return p.id;
  }

  async function draft(
    admin: { token: string },
    extra: Record<string, unknown> = {},
  ) {
    const res = await call('post', '/admin/collections', admin.token)
      .send({
        slug: unique('col').toLowerCase(),
        title_ar: 'وصل حديثاً',
        title_en: 'New in',
        ...extra,
      })
      .expect(201);
    return res.body as { id: string; slug: string; status: string };
  }

  const audits = (entityId: string) =>
    prisma.auditLog.findMany({
      where: { entityId },
      orderBy: { occurredAt: 'asc' },
      select: { action: true, actorId: true },
    });

  it('only a platform administrator may use any of it (owner/employee/customer 403, guest 401); unknown ids are 404', async () => {
    const admin = await account('PLATFORM_ADMIN');
    const customer = await account();
    const owner = await account();
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('v').toLowerCase(),
        legalName: unique('L'),
        status: 'ACTIVE',
      },
    });
    await prisma.vendorUser.create({
      data: { userId: owner.userId, vendorId: vendor.id, role: 'OWNER' },
    });
    const branch = await prisma.storeBranch.create({
      data: {
        vendorId: vendor.id,
        name: unique('b'),
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
    const c = await draft(admin);
    const p = await product();
    const routes: [
      Parameters<typeof call>[0],
      string,
      Record<string, unknown>?,
    ][] = [
      ['get', '/admin/collections'],
      [
        'post',
        '/admin/collections',
        { slug: unique('x').toLowerCase(), title_ar: 'أ', title_en: 'A' },
      ],
      ['get', `/admin/collections/${c.id}`],
      ['patch', `/admin/collections/${c.id}`, { title_ar: 'ب' }],
      [
        'put',
        `/admin/collections/${c.id}/items`,
        { canonical_product_ids: [p] },
      ],
      ['post', `/admin/collections/${c.id}/publish`],
      ['post', `/admin/collections/${c.id}/archive`],
      ['post', `/admin/collections/${c.id}/reopen`],
      ['delete', `/admin/collections/${c.id}`],
      ['put', '/admin/collections/order', { collection_ids: [c.id] }],
    ];
    for (const [method, url, body] of routes) {
      for (const who of [owner, employee, customer]) {
        await call(method, url, who.token)
          .send(body ?? {})
          .expect(403);
      }
      await call(method, url, null)
        .send(body ?? {})
        .expect(401);
    }
    // Nothing changed.
    expect(
      (
        await prisma.platformCollection.findUniqueOrThrow({
          where: { id: c.id },
        })
      ).status,
    ).toBe('DRAFT');
    const missing = '00000000-0000-4000-8000-000000000000';
    expect(
      (
        await call('get', `/admin/collections/${missing}`, admin.token).expect(
          404,
        )
      ).body.error.code,
    ).toBe('COLLECTION_NOT_FOUND');
    await call('put', `/admin/collections/${missing}/items`, admin.token)
      .send({ canonical_product_ids: [] })
      .expect(404);
    await call('get', '/admin/collections/not-a-uuid', admin.token).expect(400);
  });

  it('creates drafts with a unique, well-formed slug and a valid publish window; edits are audited', async () => {
    const admin = await account('PLATFORM_ADMIN');
    const c = await draft(admin, {
      description_ar: 'وصف',
      audience: 'WOMEN',
      show_on_home: true,
    });
    expect(c).toMatchObject({
      status: 'DRAFT',
      live: false,
      audience: 'WOMEN',
      show_on_home: true,
      items: [],
    });
    const taken = await call('post', '/admin/collections', admin.token)
      .send({ slug: c.slug, title_ar: 'أ', title_en: 'A' })
      .expect(409);
    expect(taken.body.error.code).toBe('COLLECTION_SLUG_TAKEN');
    for (const slug of ['A-Upper', '-dash', 'x', 'a b', 'ع']) {
      await call('post', '/admin/collections', admin.token)
        .send({ slug, title_ar: 'أ', title_en: 'A' })
        .expect(400);
    }
    await call('post', '/admin/collections', admin.token)
      .send({ slug: unique('w').toLowerCase(), title_ar: '   ', title_en: 'A' })
      .expect(400);
    const from = new Date(Date.now() + 86_400_000).toISOString();
    const bad = await call('post', '/admin/collections', admin.token)
      .send({
        slug: unique('w').toLowerCase(),
        title_ar: 'أ',
        title_en: 'A',
        publish_from: from,
        publish_until: from,
      })
      .expect(400);
    expect(bad.body.error.code).toBe('INVALID_PUBLISH_WINDOW');
    // Edit: a window ending before an existing start is refused.
    await call('patch', `/admin/collections/${c.id}`, admin.token)
      .send({ publish_from: from })
      .expect(200);
    expect(
      (
        await call('patch', `/admin/collections/${c.id}`, admin.token)
          .send({ publish_until: new Date().toISOString() })
          .expect(400)
      ).body.error.code,
    ).toBe('INVALID_PUBLISH_WINDOW');
    const edited = await call(
      'patch',
      `/admin/collections/${c.id}`,
      admin.token,
    )
      .send({ title_en: 'Fresh', description_ar: null, audience: null })
      .expect(200);
    expect(edited.body).toMatchObject({
      title_en: 'Fresh',
      description_ar: null,
      audience: null,
    });
    // The same values again: no new audit row.
    await call('patch', `/admin/collections/${c.id}`, admin.token)
      .send({ title_en: 'Fresh' })
      .expect(200);
    expect((await audits(c.id)).map((a) => a.action)).toEqual([
      'platform_collection.created',
      'platform_collection.updated',
      'platform_collection.updated',
    ]);
    expect((await audits(c.id)).every((a) => a.actorId === admin.userId)).toBe(
      true,
    );
    // Writes need an Idempotency-Key; a replay with the same key returns the first answer.
    await call('post', '/admin/collections', admin.token, false)
      .send({ slug: unique('k').toLowerCase(), title_ar: 'أ', title_en: 'A' })
      .expect(422);
    const key = unique('same');
    const body = {
      slug: unique('rp').toLowerCase(),
      title_ar: 'أ',
      title_en: 'A',
    };
    const first = await call('post', '/admin/collections', admin.token, key)
      .send(body)
      .expect(201);
    const again = await call('post', '/admin/collections', admin.token, key)
      .send(body)
      .expect(201);
    expect(again.body.id).toBe(first.body.id);
    expect(
      await prisma.platformCollection.count({ where: { slug: body.slug } }),
    ).toBe(1);
  });

  it('DRAFT -> PUBLISHED -> ARCHIVED -> DRAFT; only a never-published draft can be deleted; the slug locks once published', async () => {
    const admin = await account('PLATFORM_ADMIN');
    const c = await draft(admin);
    const go = (action: string) =>
      call('post', `/admin/collections/${c.id}/${action}`, admin.token);

    expect((await go('archive').expect(409)).body.error.code).toBe(
      'COLLECTION_NEVER_PUBLISHED',
    );
    expect((await go('reopen').expect(409)).body.error.code).toBe(
      'INVALID_COLLECTION_TRANSITION',
    );
    const published = await go('publish').expect(200);
    expect(published.body).toMatchObject({
      status: 'PUBLISHED',
      live: true,
      ever_published: true,
    });
    expect((await go('publish').expect(409)).body.error.code).toBe(
      'INVALID_COLLECTION_TRANSITION',
    );
    // A published collection is not reopened (PUBLISHED -> DRAFT isn't a reopen).
    expect((await go('reopen').expect(409)).body.error.code).toBe(
      'INVALID_COLLECTION_TRANSITION',
    );
    expect(
      (
        await prisma.platformCollection.findUniqueOrThrow({
          where: { id: c.id },
        })
      ).status,
    ).toBe('PUBLISHED');
    expect(
      (
        await call('patch', `/admin/collections/${c.id}`, admin.token)
          .send({ slug: unique('n').toLowerCase() })
          .expect(409)
      ).body.error.code,
    ).toBe('COLLECTION_SLUG_LOCKED');
    expect(
      (
        await call('delete', `/admin/collections/${c.id}`, admin.token).expect(
          409,
        )
      ).body.error.code,
    ).toBe('COLLECTION_NOT_DELETABLE');
    const archived = await go('archive').expect(200);
    expect(archived.body).toMatchObject({ status: 'ARCHIVED', live: false });
    // An archived collection isn't edited until reopened.
    await call('patch', `/admin/collections/${c.id}`, admin.token)
      .send({ title_ar: 'ج' })
      .expect(409);
    await call('put', `/admin/collections/${c.id}/items`, admin.token)
      .send({ canonical_product_ids: [] })
      .expect(409);
    expect((await go('reopen').expect(200)).body.status).toBe('DRAFT');
    // Reopened, but it was published once: still not deletable.
    await call('delete', `/admin/collections/${c.id}`, admin.token).expect(409);
    expect((await audits(c.id)).map((a) => a.action)).toEqual([
      'platform_collection.created',
      'platform_collection.published',
      'platform_collection.archived',
      'platform_collection.reopened',
    ]);

    // A scheduled window: published but not live yet.
    const later = await draft(admin, {
      publish_from: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(
      (
        await call(
          'post',
          `/admin/collections/${later.id}/publish`,
          admin.token,
        ).expect(200)
      ).body,
    ).toMatchObject({
      status: 'PUBLISHED',
      live: false,
    });

    // A never-published draft is deleted - with its items - and audited.
    const gone = await draft(admin);
    await call('put', `/admin/collections/${gone.id}/items`, admin.token)
      .send({ canonical_product_ids: [await product()] })
      .expect(200);
    await call('delete', `/admin/collections/${gone.id}`, admin.token).expect(
      204,
    );
    expect(
      await prisma.platformCollection.findUnique({ where: { id: gone.id } }),
    ).toBeNull();
    expect(
      await prisma.platformCollectionItem.count({
        where: { collectionId: gone.id },
      }),
    ).toBe(0);
    expect((await audits(gone.id)).map((a) => a.action)).toContain(
      'platform_collection.deleted',
    );

    // The database refuses an impossible lifecycle on its own.
    await expect(
      prisma.platformCollection.update({
        where: { id: c.id },
        data: { status: 'PUBLISHED', publishedAt: null },
      }),
    ).rejects.toThrow();
  });

  it('items: ordered, no duplicates, at most 24 (API, database, concurrency); archived/merged products flagged and never newly added', async () => {
    const admin = await account('PLATFORM_ADMIN');
    const c = await draft(admin);
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) ids.push(await product());
    const put = (list: string[]) =>
      call('put', `/admin/collections/${c.id}/items`, admin.token).send({
        canonical_product_ids: list,
      });

    const set = await put([ids[2], ids[0], ids[1]]).expect(200);
    expect(
      set.body.items.map(
        (i: { canonical_product_id: string }) => i.canonical_product_id,
      ),
    ).toEqual([ids[2], ids[0], ids[1]]);
    expect(
      set.body.items.map((i: { sort_order: number }) => i.sort_order),
    ).toEqual([0, 1, 2]);
    await put([ids[0], ids[2]]).expect(200); // remove ids[1] + reorder
    expect((await audits(c.id)).map((a) => a.action)).toEqual([
      'platform_collection.created',
      'platform_collection_item.added',
      'platform_collection_item.removed',
      'platform_collection_item.reordered',
    ]);
    await put([ids[0], ids[0]]).expect(400); // duplicate
    await put(ids).expect(400); // 25
    expect((await put(ids.slice(0, 24)).expect(200)).body.items).toHaveLength(
      24,
    );
    const unknown = await put(['00000000-0000-4000-8000-000000000001']).expect(
      404,
    );
    expect(unknown.body.error.code).toBe('CANONICAL_PRODUCT_NOT_FOUND');

    // The database's own guards: duplicate, sort range, the 25th row.
    await expect(
      prisma.platformCollectionItem.create({
        data: {
          collectionId: c.id,
          canonicalProductId: ids[0],
          sortOrder: 23,
          addedById: admin.userId,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO platform_collection_items (id, "collectionId", "canonicalProductId", "sortOrder", "addedById") VALUES (gen_random_uuid()::text, $1, $2, 23, $3)`,
        c.id,
        ids[24],
        admin.userId,
      ),
    ).rejects.toThrow(/COLLECTION_ITEM_LIMIT|sortOrder_key|duplicate/);

    // Concurrency: two writers each adding one more item to a 23-item
    // collection at the same time - the database lets exactly one through
    // (sort positions 0-23 are unique per collection, and the limit
    // trigger serialises the count under a per-collection lock).
    const c2 = await draft(admin);
    await call('put', `/admin/collections/${c2.id}/items`, admin.token)
      .send({ canonical_product_ids: ids.slice(0, 23) })
      .expect(200);
    const results = await Promise.allSettled(
      [ids[23], ids[24]].map((pid) =>
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `INSERT INTO platform_collection_items (id, "collectionId", "canonicalProductId", "sortOrder", "addedById") VALUES (gen_random_uuid()::text, $1, $2, $3, $4)`,
            c2.id,
            pid,
            23,
            admin.userId,
          );
          await new Promise((r) => setTimeout(r, 300));
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await prisma.platformCollectionItem.count({
        where: { collectionId: c2.id },
      }),
    ).toBe(24);
    // And two concurrent API replacements both finish, leaving one valid list.
    const c3 = await draft(admin);
    const [r1, r2] = await Promise.all([
      call('put', `/admin/collections/${c3.id}/items`, admin.token).send({
        canonical_product_ids: ids.slice(0, 24),
      }),
      call('put', `/admin/collections/${c3.id}/items`, admin.token).send({
        canonical_product_ids: ids.slice(1, 25),
      }),
    ]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(
      await prisma.platformCollectionItem.count({
        where: { collectionId: c3.id },
      }),
    ).toBe(24);

    // Archived / merged: a new one is refused; one already in stays, flagged.
    const archived = await product('ARCHIVED');
    const survivor = await product();
    const merged = await product('MERGED', survivor);
    const c4 = await draft(admin);
    expect(
      (
        await call('put', `/admin/collections/${c4.id}/items`, admin.token)
          .send({ canonical_product_ids: [archived] })
          .expect(409)
      ).body.error.code,
    ).toBe('CANONICAL_PRODUCT_ARCHIVED');
    const mergedRes = await call(
      'put',
      `/admin/collections/${c4.id}/items`,
      admin.token,
    )
      .send({ canonical_product_ids: [merged] })
      .expect(409);
    expect(mergedRes.body.error).toMatchObject({
      code: 'CANONICAL_PRODUCT_MERGED',
      details: [{ canonical_product_id: merged, merged_into_id: survivor }],
    });
    const later = await product();
    await call('put', `/admin/collections/${c4.id}/items`, admin.token)
      .send({ canonical_product_ids: [later, survivor] })
      .expect(200);
    await prisma.canonicalProduct.update({
      where: { id: later },
      data: { status: 'ARCHIVED' },
    });
    const kept = await call(
      'put',
      `/admin/collections/${c4.id}/items`,
      admin.token,
    )
      .send({ canonical_product_ids: [survivor, later] })
      .expect(200);
    expect(kept.body.items).toEqual([
      expect.objectContaining({ canonical_product_id: survivor, note: null }),
      expect.objectContaining({
        canonical_product_id: later,
        note: 'ARCHIVED',
        product_status: 'ARCHIVED',
      }),
    ]);
  });

  it('orders collections with the complete list only, audited', async () => {
    const admin = await account('PLATFORM_ADMIN');
    const a = await draft(admin);
    const b = await draft(admin);
    const all = (
      await call('get', '/admin/collections', admin.token).expect(200)
    ).body.map((c: { id: string }) => c.id);
    expect(all.slice(-2)).toEqual([a.id, b.id]);
    const reversed = [...all].reverse();
    const res = await call('put', '/admin/collections/order', admin.token)
      .send({ collection_ids: reversed })
      .expect(200);
    expect(res.body.map((c: { id: string }) => c.id)).toEqual(reversed);
    expect(res.body.map((c: { sort_order: number }) => c.sort_order)).toEqual(
      reversed.map((_: string, i: number) => i),
    );
    expect(
      (
        await call('put', '/admin/collections/order', admin.token)
          .send({ collection_ids: reversed.slice(1) })
          .expect(400)
      ).body.error.code,
    ).toBe('COLLECTION_ORDER_MISMATCH');
    expect(
      await prisma.auditLog.count({
        where: {
          action: 'platform_collection.reordered',
          actorId: admin.userId,
        },
      }),
    ).toBe(1);
  });
});
