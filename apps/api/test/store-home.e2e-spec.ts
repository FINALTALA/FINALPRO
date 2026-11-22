import { ThrottlerStorage } from '@nestjs/throttler';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { OutboxRelayService } from './../src/outbox/outbox-relay.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { tb26Fixtures } from './helpers/tb26-fixtures';

// «الصفحة الرئيسية المرنة للمتجر» (2026-11-20): the owner's home page of
// ready blocks. The flag (off: no route, no blocks), owner-only access, the
// closed document (no unknown block / field / destination kind, no foreign
// or external image, no foreign product / collection, text kept as plain
// text, the limits), the draft version (a stale or concurrent write is
// refused), draft -> publish -> discard with audit, and what shoppers see:
// only the published layout, every reference re-checked now (unpublished,
// sold-out, archived products, hidden collections, gone destinations are
// left out; a list block with fewer than 2 items disappears) - never a gap.
//
// store_home_blocks_enabled is one global row: run this spec alone or with
// --workers 1 beside other specs that toggle it.
describe('Store home page blocks (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const f = tb26Fixtures(() => app);

  async function setFlag(enabled: boolean) {
    await prisma.featureFlag.upsert({
      where: { key: 'store_home_blocks_enabled' },
      create: {
        key: 'store_home_blocks_enabled',
        enabled,
        description: 'test',
      },
      update: { enabled },
    });
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // nothing in this file is about rate limiting (covered by the auth and
      // tb16 specs) - the same never-blocking storage as offer-drafts.e2e-spec
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
    await setFlag(true);
  });
  afterAll(async () => {
    await setFlag(false);
    await app.close();
  });

  type Store = Awaited<ReturnType<typeof f.store>>;
  const base = (vendorId: string) =>
    `/api/v1/vendors/${vendorId}/storefront/home`;
  const auth = (token: string) => f.bearer(token);
  let n = 0;
  const bid = () => `blk-${Date.now().toString(36)}-${(n += 1)}`;

  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 1),
  ]);
  async function upload(s: Store): Promise<string> {
    const r = await f
      .http()
      .post(`/api/v1/vendors/${s.vendorId}/uploads`)
      .set(auth(s.owner.token))
      .attach('file', PNG, 'hero.png')
      .expect(201);
    return r.body.url as string;
  }
  const img = (url: string) => ({ url, width: 1920, height: 640, bytes: 1000 });

  /** A classified ACTIVE product (WOMEN / DRESSES_WOMEN by default) with `qty` in stock. */
  async function product(s: Store, qty = 5, category?: string) {
    const variantId = await f.offer(s, qty);
    const v = await prisma.offerVariant.findUniqueOrThrow({
      where: { id: variantId },
    });
    if (category) {
      await prisma.vendorOfferCategory.updateMany({
        where: { vendorOfferId: v.vendorOfferId },
        data: { categoryCode: category },
      });
    }
    return v.vendorOfferId;
  }
  async function collection(s: Store, offerIds: string[], visible = true) {
    const c = await f
      .http()
      .post(`/api/v1/vendors/${s.vendorId}/sections`)
      .set(auth(s.owner.token))
      .send({ name_ar: `مجموعة ${(n += 1)}`, visible })
      .expect(201);
    if (offerIds.length) {
      await f
        .http()
        .post(`/api/v1/vendors/${s.vendorId}/sections/${c.body.id}/offers`)
        .set(auth(s.owner.token))
        .send({ offer_ids: offerIds })
        .expect((r) => expect([200, 201]).toContain(r.status));
    }
    return c.body.id as string;
  }
  async function slugOf(s: Store) {
    return (
      await prisma.vendor.findUniqueOrThrow({ where: { id: s.vendorId } })
    ).slug;
  }
  const get = (s: Store) =>
    f.http().get(base(s.vendorId)).set(auth(s.owner.token));
  const save = (s: Store, version: number, blocks: unknown[], token?: string) =>
    f
      .http()
      .put(`${base(s.vendorId)}/draft`)
      .set(auth(token ?? s.owner.token))
      .send({ version, layout: { blocks } });
  /** The whole document (style, template and blocks). */
  const saveLayout = (s: Store, version: number, layout: unknown) =>
    f
      .http()
      .put(`${base(s.vendorId)}/draft`)
      .set(auth(s.owner.token))
      .send({ version, layout });
  const publish = (s: Store, version: number) =>
    f
      .http()
      .post(`${base(s.vendorId)}/publish`)
      .set(auth(s.owner.token))
      .send({ version });
  const publicHome = async (s: Store) =>
    (
      await f
        .http()
        .get(`/api/v1/storefronts/${await slugOf(s)}/home`)
        .expect(200)
    ).body as {
      enabled: boolean;
      style?: string;
      blocks: { id: string; type: string; [k: string]: unknown }[];
    };
  const text = (ar: string, en = '') => ({ ar, en });
  const textBlock = (ar = 'أهلاً') => ({
    id: bid(),
    type: 'text',
    visible: true,
    style: 'text',
    title: text(ar),
    text: text(''),
  });

  it('a store without a layout: no blocks for shoppers, an empty draft (version 0) for the owner', async () => {
    const s = await f.store();
    expect(await publicHome(s)).toEqual({ enabled: true, blocks: [] });
    const r = await get(s).expect(200);
    expect(r.body).toMatchObject({
      enabled: true,
      draft: { blocks: [] },
      draft_version: 0,
      published_version: null,
      has_published: false,
      has_unpublished_changes: false,
      preview: { blocks: [] },
      limits: {
        blocks: 12,
        images: 20,
        heroSlides: 3,
        products: 12,
        collections: 8,
      },
    });
  });

  it('with store_home_blocks_enabled off: every owner route is a 404 FEATURE_DISABLED and shoppers get no blocks, even with a published layout', async () => {
    const s = await f.store();
    await save(s, 0, [textBlock()]).expect(200);
    await publish(s, 1).expect(200);
    expect((await publicHome(s)).blocks).toHaveLength(1);
    await setFlag(false);
    try {
      for (const call of [
        () => get(s),
        () =>
          f
            .http()
            .get(`${base(s.vendorId)}/products`)
            .set(auth(s.owner.token)),
        () => save(s, 1, []),
        () => publish(s, 1),
        () =>
          f
            .http()
            .post(`${base(s.vendorId)}/discard`)
            .set(auth(s.owner.token))
            .send({ version: 1 }),
      ]) {
        const r = await call().expect(404);
        expect(r.body.error.code).toBe('FEATURE_DISABLED');
      }
      expect(await publicHome(s)).toEqual({ enabled: false, blocks: [] });
    } finally {
      await setFlag(true);
    }
  });

  it("owner only: an employee of the store and another store's owner are refused; no session is a 401", async () => {
    const s = await f.store();
    const other = await f.store();
    const employee = await f.member(
      s.vendorId,
      await f.account(),
      'BRANCH_EMPLOYEE',
      s.branchA,
    );
    await f.http().get(base(s.vendorId)).set(auth(employee.token)).expect(403);
    await save(s, 0, [textBlock()], employee.token).expect(403);
    await f
      .http()
      .get(`${base(s.vendorId)}/products`)
      .set(auth(employee.token))
      .expect(403);
    await f
      .http()
      .get(base(s.vendorId))
      .set(auth(other.owner.token))
      .expect(403);
    await save(s, 0, [textBlock()], other.owner.token).expect(403);
    await f.http().get(base(s.vendorId)).expect(401);
    // nothing was written
    expect(
      await prisma.storeHomeLayout.findUnique({
        where: { vendorId: s.vendorId },
      }),
    ).toBeNull();
  });

  it('a closed document: unknown block types, fields and destination kinds and typed links are refused; an UNFINISHED block (no items yet, a button without a destination, an empty text) is saved but not shown', async () => {
    const s = await f.store();
    const url = await upload(s);
    const hero = (slide: Record<string, unknown>) => ({
      id: bid(),
      type: 'hero',
      visible: true,
      slides: [{ image: img(url), ...slide }],
    });
    const refused: [unknown, string][] = [
      [{ id: bid(), type: 'video', visible: true }, 'type'],
      [{ ...textBlock(), html: '<b>x</b>' }, 'html'],
      [
        hero({
          target: { kind: 'url', href: 'https://evil.example' },
          button: text('اذهبي'),
        }),
        'kind',
      ],
      [
        hero({
          target: { kind: 'products', href: 'https://evil.example' },
          button: text('تسوقي'),
        }),
        'href',
      ],
      [{ ...textBlock(), id: 'x' }, 'id'],
      [hero({ title: 'نص بدون لغة' }), 'title'],
      [hero({ image: { url: 'x', width: -5 } }), 'width'],
      [
        {
          id: bid(),
          type: 'auto_products',
          visible: true,
          source: 'trend',
          count: 8,
        },
        'source',
      ],
      [
        {
          id: bid(),
          type: 'auto_products',
          visible: true,
          source: 'new',
          count: 30,
        },
        'count',
      ],
    ];
    for (const [block, field] of refused) {
      const r = await save(s, 0, [block]).expect(400);
      expect(r.body.error.code).toBe('STORE_HOME_INVALID');
      expect(JSON.stringify(r.body.error.details)).toContain(field);
    }
    // the same block id twice
    const same = textBlock();
    await save(s, 0, [same, { ...same }]).expect(400);
    // control and bidi-override characters
    await save(s, 0, [textBlock('نص‮معكوس')]).expect(400);
    await save(s, 0, [{ ...textBlock(), title: text('سطر\nثانٍ') }]).expect(
      400,
    );
    expect(
      await prisma.storeHomeLayout.findUnique({
        where: { vendorId: s.vendorId },
      }),
    ).toBeNull();

    // unfinished: saved (the owner's autosave), told why, never shown
    const r = await save(s, 0, [
      { ...hero({ button: text('تسوقي الآن') }), id: 'hero-unfinished' },
      {
        id: 'empty-products',
        type: 'products',
        visible: true,
        title: text('قريباً'),
        offer_ids: [],
      },
      { ...textBlock(''), id: 'empty-text' },
      { ...hero({ title: text('', 'Only English') }), id: 'english-only' },
    ]).expect(200);
    expect(r.body.review).toMatchObject({
      'empty-products': { shown: false, reason: 'too_few', shown_items: 0 },
      'empty-text': { shown: false, reason: 'too_few' },
      'hero-unfinished': { shown: true },
    });
    const heroPreview = r.body.preview.blocks.find(
      (b: { id: string }) => b.id === 'hero-unfinished',
    );
    expect(heroPreview.slides[0]).toMatchObject({
      button: { ar: '' },
      target: null,
    });
    // English only: Arabic shoppers see the English text rather than nothing
    const english = r.body.preview.blocks.find(
      (b: { id: string }) => b.id === 'english-only',
    );
    expect(english.slides[0].title).toEqual({
      ar: 'Only English',
      en: 'Only English',
    });
  });

  it('display choices: a closed set per block type (width / height / spacing), saved and published with the block; anything else refused; older blocks get the defaults - their look before', async () => {
    const s = await f.store();
    const url = await upload(s);
    const hero = (display?: unknown) => ({
      id: 'hero-display',
      type: 'hero',
      visible: true,
      ...(display === undefined ? {} : { display }),
      slides: [{ image: img(url), title: text('عرض') }],
    });
    // refused: an unknown key, a value outside the set, a key the type does not take, free CSS
    const refused: [unknown, string][] = [
      [hero({ margin: '12px' }), 'display.margin'],
      [hero({ height: 'huge' }), 'display.height'],
      [hero({ spacing: 24 }), 'display.spacing'],
      [hero('width:100vw'), 'display'],
      [{ ...textBlock(), display: { height: 'wide' } }, 'display.height'],
      [{ ...textBlock(), display: { width: 'full' } }, 'display.width'],
      [
        {
          id: 'prod-display',
          type: 'products',
          visible: true,
          offer_ids: [],
          display: { height: 'compact' },
        },
        'display.height',
      ],
    ];
    for (const [b, field] of refused) {
      const r = await save(s, 0, [b]).expect(400);
      expect(r.body.error.code).toBe('STORE_HOME_INVALID');
      expect(JSON.stringify(r.body.error.details)).toContain(field);
    }

    // accepted, normalised (every key of the type), echoed in the preview
    let r = await save(s, 0, [
      hero({ width: 'full', height: 'wide', spacing: 'tight' }),
      { ...textBlock(), id: 'text-display', display: { spacing: 'wide' } },
    ]).expect(200);
    expect(r.body.draft.blocks[0].display).toEqual({
      width: 'full',
      height: 'wide',
      spacing: 'tight',
    });
    expect(r.body.draft.blocks[1].display).toEqual({ spacing: 'wide' });
    expect(r.body.preview.blocks[0].display).toEqual({
      width: 'full',
      height: 'wide',
      spacing: 'tight',
    });
    expect(r.body.display.keys).toMatchObject({
      hero: ['width', 'height', 'spacing'],
      text: ['spacing'],
    });
    await publish(s, 1).expect(200);
    expect((await publicHome(s)).blocks[0]).toMatchObject({
      display: { width: 'full', height: 'wide', spacing: 'tight' },
    });

    // a block saved before display existed: defaults = its look before
    r = await save(s, 1, [hero()]).expect(200);
    expect(r.body.draft.blocks[0].display).toEqual({
      width: 'content',
      height: 'medium',
      spacing: 'normal',
    });
    // a published layout stored without display (raw, as older rows are) reads with the defaults
    await prisma.storeHomeLayout.update({
      where: { vendorId: s.vendorId },
      data: {
        published: {
          blocks: [
            {
              id: 'old-hero',
              type: 'hero',
              visible: true,
              slides: [{ image: img(url) }],
            },
          ],
        },
      },
    });
    expect((await publicHome(s)).blocks[0]).toMatchObject({
      id: 'old-hero',
      display: { width: 'content', height: 'medium', spacing: 'normal' },
    });
  });

  it('text stays plain text: markup is stored and returned as the characters typed, never interpreted', async () => {
    const s = await f.store();
    const markup = '<script>alert(1)</script><img src=x onerror=1>';
    const r = await save(s, 0, [
      {
        id: bid(),
        type: 'text',
        visible: true,
        style: 'text',
        title: text('عنوان'),
        text: text(markup),
      },
    ]).expect(200);
    expect(r.body.draft.blocks[0].text.ar).toBe(markup);
    await publish(s, 1).expect(200);
    const shopper = await publicHome(s);
    expect(shopper.blocks[0]).toMatchObject({
      type: 'text',
      text: { ar: markup },
    });
  });

  it("images: only this store's own uploads - an external URL or another store's upload is refused", async () => {
    const s = await f.store();
    const other = await f.store();
    const banner = (url: string) => ({
      id: bid(),
      type: 'banner',
      visible: true,
      image: img(url),
      image_mobile: null,
      title: text('تخفيضات'),
      text: text(''),
      target: null,
      alt: text(''),
    });
    for (const url of [
      'https://example.com/a.png',
      await upload(other),
      'javascript:alert(1)',
    ]) {
      const r = await save(s, 0, [banner(url)]).expect(400);
      expect(r.body.error.code).toBe('UPLOAD_NOT_USABLE');
    }
    await save(s, 0, [banner(await upload(s))]).expect(200);
  });

  it("references: another store's product or collection is a 404; a product / collection removed after it was chosen does not block the autosave", async () => {
    const s = await f.store();
    const other = await f.store();
    const foreignOffer = await product(other);
    const foreignCollection = await collection(other, [foreignOffer]);
    const products = (ids: string[]) => ({
      id: 'prod-block',
      type: 'products',
      visible: true,
      title: text('مختارات'),
      offer_ids: ids,
    });
    const collections = (ids: string[]) => ({
      id: 'coll-block',
      type: 'collections',
      visible: true,
      title: text('مجموعاتنا'),
      collection_ids: ids,
    });
    const mine = [await product(s), await product(s)];
    let r = await save(s, 0, [products([...mine, foreignOffer])]).expect(404);
    expect(r.body.error.code).toBe('STORE_HOME_REFERENCE_NOT_FOUND');
    r = await save(s, 0, [collections([foreignCollection])]).expect(404);
    expect(r.body.error.code).toBe('STORE_HOME_REFERENCE_NOT_FOUND');
    // a target to another store's product
    r = await save(s, 0, [
      {
        id: bid(),
        type: 'hero',
        visible: true,
        slides: [
          {
            image: img(await upload(s)),
            button: text('شاهدي'),
            target: { kind: 'product', id: foreignOffer },
          },
        ],
      },
    ]).expect(404);
    // a category outside its department
    r = await save(s, 0, [
      {
        id: bid(),
        type: 'categories',
        visible: true,
        title: text('فئات'),
        items: [{ audience: 'MEN', category: 'DRESSES_WOMEN' }],
      },
    ]).expect(400);

    const col = await collection(s, mine);
    await save(s, 0, [products(mine), collections([col])]).expect(200);
    // archived product and deleted collection since: the next autosave still works
    await prisma.vendorOffer.update({
      where: { id: mine[0] },
      data: { status: 'ARCHIVED' },
    });
    await f
      .http()
      .delete(`/api/v1/vendors/${s.vendorId}/sections/${col}`)
      .set(auth(s.owner.token))
      .expect((x) => expect([200, 204]).toContain(x.status));
    r = await save(s, 1, [
      products(mine),
      collections([col]),
      textBlock(),
    ]).expect(200);
    expect(r.body.refs.offers[mine[0]].status).toBe('missing');
    expect(r.body.refs.collections[col].status).toBe('missing');
    expect(r.body.review['prod-block']).toMatchObject({
      shown: false,
      reason: 'too_few',
      shown_items: 1,
    });
  });

  it('limits: 12 blocks, 20 images in the page, 3 hero slides, 12 products, 8 collections', async () => {
    const s = await f.store();
    const url = await upload(s);
    const blocks = (k: number) => Array.from({ length: k }, () => textBlock());
    await save(s, 0, blocks(13)).expect(400);
    const slide = { image: img(url), image_mobile: img(url) };
    const hero = (slides: number) => ({
      id: bid(),
      type: 'hero',
      visible: true,
      slides: Array.from({ length: slides }, () => slide),
    });
    await save(s, 0, [hero(4)]).expect(400);
    // 3 heroes x 3 slides x 2 images = 18, + 2 banners x 2 = 22 > 20
    const banner = {
      type: 'banner',
      visible: true,
      image: img(url),
      image_mobile: img(url),
    };
    const r = await save(s, 0, [
      hero(3),
      hero(3),
      hero(3),
      { ...banner, id: bid() },
      { ...banner, id: bid() },
    ]).expect(400);
    expect(r.body.error.message).toContain('20 images');
    const ids = Array.from({ length: 13 }, () =>
      '00000000-0000-4000-8000-000000000000'.replace(
        /0{12}$/,
        String(Math.random()).slice(2, 14).padEnd(12, '0'),
      ),
    );
    await save(s, 0, [
      { id: bid(), type: 'products', visible: true, offer_ids: ids },
    ]).expect(400);
    await save(s, 0, [
      {
        id: bid(),
        type: 'collections',
        visible: true,
        collection_ids: ids.slice(0, 9),
      },
    ]).expect(400);
    await save(s, 0, blocks(12)).expect(200);
  });

  it('the draft version: a save from a stale screen is a 409 with the current version; of two concurrent saves from the same version exactly one wins', async () => {
    const s = await f.store();
    await save(s, 0, [textBlock('أولى')]).expect(200);
    const stale = await save(s, 0, [textBlock('قديمة')]).expect(409);
    expect(stale.body.error.code).toBe('STORE_HOME_VERSION_CONFLICT');
    expect(stale.body.error.details).toEqual([{ current_version: 1 }]);
    const results = await Promise.all([
      save(s, 1, [textBlock('تبويب أ')]),
      save(s, 1, [textBlock('تبويب ب')]),
      save(s, 1, [textBlock('تبويب ج')]),
    ]);
    expect(results.map((x) => x.status).sort()).toEqual([200, 409, 409]);
    const row = await prisma.storeHomeLayout.findUniqueOrThrow({
      where: { vendorId: s.vendorId },
    });
    expect(row.draftVersion).toBe(2);
    const winner = results.find((x) => x.status === 200)!;
    expect(row.draft).toEqual(winner.body.draft);
    // publish / discard carry the version too
    await publish(s, 1).expect(409);
  });

  it('draft -> publish -> discard: shoppers see only what was published; publishing and discarding are audited', async () => {
    const s = await f.store();
    let r = await save(s, 0, [textBlock('منشور')]).expect(200);
    expect(r.body.has_unpublished_changes).toBe(true);
    expect((await publicHome(s)).blocks).toEqual([]);
    r = await publish(s, 1).expect(200);
    expect(r.body).toMatchObject({
      published_version: 1,
      has_published: true,
      has_unpublished_changes: false,
    });
    expect((await publicHome(s)).blocks).toMatchObject([
      { type: 'text', title: { ar: 'منشور' } },
    ]);

    r = await save(s, 1, [textBlock('مسودة جديدة'), textBlock('أخرى')]).expect(
      200,
    );
    expect(r.body.has_unpublished_changes).toBe(true);
    // the draft is not shown to shoppers
    expect((await publicHome(s)).blocks).toMatchObject([
      { title: { ar: 'منشور' } },
    ]);
    r = await f
      .http()
      .post(`${base(s.vendorId)}/discard`)
      .set(auth(s.owner.token))
      .send({ version: 2 })
      .expect(200);
    expect(r.body).toMatchObject({
      draft_version: 3,
      has_unpublished_changes: false,
    });
    expect(r.body.draft.blocks).toMatchObject([{ title: { ar: 'منشور' } }]);

    const audit = await prisma.auditLog.findMany({
      where: {
        entityType: 'Vendor',
        entityId: s.vendorId,
        action: { startsWith: 'store_home.' },
      },
      orderBy: { occurredAt: 'asc' },
    });
    expect(audit.map((a) => [a.action, a.actorId])).toEqual([
      ['store_home.published', s.owner.userId],
      ['store_home.draft_discarded', s.owner.userId],
    ]);
    // a published EMPTY page brings the store back to its usual page
    await save(s, 3, []).expect(200);
    await publish(s, 4).expect(200);
    expect(await publicHome(s)).toEqual({ enabled: true, blocks: [] });
  });

  it('what shoppers see is re-checked now: unpublished, sold-out and archived products, hidden or emptied collections, hidden blocks and gone destinations leave no gap', async () => {
    const s = await f.store();
    const url = await upload(s);
    const [a, b, c] = [await product(s), await product(s), await product(s)];
    const soldOut = await product(s, 0);
    const paused = await product(s);
    await prisma.vendorOffer.update({
      where: { id: paused },
      data: { status: 'INACTIVE' },
    });
    const tops = await product(s, 5, 'TOPS');
    const col1 = await collection(s, [a, b]);
    const col2 = await collection(s, [c]);
    const hiddenCol = await collection(s, [a], false);
    const emptyCol = await collection(s, [soldOut]);

    await save(s, 0, [
      {
        id: 'hero-1',
        type: 'hero',
        visible: true,
        slides: [
          {
            image: img(url),
            title: text('موسم جديد'),
            button: text('تسوقي الآن'),
            target: { kind: 'products' },
          },
          {
            image: img(url),
            button: text('القطعة'),
            target: { kind: 'product', id: soldOut },
          },
        ],
      },
      {
        id: 'picked',
        type: 'products',
        visible: true,
        title: text('اخترنا لك'),
        offer_ids: [soldOut, a, paused, b],
      },
      {
        id: 'too-few',
        type: 'products',
        visible: true,
        title: text('قليل'),
        offer_ids: [a, soldOut, paused],
      },
      {
        id: 'cols-block',
        type: 'collections',
        visible: true,
        title: text('مجموعات'),
        collection_ids: [hiddenCol, col2, emptyCol, col1],
      },
      {
        id: 'cats-block',
        type: 'categories',
        visible: true,
        title: text('فئات'),
        items: [
          { audience: 'WOMEN', category: 'TOPS' },
          { audience: 'WOMEN', category: 'DRESSES_WOMEN' },
          { audience: 'WOMEN', category: 'SKIRTS' },
        ],
      },
      {
        id: 'new-block',
        type: 'auto_products',
        visible: true,
        title: text(''),
        source: 'new',
        count: 4,
      },
      {
        id: 'sale-block',
        type: 'auto_products',
        visible: true,
        title: text(''),
        source: 'sale',
        count: 4,
      },
      { ...textBlock('مخفي'), id: 'hidden-text', visible: false },
    ]).expect(200);
    const owner = await publish(s, 1).expect(200);
    expect(owner.body.review).toMatchObject({
      'too-few': { shown: false, reason: 'too_few', shown_items: 1 },
      'sale-block': { shown: false, reason: 'too_few', shown_items: 0 },
      'hidden-text': { shown: false, reason: 'hidden' },
      picked: { shown: true, shown_items: 2 },
      // «فئات المتجر» is retired: a saved block is kept, never shown
      'cats-block': { shown: false, reason: 'retired', shown_items: 0 },
    });
    expect(owner.body.refs.offers[soldOut].status).toBe('sold_out');
    expect(owner.body.refs.offers[paused].status).toBe('unpublished');
    expect(owner.body.refs.collections[hiddenCol].status).toBe('hidden');
    expect(owner.body.refs.collections[emptyCol].status).toBe('empty');
    expect(owner.body.refs.categories['WOMEN/SKIRTS'].status).toBe('empty');
    // still offered as a button's destination (a category with products)
    expect(
      owner.body.options.categories.map(
        (c: { category: string }) => c.category,
      ),
    ).toEqual(expect.arrayContaining(['TOPS', 'DRESSES_WOMEN']));

    const shopper = await publicHome(s);
    expect(shopper.blocks.map((x) => x.id)).toEqual([
      'hero-1',
      'picked',
      'cols-block',
      'new-block',
    ]);
    const [hero, picked, cols, fresh] = shopper.blocks as any[];
    // the slide stays; its button to a sold-out product is gone
    expect(hero.slides).toHaveLength(2);
    expect(hero.slides[0]).toMatchObject({
      target: { kind: 'products' },
      button: { ar: 'تسوقي الآن' },
    });
    expect(hero.slides[1]).toMatchObject({ target: null, button: { ar: '' } });
    expect(picked.items.map((x: { id: string }) => x.id)).toEqual([a, b]);
    expect(cols.items.map((x: { id: string }) => x.id)).toEqual([col2, col1]);
    expect(fresh.items).toHaveLength(4);
    expect(fresh.items.map((x: { id: string }) => x.id)).not.toContain(soldOut);
    // no stock numbers, never the draft
    expect(JSON.stringify(shopper)).not.toMatch(
      /"(quantity|available|stock|draft|draft_version)":/,
    );
    void tops;

    // a store that stops being available shows no blocks at all
    await prisma.vendor.update({
      where: { id: s.vendorId },
      data: { storefrontPublished: false },
    });
    expect(await publicHome(s)).toEqual({ enabled: true, blocks: [] });
  });

  it('a suspended store can read its home page but not change or publish it', async () => {
    const s = await f.store();
    await save(s, 0, [textBlock()]).expect(200);
    await prisma.vendor.update({
      where: { id: s.vendorId },
      data: { status: 'SUSPENDED' },
    });
    await get(s).expect(200);
    const r = await save(s, 1, []).expect(403);
    expect(r.body.error.code).toBe('VENDOR_SUSPENDED');
    await publish(s, 1).expect(403);
  });

  it("the product picker: this store's products (not archived), searchable, each saying whether shoppers can see it", async () => {
    const s = await f.store();
    const ok = await product(s);
    const out = await product(s, 0);
    const archived = await product(s);
    await prisma.vendorOffer.update({
      where: { id: archived },
      data: { status: 'ARCHIVED' },
    });
    const r = await f
      .http()
      .get(`${base(s.vendorId)}/products`)
      .set(auth(s.owner.token))
      .expect(200);
    const byId = new Map(
      r.body.items.map((x: { id: string; status: string }) => [x.id, x.status]),
    );
    expect(byId.get(ok)).toBe('ok');
    expect(byId.get(out)).toBe('sold_out');
    expect(byId.has(archived)).toBe(false);
    const none = await f
      .http()
      .get(`${base(s.vendorId)}/products?q=لا-يوجد-هذا`)
      .set(auth(s.owner.token))
      .expect(200);
    expect(none.body.items).toEqual([]);
  });

  // ---------------- «قوالب وستايلات وأشكال الصفحة الرئيسية» (2026-11-21)

  it('styles, templates, block shapes and image focus: closed values saved with the draft and published with it atomically; anything else refused; older layouts read with the defaults (their look before)', async () => {
    const s = await f.store();
    const url = await upload(s);
    const [a, b] = [await product(s), await product(s)];
    const hero = (extra: Record<string, unknown>, slide = {}) => ({
      id: bid(),
      type: 'hero',
      visible: true,
      ...extra,
      slides: [{ image: img(url), ...slide }],
    });
    const refused: [unknown, string][] = [
      [{ style: 'neon', blocks: [] }, 'layout.style'],
      [{ style: { color: '#ff0000' }, blocks: [] }, 'layout.style'],
      [{ template: 'party', blocks: [] }, 'layout.template'],
      [{ css: 'body{color:red}', blocks: [] }, 'layout.css'],
      [{ font: 'Comic Sans', blocks: [] }, 'layout.font'],
      [{ blocks: [hero({ variant: 'carousel' })] }, 'variant'],
      [{ blocks: [hero({ autoplay: true })] }, 'autoplay'],
      [{ blocks: [hero({}, { focus: 'face' })] }, 'focus'],
      [{ blocks: [hero({}, { focus: { x: 40, y: 10 } })] }, 'focus'],
      [
        {
          blocks: [
            {
              id: bid(),
              type: 'banner',
              visible: true,
              variant: 'double',
              image: img(url),
              second: { image: img(url), href: 'https://evil.example' },
            },
          ],
        },
        'second.href',
      ],
      [
        {
          blocks: [
            {
              id: bid(),
              type: 'banner',
              visible: true,
              variant: 'triple',
              image: img(url),
            },
          ],
        },
        'variant',
      ],
      [
        {
          blocks: [
            {
              id: bid(),
              type: 'collections',
              visible: true,
              variant: 'side',
              collection_ids: [],
            },
          ],
        },
        'variant',
      ],
      [{ blocks: [{ ...textBlock(), focus: 'top' }] }, 'focus'],
    ];
    for (const [layout, field] of refused) {
      const r = await saveLayout(s, 0, layout).expect(400);
      expect(r.body.error.code).toBe('STORE_HOME_INVALID');
      expect(JSON.stringify(r.body.error.details)).toContain(field);
    }

    let r = await saveLayout(s, 0, {
      style: 'elegant',
      template: 'luxe',
      blocks: [
        {
          ...hero(
            { variant: 'split' },
            { title: text('موسم'), focus: 'top-right' },
          ),
          id: 'hero-split',
        },
        {
          id: 'promo-pair',
          type: 'banner',
          visible: true,
          variant: 'double',
          image: img(url),
          title: text('العروض'),
          target: { kind: 'products' },
          focus: 'bottom-left',
          second: {
            image: img(url),
            text: text('الجديد'),
            target: { kind: 'product', id: a },
          },
        },
        {
          id: 'strip-1',
          type: 'products',
          visible: true,
          variant: 'side',
          title: text('اخترنا لكِ'),
          text: text('قطع مختارة'),
          offer_ids: [a, b],
        },
      ],
    }).expect(200);
    expect(r.body.draft).toMatchObject({ style: 'elegant', template: 'luxe' });
    expect(r.body.draft.blocks[0]).toMatchObject({
      variant: 'split',
      slides: [{ focus: 'top-right' }],
    });
    expect(r.body.draft.blocks[1].second).toMatchObject({
      focus: 'center',
      title: { ar: '', en: '' },
    });
    expect(r.body.preview.style).toBe('elegant');
    expect(r.body.choices).toMatchObject({
      styles: ['default', 'elegant', 'warm', 'calm', 'modern'],
      templates: ['luxe', 'sale', 'kids', 'minimal'],
      variants: { hero: ['overlay', 'split'], banner: ['single', 'double'] },
    });
    expect(r.body.choices.focus).toHaveLength(9);
    // the draft is not the shoppers' until «نشر»
    expect((await publicHome(s)).blocks).toEqual([]);
    await publish(s, 1).expect(200);
    let home: any = await publicHome(s);
    expect(home.style).toBe('elegant');
    expect(home.blocks.map((x: any) => [x.type, x.variant])).toEqual([
      ['hero', 'split'],
      ['banner', 'double'],
      ['products', 'side'],
    ]);
    expect(home.blocks[0].slides[0].focus).toBe('top-right');
    expect(home.blocks[1]).toMatchObject({
      focus: 'bottom-left',
      title: { ar: 'العروض' },
      second: { text: { ar: 'الجديد' }, target: { kind: 'product', id: a } },
    });
    expect(home.blocks[2]).toMatchObject({ text: { ar: 'قطع مختارة' } });

    // a new style in the draft: shoppers keep the published one until it is published
    r = await saveLayout(s, 1, { ...r.body.draft, style: 'modern' }).expect(
      200,
    );
    expect(r.body.has_unpublished_changes).toBe(true);
    expect((await publicHome(s)).style).toBe('elegant');
    await publish(s, 2).expect(200);
    expect((await publicHome(s)).style).toBe('modern');

    // an older published row (no style, template, variant or focus) reads with the defaults
    await prisma.storeHomeLayout.update({
      where: { vendorId: s.vendorId },
      data: {
        published: {
          blocks: [
            {
              id: 'old-hero',
              type: 'hero',
              visible: true,
              slides: [{ image: img(url) }],
            },
            {
              id: 'old-banner',
              type: 'banner',
              visible: true,
              image: img(url),
            },
            {
              id: 'old-picks',
              type: 'products',
              visible: true,
              offer_ids: [a, b],
            },
          ],
        },
      },
    });
    home = await publicHome(s);
    expect(home.style).toBe('default');
    expect(home.blocks[0]).toMatchObject({
      variant: 'overlay',
      slides: [{ focus: 'center' }],
    });
    expect(home.blocks[1]).toMatchObject({
      variant: 'single',
      focus: 'center',
      second: null,
    });
    expect(home.blocks[2]).toMatchObject({
      variant: 'standard',
      text: { ar: '', en: '' },
    });
  });

  it("empty image places (a template's «أضيفي صورة») are saved but never shown; a double banner shows only complete cards (one complete card shows alone); the publish is refused while a visible place is empty", async () => {
    const s = await f.store();
    const url = await upload(s);
    const r = await saveLayout(s, 0, {
      template: 'sale',
      blocks: [
        {
          id: 'hero-empty',
          type: 'hero',
          visible: true,
          slides: [
            {
              image: null,
              title: text('تخفيضات'),
              button: text('تسوقي'),
              target: { kind: 'products' },
            },
          ],
        },
        {
          id: 'banner-empty',
          type: 'banner',
          visible: true,
          image: null,
          target: { kind: 'products' },
        },
        {
          id: 'pair-one',
          type: 'banner',
          visible: true,
          variant: 'double',
          image: img(url),
          title: text('العروض'),
          target: { kind: 'products' },
          second: {
            image: null,
            title: text('الجديد'),
            target: { kind: 'new' },
          },
        },
        {
          id: 'pair-none',
          type: 'banner',
          visible: true,
          variant: 'double',
          image: img(url),
          target: { kind: 'products' },
          second: { image: img(url), title: text('بلا وجهة') },
        },
      ],
    }).expect(200);
    expect(r.body.review).toMatchObject({
      'hero-empty': { shown: false, reason: 'no_image' },
      'banner-empty': { shown: false, reason: 'no_image' },
      'pair-one': { shown: true, shown_items: 1 },
      'pair-none': { shown: false, reason: 'incomplete' },
    });
    const pairOne = r.body.preview.blocks.find(
      (x: { id: string }) => x.id === 'pair-one',
    );
    expect(pairOne).toMatchObject({
      variant: 'single',
      second: null,
      title: { ar: 'العروض' },
    });
    expect(r.body.preview.blocks.map((x: { id: string }) => x.id)).toEqual([
      'pair-one',
    ]);
    // an empty place is not an image (the 20-image limit counts real images only)
    expect(Object.keys(r.body.refs.images)).toEqual([url]);

    const p = await publish(s, 1).expect(400);
    expect(p.body.error.code).toBe('STORE_HOME_NOT_READY');
    expect(p.body.error.details).toEqual(
      expect.arrayContaining([
        { code: 'no_image', block_id: 'hero-empty', slide: 0 },
        { code: 'no_image', block_id: 'banner-empty', card: 1 },
        { code: 'no_image', block_id: 'pair-one', card: 2 },
        { code: 'card_no_text', block_id: 'pair-none', card: 1 },
        { code: 'card_no_target', block_id: 'pair-none', card: 2 },
      ]),
    );
    const row = await prisma.storeHomeLayout.findUniqueOrThrow({
      where: { vendorId: s.vendorId },
    });
    expect(row.published).toBeNull();
    expect((await publicHome(s)).blocks).toEqual([]);
    // nothing written to the audit for a refused publish
    expect(
      await prisma.auditLog.count({
        where: { entityId: s.vendorId, action: 'store_home.published' },
      }),
    ).toBe(0);
  });

  it('«فحص قبل النشر»: errors (unfinished visible blocks, a gone destination, a second Hero) stop the publish; warnings (image size, shape and weight, long text on an image, similar neighbours, descriptions, sold out now) never do; hidden blocks are not checked', async () => {
    const s = await f.store();
    const url = await upload(s);
    const [a, b] = [await product(s), await product(s)];
    const gone = await product(s);
    const soldOut = await product(s, 0);
    const small = { url, width: 800, height: 800, bytes: 3_000_000 };
    const longTitle =
      'عنوان طويل جداً فوق الصورة يتجاوز أربعين حرفاً بكثير هنا';
    const blocks: any[] = [
      {
        id: 'hero-a',
        type: 'hero',
        visible: true,
        slides: [
          { image: small, title: text(longTitle), button: text('اذهبي') },
          {
            image: img(url),
            button: text('القطعة'),
            target: { kind: 'product', id: soldOut },
          },
        ],
      },
      {
        id: 'hero-b',
        type: 'hero',
        visible: true,
        slides: [{ image: img(url), title: text('ثانٍ') }],
      },
      {
        id: 'picks-1',
        type: 'products',
        visible: true,
        title: text('١'),
        offer_ids: [a, gone],
      },
      {
        id: 'picks-2',
        type: 'products',
        visible: true,
        title: text('٢'),
        offer_ids: [a, b],
      },
      {
        id: 'banner-gone',
        type: 'banner',
        visible: true,
        image: img(url),
        alt: text('', 'English only'),
        target: { kind: 'product', id: gone },
      },
      { ...textBlock(''), id: 'empty-text' },
      { ...textBlock(''), id: 'hidden-empty', visible: false },
      {
        id: 'hidden-hero',
        type: 'hero',
        visible: false,
        slides: [{ image: null }],
      },
    ];
    await save(s, 0, blocks).expect(200);
    // archived after it was chosen: kept in the draft (the autosave never blocks)
    await prisma.vendorOffer.update({
      where: { id: gone },
      data: { status: 'ARCHIVED' },
    });
    const r = await get(s).expect(200);
    const codes = (list: { code: string; block_id: string }[]) =>
      list.map((i) => `${i.code}:${i.block_id}`);
    expect(codes(r.body.checks.errors).sort()).toEqual(
      [
        'button_no_target:hero-a',
        'empty_text:empty-text',
        'target_invalid:banner-gone',
        'too_few_chosen:picks-1',
        'two_heroes:hero-b',
      ].sort(),
    );
    expect(codes(r.body.checks.warnings)).toEqual(
      expect.arrayContaining([
        'image_small:hero-a',
        'image_ratio:hero-a',
        'image_heavy:hero-a',
        'long_text_on_image:hero-a',
        'target_unavailable:hero-a',
        'alt_missing:hero-a',
        'similar_neighbours:hero-b',
        'similar_neighbours:picks-2',
        'alt_ar_missing:banner-gone',
      ]),
    );
    expect(JSON.stringify(r.body.checks)).not.toMatch(
      /hidden-empty|hidden-hero/,
    );
    const refused = await publish(s, 1).expect(400);
    expect(refused.body.error.code).toBe('STORE_HOME_NOT_READY');
    expect(codes(refused.body.error.details).sort()).toEqual(
      codes(r.body.checks.errors).sort(),
    );

    // fixed, the second Hero hidden: warnings only - the publish goes through
    const fixed = await save(s, 1, [
      {
        ...blocks[0],
        slides: [
          { ...blocks[0].slides[0], target: { kind: 'products' } },
          blocks[0].slides[1],
        ],
      },
      { ...blocks[1], visible: false },
      { ...blocks[2], offer_ids: [a, b] },
      blocks[3],
      { ...blocks[4], target: { kind: 'products' } },
      { ...textBlock('نص'), id: 'empty-text' },
    ]).expect(200);
    expect(fixed.body.checks.errors).toEqual([]);
    expect(fixed.body.checks.warnings.length).toBeGreaterThan(0);
    await publish(s, 2).expect(200);
    expect((await publicHome(s)).blocks.map((x) => x.id)).toEqual([
      'hero-a',
      'picks-1',
      'picks-2',
      'banner-gone',
      'empty-text',
    ]);
  });

  // ---------------- P1 «بطاقات التصنيفات» (2026-11-22)

  /** A category card (closed shape); WOMEN / DRESSES_WOMEN products are the fixture's default. */
  const card = (extra: Record<string, unknown> = {}) => ({
    audience: 'WOMEN',
    category: null,
    title: text('نساء'),
    ...extra,
  });
  const cardsBlock = (
    items: unknown[],
    extra: Record<string, unknown> = {},
  ) => ({
    id: bid(),
    type: 'category_cards',
    visible: true,
    items,
    ...extra,
  });

  it("category cards: a closed block (2-8 cards, a real department or category of the fixed taxonomy, this store's own images, short texts, a shape for the whole block); owner only; the retired «فئات المتجر» block stays as it was", async () => {
    const s = await f.store();
    const other = await f.store();
    const url = await upload(s);
    const foreign = await upload(other);
    const many = ['WOMEN', 'MEN', 'KIDS'].flatMap((a) =>
      ['TOPS', 'DRESSES_WOMEN', 'SKIRTS'].map((c) => ({
        audience: a,
        category: c,
      })),
    );
    const refused: [unknown, string, string][] = [
      [
        cardsBlock([card({ audience: 'TEENS' })]),
        'audience',
        'STORE_HOME_INVALID',
      ],
      [
        cardsBlock([card({ category: 'dresses' })]),
        'category',
        'STORE_HOME_INVALID',
      ],
      [cardsBlock([card({ href: '/x' })]), 'href', 'STORE_HOME_INVALID'],
      [
        cardsBlock([
          card({ title: text('عنوان أطول بكثير من أربعة وعشرين حرفاً') }),
        ]),
        'title',
        'STORE_HOME_INVALID',
      ],
      [
        cardsBlock([card({ text: text('س'.repeat(41)) })]),
        'text',
        'STORE_HOME_INVALID',
      ],
      [cardsBlock([card({ focus: 'face' })]), 'focus', 'STORE_HOME_INVALID'],
      [
        cardsBlock([card()], { shape: 'hexagon' }),
        'shape',
        'STORE_HOME_INVALID',
      ],
      [
        cardsBlock([card()], { variant: 'side' }),
        'variant',
        'STORE_HOME_INVALID',
      ],
      [cardsBlock([card(), card()]), 'items', 'STORE_HOME_INVALID'],
      [
        cardsBlock(many.slice(0, 9).map((m) => card(m))),
        'items',
        'STORE_HOME_INVALID',
      ],
      // a category outside its department, an external image, another store's image
      [
        cardsBlock([card({ audience: 'MEN', category: 'DRESSES_WOMEN' })]),
        'category',
        'STORE_HOME_INVALID',
      ],
      [
        cardsBlock([card({ image: img('https://evil.example/a.png') })]),
        'url',
        'UPLOAD_NOT_USABLE',
      ],
      [cardsBlock([card({ image: img(foreign) })]), 'url', 'UPLOAD_NOT_USABLE'],
    ];
    for (const [b, field, code] of refused) {
      const r = await save(s, 0, [b]).expect(400);
      expect(r.body.error.code).toBe(code);
      if (code === 'STORE_HOME_INVALID') {
        expect(JSON.stringify(r.body.error)).toContain(field);
      }
    }
    // owner only: an employee and another store's owner are refused
    const employee = await f.member(
      s.vendorId,
      await f.account(),
      'BRANCH_EMPLOYEE',
      s.branchA,
    );
    await save(s, 0, [cardsBlock([card()])], employee.token).expect(403);
    await save(s, 0, [cardsBlock([card()])], other.owner.token).expect(403);

    // accepted and normalised; a retired «فئات المتجر» block beside it is kept as it was
    const r = await save(s, 0, [
      cardsBlock(
        [
          card({ image: img(url) }),
          card({ category: 'DRESSES_WOMEN', image: img(url) }),
        ],
        { id: 'cards-1' },
      ),
      {
        id: 'old-cats',
        type: 'categories',
        visible: true,
        title: text('قديمة'),
        items: [{ audience: 'WOMEN', category: 'TOPS' }],
      },
    ]).expect(200);
    expect(r.body.draft.blocks[0]).toMatchObject({
      type: 'category_cards',
      shape: 'circle',
      display: { spacing: 'normal' },
      items: [
        {
          audience: 'WOMEN',
          category: null,
          focus: 'center',
          text: { ar: '', en: '' },
        },
        { audience: 'WOMEN', category: 'DRESSES_WOMEN' },
      ],
    });
    expect(r.body.draft.blocks[1]).toMatchObject({
      type: 'categories',
      items: [{ audience: 'WOMEN', category: 'TOPS' }],
    });
    expect(r.body.review['old-cats']).toMatchObject({
      shown: false,
      reason: 'retired',
    });
    expect(r.body.choices.card_shapes).toEqual([
      'circle',
      'square',
      'portrait',
    ]);
  });

  it('category cards for shoppers: complete cards only (image, Arabic title, a destination with products now; English falls back to Arabic), at least two, the «الكل» blocks only; «فحص قبل النشر» stops unfinished cards and warns about a plain repeat of the fixed chips', async () => {
    const s = await f.store();
    const url = await upload(s);
    await product(s);
    await product(s, 5, 'TOPS');
    const cards = [
      card({
        image: img(url),
        title: text('نساء'),
        text: text('كل جديد النساء'),
      }),
      card({
        category: 'DRESSES_WOMEN',
        image: img(url),
        title: text('فساتين', 'Dresses'),
        alt: text('عارضة بفستان'),
      }),
      card({ audience: 'MEN', image: img(url), title: text('رجال') }), // no products now: not shown, a warning
    ];
    let r = await save(s, 0, [
      cardsBlock(cards, { id: 'cards-shop', shape: 'portrait' }),
    ]).expect(200);
    expect(r.body.review['cards-shop']).toMatchObject({
      shown: true,
      shown_items: 2,
    });
    expect(r.body.checks.errors).toEqual([]);
    expect(r.body.checks.warnings).toEqual(
      expect.arrayContaining([
        { code: 'target_unavailable', block_id: 'cards-shop', card: 3 },
      ]),
    );
    expect(r.body.options.audiences).toEqual([
      expect.objectContaining({ audience: 'WOMEN', count: 2 }),
    ]);
    await publish(s, 1).expect(200);
    const home: any = await publicHome(s);
    expect(home.blocks).toHaveLength(1);
    expect(home.blocks[0]).toMatchObject({
      type: 'category_cards',
      shape: 'portrait',
    });
    expect(home.blocks[0].items).toEqual([
      expect.objectContaining({
        target: { kind: 'audience', audience: 'WOMEN' },
        title: { ar: 'نساء', en: 'نساء' },
        text: { ar: 'كل جديد النساء', en: '' },
      }),
      expect.objectContaining({
        target: {
          kind: 'category',
          audience: 'WOMEN',
          category: 'DRESSES_WOMEN',
        },
        title: { ar: 'فساتين', en: 'Dresses' },
      }),
    ]);

    // unfinished cards: kept (autosave), never shown, and errors before «نشر»
    r = await save(s, 1, [
      cardsBlock(
        [
          card({ image: null, title: text('بلا صورة') }),
          card({
            category: 'DRESSES_WOMEN',
            image: img(url),
            title: text('', 'English only'),
          }),
          card({ category: 'TOPS', image: img(url), title: text('بلايز') }),
        ],
        { id: 'cards-bad' },
      ),
    ]).expect(200);
    expect(r.body.review['cards-bad']).toMatchObject({
      shown: false,
      reason: 'too_few',
      shown_items: 1,
    });
    const codes = (l: { code: string; card?: number }[]) =>
      l.map((i) => `${i.code}:${i.card ?? '-'}`).sort();
    expect(codes(r.body.checks.errors)).toEqual(
      ['card_no_title:2', 'no_image:1', 'too_few_chosen:-'].sort(),
    );
    const refused = await publish(s, 2).expect(400);
    expect(refused.body.error.code).toBe('STORE_HOME_NOT_READY');
    // shoppers keep the published cards
    expect(((await publicHome(s)) as any).blocks[0].id).toBe('cards-shop');

    // the same departments as the fixed chips, in their order, with no line: a warning only
    await prisma.vendorApplicableCategory.createMany({
      data: [
        { vendorId: s.vendorId, category: 'WOMEN' },
        { vendorId: s.vendorId, category: 'MEN' },
      ],
      skipDuplicates: true,
    });
    await product(s, 5, 'TOPS').then((id) =>
      prisma.vendorOfferAudience.updateMany({
        where: { vendorOfferId: id },
        data: { audience: 'MEN' },
      }),
    );
    r = await save(s, 2, [
      cardsBlock(
        [
          card({ image: img(url) }),
          card({ audience: 'MEN', image: img(url), title: text('رجال') }),
        ],
        { id: 'cards-same' },
      ),
    ]).expect(200);
    expect(r.body.checks.errors).toEqual([]);
    expect(r.body.checks.warnings).toEqual(
      expect.arrayContaining([
        { code: 'repeats_chips', block_id: 'cards-same' },
      ]),
    );
    await publish(s, 3).expect(200);
    // with a line of its own it is not a repeat
    r = await save(s, 3, [
      cardsBlock(
        [
          card({ image: img(url), text: text('الجديد') }),
          card({ audience: 'MEN', image: img(url), title: text('رجال') }),
        ],
        { id: 'cards-same' },
      ),
    ]).expect(200);
    expect(JSON.stringify(r.body.checks.warnings)).not.toContain(
      'repeats_chips',
    );
  });

  // ---------------- P2 «القياس الدقيق والمحاذاة» (2026-11-22)

  it('fine sizes: whole steps per block type within their ranges (height -6..16, spaces 0..10, content width 6..10, text panel 4..7, items per view from a closed list, logical alignment); anything else refused; a default is not stored; older layouts read exactly as before; published with the block', async () => {
    const s = await f.store();
    const url = await upload(s);
    const [a, b] = [await product(s), await product(s)];
    const hero = (display: unknown, slide: Record<string, unknown> = {}) => ({
      id: 'hero-fine',
      type: 'hero',
      visible: true,
      display,
      slides: [{ image: img(url), title: text('مقاس'), ...slide }],
    });
    const banner = (display: unknown) => ({
      id: 'banner-fine',
      type: 'banner',
      visible: true,
      image: img(url),
      display,
    });
    const picks = (display: unknown) => ({
      id: 'picks-fine',
      type: 'products',
      visible: true,
      offer_ids: [a, b],
      display,
    });
    const cards = (shape: string, display: unknown) => ({
      id: 'cards-fine',
      type: 'category_cards',
      visible: true,
      shape,
      items: [{ audience: 'WOMEN', image: img(url), title: text('نساء') }],
      display,
    });
    const refused: [unknown, string][] = [
      [hero({ height_step: 17 }), 'display.height_step'],
      [hero({ height_step: -7 }), 'display.height_step'],
      [hero({ height_step: 2.5 }), 'display.height_step'],
      [hero({ height_step: '3' }), 'display.height_step'],
      [hero({ height_px: 30 }), 'display.height_px'],
      [hero({ content_width: 8 }), 'display.content_width'],
      [hero({ text_width: 8 }), 'display.text_width'],
      [hero({ text_width: 3 }), 'display.text_width'],
      [hero({}, { align: 'left' }), 'align'],
      [banner({ space_before: 11 }), 'display.space_before'],
      [banner({ space_after: -1 }), 'display.space_after'],
      [banner({ text_width: 5 }), 'display.text_width'],
      [{ ...textBlock(), display: { height_step: 1 } }, 'display.height_step'],
      [
        { ...textBlock(), display: { content_width: 5 } },
        'display.content_width',
      ],
      [
        { ...textBlock(), display: { content_width: 11 } },
        'display.content_width',
      ],
      [
        { ...textBlock(), display: { content_align: 'left' } },
        'display.content_align',
      ],
      [{ ...textBlock(), display: { per_view: 4 } }, 'display.per_view'],
      [picks({ per_view: 6 }), 'display.per_view'],
      [picks({ per_view: 4.5 }), 'display.per_view'],
      [cards('circle', { per_view: 3 }), 'display.per_view'],
      [cards('portrait', { per_view: 8 }), 'display.per_view'],
    ];
    for (const [blk, field] of refused) {
      const r = await save(s, 0, [blk]).expect(400);
      expect(r.body.error.code).toBe('STORE_HOME_INVALID');
      expect(JSON.stringify(r.body.error.details)).toContain(field);
    }

    // accepted: kept as whole steps; a default (0, 10 = 100%, start, null) is not stored
    let r = await save(s, 0, [
      hero(
        { height_step: 16, space_before: 0, space_after: 10, text_width: 4 },
        { align: 'end' },
      ),
      banner({ height_step: -6, space_before: 3 }),
      picks({
        per_view: 5,
        content_width: 6,
        content_align: 'center',
        space_after: 0,
      }),
      {
        ...textBlock(),
        id: 'text-fine',
        display: {
          content_width: 10,
          content_align: 'start',
          space_before: null,
          height: undefined,
        },
      },
      cards('square', { per_view: 6, content_align: 'end' }),
    ]).expect(200);
    const [h, bn, p, tx, c] = r.body.draft.blocks;
    expect(h.display).toEqual({
      width: 'content',
      height: 'medium',
      spacing: 'normal',
      height_step: 16,
      space_before: 0,
      space_after: 10,
      text_width: 4,
    });
    expect(h.slides[0].align).toBe('end');
    expect(bn.display).toEqual({
      width: 'content',
      height: 'medium',
      spacing: 'normal',
      height_step: -6,
      space_before: 3,
    });
    expect(p.display).toEqual({
      spacing: 'normal',
      per_view: 5,
      content_width: 6,
      content_align: 'center',
      space_after: 0,
    });
    expect(tx.display).toEqual({ spacing: 'normal' });
    expect(c.display).toEqual({
      spacing: 'normal',
      per_view: 6,
      content_align: 'end',
    });
    r = await save(s, 1, [hero({ height_step: 0 })]).expect(200);
    expect(r.body.draft.blocks[0].display).toEqual({
      width: 'content',
      height: 'medium',
      spacing: 'normal',
    });
    expect(r.body.display.fine_keys).toMatchObject({
      hero: ['height_step', 'space_before', 'space_after', 'text_width'],
      text: ['space_before', 'space_after', 'content_width', 'content_align'],
    });
    expect(r.body.display.steps.height_step).toMatchObject({
      min: -6,
      max: 16,
    });

    // published with the block
    r = await save(s, 2, [
      hero({ height_step: 3, space_after: 6 }),
      picks({ per_view: 3 }),
    ]).expect(200);
    await publish(s, 3).expect(200);
    const home: any = await publicHome(s);
    expect(home.blocks[0].display).toMatchObject({
      height_step: 3,
      space_after: 6,
    });
    expect(home.blocks[1].display).toMatchObject({ per_view: 3 });

    // an older published row without any fine key: exactly the presets, nothing added
    await prisma.storeHomeLayout.update({
      where: { vendorId: s.vendorId },
      data: {
        published: {
          blocks: [
            {
              id: 'old-hero',
              type: 'hero',
              visible: true,
              display: { height: 'wide' },
              slides: [{ image: img(url) }],
            },
          ],
        },
      },
    });
    expect(((await publicHome(s)) as any).blocks[0].display).toEqual({
      width: 'content',
      height: 'wide',
      spacing: 'normal',
    });
  });

  // ---------------- P3 «لوحة ترويجية» promo_grid (2026-11-22)

  const promoTile = (url: string, extra: Record<string, unknown> = {}) => ({
    image: img(url),
    title: text('عرض'),
    ...extra,
  });
  const promo = (tiles: unknown[], extra: Record<string, unknown> = {}) => ({
    id: bid(),
    type: 'promo_grid',
    visible: true,
    tiles,
    ...extra,
  });

  it("promo panel: a closed block of 0-4 stored tiles; ready layouts per tile count, the wide tile 50/60%, four dividers; texts within limits; images this store's own; internal destinations only; anything else refused; defaults filled", async () => {
    const s = await f.store();
    const other = await f.store();
    const url = await upload(s);
    const foreign = await upload(other);
    const theirs = await product(other);
    const t = (extra: Record<string, unknown> = {}) => promoTile(url, extra);
    const refused: [unknown, string, string][] = [
      [
        promo([t(), t()], { layout: 'big_start' }),
        'layout',
        'STORE_HOME_INVALID',
      ],
      [
        promo([t(), t(), t()], { layout: 'start_wide' }),
        'layout',
        'STORE_HOME_INVALID',
      ],
      [
        promo([t(), t(), t(), t()], { layout: 'even' }),
        'layout',
        'STORE_HOME_INVALID',
      ],
      [promo([t(), t()], { layout: 'mosaic' }), 'layout', 'STORE_HOME_INVALID'],
      [
        promo([t(), t(), t()], { layout: 'big_start', share: 70 }),
        'share',
        'STORE_HOME_INVALID',
      ],
      [promo([t(), t()], { share: '60' }), 'share', 'STORE_HOME_INVALID'],
      [
        promo([t(), t()], { divider: 'zigzag' }),
        'divider',
        'STORE_HOME_INVALID',
      ],
      [
        promo([t(), t()], { divider: { angle: 12 } }),
        'divider',
        'STORE_HOME_INVALID',
      ],
      [promo([t(), t(), t(), t(), t()]), 'tiles', 'STORE_HOME_INVALID'],
      [promo([t({ href: '/x' }), t()]), 'href', 'STORE_HOME_INVALID'],
      [
        promo([t(), t()], { css: 'clip-path:none' }),
        'css',
        'STORE_HOME_INVALID',
      ],
      [
        promo([t(), t()], { display: { height_step: 3 } }),
        'display.height_step',
        'STORE_HOME_INVALID',
      ],
      [
        promo([t({ title: text('ع'.repeat(41)) }), t()]),
        'title',
        'STORE_HOME_INVALID',
      ],
      [
        promo([t({ text: text('ع'.repeat(81)) }), t()]),
        'text',
        'STORE_HOME_INVALID',
      ],
      [
        promo([t({ button: text('ز'.repeat(25)) }), t()]),
        'button',
        'STORE_HOME_INVALID',
      ],
      [promo([t({ focus: 'face' }), t()]), 'focus', 'STORE_HOME_INVALID'],
      [
        promo([
          t({
            button: text('اذهبي'),
            target: { kind: 'url', href: 'https://evil.example' },
          }),
          t(),
        ]),
        'kind',
        'STORE_HOME_INVALID',
      ],
      [
        promo([promoTile('https://evil.example/x.png'), t()]),
        'url',
        'UPLOAD_NOT_USABLE',
      ],
      [promo([promoTile(foreign), t()]), 'url', 'UPLOAD_NOT_USABLE'],
      [
        promo([
          t({
            button: text('القطعة'),
            target: { kind: 'product', id: theirs },
          }),
          t(),
        ]),
        '',
        'STORE_HOME_REFERENCE_NOT_FOUND',
      ],
    ];
    for (const [b, field, code] of refused) {
      const r = await save(s, 0, [b]);
      expect([400, 404]).toContain(r.status);
      expect(r.body.error.code).toBe(code);
      if (field) expect(JSON.stringify(r.body.error)).toContain(field);
    }

    // every layout of each count, every divider, both shares
    const layouts: [number, string[]][] = [
      [2, ['even', 'start_wide', 'end_wide']],
      [3, ['even', 'big_start', 'big_end']],
      [4, ['grid', 'big_start', 'big_end']],
    ];
    let version = 0;
    for (const [count, names] of layouts) {
      for (const [i, layout] of names.entries()) {
        const divider = ['gap', 'straight', 'slant', 'wave'][i % 4];
        const share = i % 2 ? 50 : 60;
        const r = await save(s, version, [
          promo(
            Array.from({ length: count }, () => t()),
            { layout, divider, share },
          ),
        ]).expect(200);
        version = r.body.draft_version;
        expect(r.body.draft.blocks[0]).toMatchObject({
          layout,
          divider,
          share,
        });
      }
    }
    // defaults: the count's first layout, 60%, a quiet gap; an empty panel saves (autosave)
    let r = await save(s, version, [
      promo([t(), t()], { id: 'pg-defaults' }),
      promo([], { id: 'pg-empty' }),
      promo([t(), t(), t()], {
        id: 'pg-fine',
        display: { content_width: 8, content_align: 'center', space_before: 2 },
      }),
    ]).expect(200);
    expect(r.body.draft.blocks[0]).toMatchObject({
      layout: 'even',
      share: 60,
      divider: 'gap',
      display: { spacing: 'normal' },
      tiles: [
        { focus: 'center', button: { ar: '', en: '' }, target: null },
        {},
      ],
    });
    expect(r.body.draft.blocks[1]).toMatchObject({ layout: 'even', tiles: [] });
    expect(r.body.draft.blocks[2].display).toEqual({
      spacing: 'normal',
      content_width: 8,
      content_align: 'center',
      space_before: 2,
    });
    expect(r.body.review['pg-empty']).toMatchObject({
      shown: false,
      reason: 'too_few',
    });
    expect(r.body.choices.promo).toMatchObject({
      layouts: { 2: ['even', 'start_wide', 'end_wide'] },
      shares: [50, 60],
      dividers: ['gap', 'straight', 'slant', 'wave'],
    });
    // the 20-image limit counts the tiles
    r = await save(s, r.body.draft_version, [
      ...Array.from({ length: 5 }, () => promo([t(), t(), t(), t()])),
      promo([t()]),
    ]).expect(400);
    expect(r.body.error.message).toContain('20 images');
  });

  it('promo panel for shoppers: complete tiles only (image, Arabic title, a button with its destination together or neither), at least two, in a layout that suits their count; «فحص قبل النشر» stops incomplete tiles; English falls back; a destination with nothing now hides the button only', async () => {
    const s = await f.store();
    const url = await upload(s);
    const a = await product(s);
    const soldOut = await product(s, 0);
    const t = (extra: Record<string, unknown> = {}) => promoTile(url, extra);
    let r = await save(s, 0, [
      promo(
        [
          t({ button: text('تسوّقي'), target: { kind: 'products' } }),
          t({ text: text('وصف قصير') }),
          t({ image: null }),
          t({ title: text('', 'English only'), button: text('اذهبي') }),
        ],
        { id: 'pg-shop', layout: 'big_end', divider: 'slant' },
      ),
    ]).expect(200);
    // two complete tiles: shown in the two-tile default (big_end does not suit two)
    expect(r.body.review['pg-shop']).toMatchObject({
      shown: true,
      shown_items: 2,
    });
    expect(r.body.preview.blocks[0]).toMatchObject({
      type: 'promo_grid',
      layout: 'even',
      divider: 'slant',
    });
    const codes = (l: { code: string; card?: number }[]) =>
      l.map((i) => `${i.code}:${i.card ?? '-'}`).sort();
    expect(codes(r.body.checks.errors)).toEqual([
      'button_no_target:4',
      'card_no_title:4',
      'no_image:3',
    ]);
    expect((await publish(s, 1).expect(400)).body.error.code).toBe(
      'STORE_HOME_NOT_READY',
    );

    // a destination without a button label is an error too
    r = await save(s, 1, [
      promo([t(), t({ target: { kind: 'products' } })], { id: 'pg-shop' }),
    ]).expect(200);
    expect(codes(r.body.checks.errors)).toEqual([
      'target_no_button:2',
      'too_few_chosen:-',
    ]);

    // complete: three tiles, wide at the end, 50%, a wave; a sold-out destination hides the button only
    r = await save(s, 2, [
      promo(
        [
          t({
            title: text('فساتين', 'Dresses'),
            text: text('موسم جديد'),
            button: text('تسوّقي'),
            target: { kind: 'product', id: a },
          }),
          t({
            button: text('القطعة'),
            target: { kind: 'product', id: soldOut },
          }),
          t({ alt: text('عارضة بفستان') }),
        ],
        { id: 'pg-shop', layout: 'big_end', share: 50, divider: 'wave' },
      ),
    ]).expect(200);
    expect(r.body.checks.errors).toEqual([]);
    expect(r.body.checks.warnings).toEqual(
      expect.arrayContaining([
        { code: 'target_unavailable', block_id: 'pg-shop', card: 2 },
      ]),
    );
    await publish(s, 3).expect(200);
    const home: any = await publicHome(s);
    expect(home.blocks[0]).toMatchObject({
      type: 'promo_grid',
      layout: 'big_end',
      share: 50,
      divider: 'wave',
    });
    expect(home.blocks[0].tiles).toHaveLength(3);
    expect(home.blocks[0].tiles[0]).toMatchObject({
      title: { ar: 'فساتين', en: 'Dresses' },
      button: { ar: 'تسوّقي' },
      target: { kind: 'product', id: a },
    });
    expect(home.blocks[0].tiles[1]).toMatchObject({
      title: { ar: 'عرض', en: 'عرض' },
      button: { ar: '', en: '' },
      target: null,
    });
    expect(home.blocks[0].tiles[2]).toMatchObject({
      alt: { ar: 'عارضة بفستان' },
    });
    expect(JSON.stringify(home)).not.toMatch(/"(quantity|stock|draft)":/);
  });
});
