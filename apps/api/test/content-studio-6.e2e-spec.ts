import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as os from 'os';
import * as path from 'path';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { ContentStudioService } from './../src/content-studio/content-studio.service';
import { instantsFor } from './../src/content-studio/content-schedule.util';
import { PrismaService } from './../src/prisma/prisma.service';
import { uniqueTestPhone } from './helpers/test-phone';

// VIA phase 6 - Content Studio: drafts with optimistic versions (409),
// Arabic/English + alt-text publication rules, media + reference
// dependencies, MediaUsage protection, publish / unpublish / schedule
// (Asia/Hebron, DST gaps and repeats, one pending, replace, cancel,
// exactly once, after downtime, failure + retry), restore and archive
// rules, immutable revisions, broken-media fallback with issues, and
// authorization. Uses its own fresh database (it asserts per-page state).

let seq = 0;
const unique = (l: string) => `${l}-${Date.now()}-${++seq}`;
const tx = (ar: string, en: string) => ({ ar, en });

describe('Phase 6 - Content Studio (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: { id: string; token: string };
  let admin2: { id: string; token: string };

  beforeAll(async () => {
    process.env.PLATFORM_MEDIA_DIR = path.join(
      os.tmpdir(),
      `via-content-test-${process.pid}`,
    );
    const m: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = m.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    admin = await account('PLATFORM_ADMIN');
    admin2 = await account('PLATFORM_ADMIN');
  });
  afterAll(async () => {
    await app?.close();
  });

  const srv = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  async function account(
    platformRole: 'PLATFORM_ADMIN' | 'VERIFICATION_REVIEWER' | null = null,
  ) {
    const phone = uniqueTestPhone();
    const user = await prisma.user.create({
      data: {
        phone,
        passwordHash: 'x',
        phoneVerifiedAt: new Date(),
        platformRole,
      },
    });
    const token = await app
      .get(SessionService)
      .create({
        userId: user.id,
        phone,
        phoneVerifiedAt: user.phoneVerifiedAt!.toISOString(),
        sessionVersion: user.sessionVersion,
      });
    return { id: user.id, token };
  }
  const post = (p: string, body: object = {}, who = admin) =>
    request(srv())
      .post(`/api/v1/admin/content/${p}`)
      .set(auth(who.token))
      .set('Idempotency-Key', unique('k'))
      .send(body);
  const put = (page: string, version: number, document: object, who = admin) =>
    request(srv())
      .put(`/api/v1/admin/content/${page}/draft`)
      .set(auth(who.token))
      .send({ version, document });
  const get = (p: string, who = admin) =>
    request(srv()).get(`/api/v1/admin/content/${p}`).set(auth(who.token));

  async function asset(kind: 'IMAGE' | 'VIDEO' = 'IMAGE') {
    const id = (
      await prisma.$queryRaw<
        { id: string }[]
      >`SELECT gen_random_uuid()::text AS id`
    )[0].id;
    return prisma.mediaAsset.create({
      data: {
        id,
        name: unique('asset'),
        category: 'HOMEPAGE',
        kind,
        mimeType: kind === 'IMAGE' ? 'image/png' : 'video/mp4',
        storageKey: `homepage/2026/${id}.${kind === 'IMAGE' ? 'png' : 'mp4'}`,
        sizeBytes: 10,
        width: 10,
        height: 10,
        durationMs: kind === 'VIDEO' ? 1000 : null,
        videoCodec: kind === 'VIDEO' ? 'avc1' : null,
        sha256: 'a'.repeat(64),
        validationState: 'VALID',
        uploadedById: admin.id,
      },
    });
  }

  /** A complete Homepage document (the "how it works" section from the Library). */
  function homeDoc(
    o: {
      heroImage?: object;
      stepImage?: object;
      headlineEn?: string;
      storeRef?: string;
    } = {},
  ) {
    return {
      schemaVersion: 1,
      sections: [
        {
          id: 'hero',
          key: 'home.hero',
          enabled: true,
          fields: {
            headline: tx('اكتشف', o.headlineEn ?? 'Discover'),
            subline: null,
            cta_label: tx('تسوق', 'Shop'),
            cta_link: { href: '/discovery' },
            image: o.heroImage ?? {
              source: 'bundled',
              path: '/images/hero.jpg',
              alt: tx('صورة الواجهة', 'Hero image'),
            },
          },
          items: [],
        },
        {
          id: 'how',
          key: 'home.how',
          enabled: true,
          fields: { heading: tx('كيف تعمل', 'How it works') },
          items: [
            {
              id: 'step-1',
              fields: {
                title: tx('اكتشف', 'Discover'),
                text: tx('نص', 'Text'),
                image: o.stepImage ?? {
                  source: 'bundled',
                  path: '/images/how-via/discover.jpg',
                  alt: tx('خطوة الاكتشاف', 'Discover step'),
                },
              },
            },
          ],
        },
        ...(o.storeRef
          ? [
              {
                id: 'picks',
                key: 'home.picks',
                enabled: true,
                fields: { heading: tx('مختارات', 'Picks') },
                items: [],
              },
            ]
          : []),
      ],
    };
  }

  it('authorization: admin endpoints and previews are PLATFORM_ADMIN only; the public view is open', async () => {
    const reviewer = await account('VERIFICATION_REVIEWER');
    const customer = await account();
    for (const who of [reviewer, customer]) {
      await get('', who).expect(403);
      await get('HOMEPAGE', who).expect(403);
      await get('HOMEPAGE/preview', who).expect(403);
      await post('HOMEPAGE/import', { document: homeDoc() }, who).expect(403);
      await put('HOMEPAGE', 1, homeDoc(), who).expect(403);
      await post('HOMEPAGE/publish', { version: 1 }, who).expect(403);
    }
    await request(srv()).get('/api/v1/admin/content').expect(401);
    const pub = await request(srv())
      .get('/api/v1/content/HOMEPAGE')
      .expect(200);
    expect(pub.body).toMatchObject({ managed: false, published: false });
    await request(srv()).get('/api/v1/content/PROFILE').expect(404);
  });

  it('import = revision 1, published as it is; drafts are versioned: a stale save is 409, concurrent saves never both win', async () => {
    const r = await post('HOMEPAGE/import', { document: homeDoc() }).expect(
      201,
    );
    expect(r.body).toMatchObject({
      exists: true,
      draft_version: 1,
      revisions: [
        expect.objectContaining({ number: 1, source: 'IMPORT', live: true }),
      ],
    });
    await post('HOMEPAGE/import', { document: homeDoc() }).expect(409);
    const pub = (
      await request(srv()).get('/api/v1/content/HOMEPAGE').expect(200)
    ).body;
    expect(pub).toMatchObject({ published: true, revision: 1 });
    expect(pub.sections.map((s: { key: string }) => s.key)).toEqual([
      'home.hero',
      'home.how',
    ]);

    // An incomplete draft saves (drafts may be incomplete).
    const incomplete = homeDoc({ headlineEn: '' });
    const v2 = await put('HOMEPAGE', 1, incomplete).expect(200);
    expect(v2.body.draft_version).toBe(2);
    expect(
      v2.body.draft_problems.some(
        (p: { code: string }) => p.code === 'TRANSLATION_MISSING',
      ),
    ).toBe(true);
    // The other admin, still on version 1: refused, nothing overwritten.
    const stale = await put('HOMEPAGE', 1, homeDoc(), admin2).expect(409);
    expect(stale.body.error).toMatchObject({
      code: 'CONTENT_VERSION_CONFLICT',
      details: [{ current_version: 2 }],
    });
    // Both admins at once on version 2: exactly one wins.
    const both = await Promise.all([
      put('HOMEPAGE', 2, homeDoc({ headlineEn: 'A' })),
      put('HOMEPAGE', 2, homeDoc({ headlineEn: 'B' }), admin2),
    ]);
    expect(both.map((x) => x.status).sort()).toEqual([200, 409]);
    // Structure is still enforced on drafts.
    const bad = await put('HOMEPAGE', 3, {
      schemaVersion: 1,
      sections: [
        { id: 'x', key: 'trend.hero', enabled: true, fields: {}, items: [] },
      ],
    }).expect(400);
    expect(bad.body.error.code).toBe('CONTENT_INVALID');
    await put('HOMEPAGE', 3, {
      schemaVersion: 1,
      sections: [
        {
          id: 'hero',
          key: 'home.hero',
          fields: { image: { source: 'bundled', path: '../../etc/passwd' } },
        },
      ],
    }).expect(400);
  });

  it('publication needs Arabic + English copy, informative alt text and available dependencies; preview shows what is missing; publishing records media usage', async () => {
    const d = (await get('HOMEPAGE').expect(200)).body;
    let v = d.draft_version;
    const img = await asset();
    // Missing EN headline + missing alt on library media.
    v = (
      await put(
        'HOMEPAGE',
        v,
        homeDoc({
          headlineEn: '',
          stepImage: { source: 'library', assetId: img.id },
        }),
      ).expect(200)
    ).body.draft_version;
    const pv = (await get('HOMEPAGE/preview').expect(200)).body;
    expect(pv.preview).toBe('draft');
    expect(pv.problems.map((p: { code: string }) => p.code).sort()).toEqual([
      'ALT_TEXT_MISSING',
      'TRANSLATION_MISSING',
    ]);
    const refused = await post('HOMEPAGE/publish', { version: v }).expect(400);
    expect(refused.body.error.code).toBe('CONTENT_NOT_PUBLISHABLE');
    // A wrong kind (video in an image field) and an archived file are refused too.
    const vid = await asset('VIDEO');
    v = (
      await put(
        'HOMEPAGE',
        v,
        homeDoc({
          stepImage: {
            source: 'library',
            assetId: vid.id,
            alt: tx('بديل', 'Alt text'),
          },
        }),
      ).expect(200)
    ).body.draft_version;
    expect(
      (
        await post('HOMEPAGE/publish', { version: v }).expect(400)
      ).body.error.details.map((p: { code: string }) => p.code),
    ).toEqual(['MEDIA_WRONG_KIND']);
    // Stale publish (version moved) is refused.
    await post('HOMEPAGE/publish', { version: v - 1 }).expect(409);

    v = (
      await put(
        'HOMEPAGE',
        v,
        homeDoc({
          stepImage: {
            source: 'library',
            assetId: img.id,
            alt: tx('خطوة', 'Step image'),
          },
        }),
      ).expect(200)
    ).body.draft_version;
    const pub = (await post('HOMEPAGE/publish', { version: v }).expect(201))
      .body;
    const live = pub.revisions.find((r: { live: boolean }) => r.live);
    expect(live).toMatchObject({ number: 2, source: 'PUBLISH' });
    const usages = await prisma.mediaUsage.findMany({
      where: { assetId: img.id, ownerType: 'CONTENT_HOMEPAGE' },
    });
    expect(usages.map((u) => u.state).sort()).toEqual(['DRAFT', 'PUBLISHED']);
    // The Library now refuses to archive it.
    const arch = await request(srv())
      .post(`/api/v1/admin/media/${img.id}/archive`)
      .set(auth(admin.token))
      .set('Idempotency-Key', unique('k'))
      .send({})
      .expect(409);
    expect(arch.body.error.code).toBe('MEDIA_IN_USE');
    // The public view serves it at its immutable published URL.
    const view = (
      await request(srv()).get('/api/v1/content/HOMEPAGE').expect(200)
    ).body;
    const how = view.sections.find(
      (s: { key: string }) => s.key === 'home.how',
    );
    expect(how.items[0].fields.image.url).toBe(
      `/media/p/${img.id}/${'a'.repeat(16)}.png`,
    );
  });

  it('references: a store, collection or product that is not public blocks publication', async () => {
    const v0 = (await get('ADS').expect(200)).body;
    expect(v0.exists).toBe(false);
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('st').toLowerCase(),
        legalName: unique('l'),
        displayName: 'متجر',
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        storefrontPublished: false,
      },
    });
    const doc = {
      schemaVersion: 1,
      sections: [
        {
          id: 'stores',
          key: 'ads.stores',
          enabled: true,
          fields: { heading: tx('متاجر', 'Stores') },
          items: [
            {
              id: 's1',
              fields: {
                store: { refType: 'store', refId: vendor.slug },
                image: null,
              },
            },
          ],
        },
      ],
    };
    const imp = (await post('ADS/import', { document: doc }).expect(201)).body;
    const p = await post('ADS/publish', { version: imp.draft_version }).expect(
      400,
    );
    expect(p.body.error.details[0]).toMatchObject({
      code: 'REFERENCE_UNAVAILABLE',
      item_id: 's1',
    });
    await prisma.vendor.update({
      where: { id: vendor.id },
      data: { storefrontPublished: true },
    });
    await post('ADS/publish', { version: imp.draft_version }).expect(201);
    const view = (await request(srv()).get('/api/v1/content/ADS').expect(200))
      .body;
    expect(view.sections[0].items[0].fields.store).toMatchObject({
      slug: vendor.slug,
      href: `/store/${vendor.slug}`,
    });
  });

  it('scheduling: Asia/Hebron local time (DST gap refused, repeated hour needs a choice); one pending; the revision is frozen; replace and cancel', async () => {
    // Find a real gap and a real repeated hour from the time-zone data.
    let gap: [string, string] | null = null;
    let repeat: [string, string] | null = null;
    for (let day = 0; day < 730 && (!gap || !repeat); day++) {
      const date = new Date(Date.UTC(2027, 0, 1) + day * 86_400_000)
        .toISOString()
        .slice(0, 10);
      for (let h = 0; h < 24; h++) {
        const time = `${String(h).padStart(2, '0')}:30`;
        const n = instantsFor(date, time).length;
        if (n === 0 && !gap) gap = [date, time];
        if (n === 2 && !repeat) repeat = [date, time];
      }
    }
    expect(gap && repeat).toBeTruthy();
    let v = (await get('HOMEPAGE').expect(200)).body.draft_version;
    const g = await post('HOMEPAGE/schedule', {
      version: v,
      local_date: gap![0],
      local_time: gap![1],
    }).expect(400);
    expect(g.body.error.code).toBe('SCHEDULE_TIME_NONEXISTENT');
    const a = await post('HOMEPAGE/schedule', {
      version: v,
      local_date: repeat![0],
      local_time: repeat![1],
    }).expect(400);
    expect(a.body.error.code).toBe('SCHEDULE_TIME_AMBIGUOUS');
    expect(a.body.error.details).toHaveLength(2);
    await post('HOMEPAGE/schedule', {
      version: v,
      local_date: '2020-01-01',
      local_time: '10:00',
    }).expect(400);

    const later = (
      await post('HOMEPAGE/schedule', {
        version: v,
        local_date: repeat![0],
        local_time: repeat![1],
        occurrence: 'later',
      }).expect(201)
    ).body;
    const s1 = later.schedules[0];
    expect(s1).toMatchObject({
      status: 'PENDING',
      local_time: `${repeat![0]} ${repeat![1]}`,
    });
    expect(new Date(s1.run_at).toISOString()).toBe(
      instantsFor(repeat![0], repeat![1])[1].toISOString(),
    );
    const frozen = await prisma.contentRevision.findUniqueOrThrow({
      where: { id: s1.revision_id },
    });

    // A later draft edit does not touch the scheduled revision.
    v = (
      await put(
        'HOMEPAGE',
        v,
        homeDoc({ headlineEn: 'Edited after scheduling' }),
      ).expect(200)
    ).body.draft_version;
    expect(
      (
        await prisma.contentRevision.findUniqueOrThrow({
          where: { id: s1.revision_id },
        })
      ).document,
    ).toEqual(frozen.document);

    // One pending per page: a second needs replace.
    const dup = await post('HOMEPAGE/schedule', {
      version: v,
      local_date: '2030-05-05',
      local_time: '10:00',
    }).expect(409);
    expect(dup.body.error.code).toBe('CONTENT_SCHEDULE_EXISTS');
    const rep = (
      await post('HOMEPAGE/schedule', {
        version: v,
        local_date: '2030-05-05',
        local_time: '10:00',
        replace: true,
      }).expect(201)
    ).body;
    expect(
      rep.schedules.map((s: { status: string }) => s.status).slice(0, 2),
    ).toEqual(['PENDING', 'REPLACED']);
    await post('HOMEPAGE/schedule/cancel').expect(201);
    await post('HOMEPAGE/schedule/cancel').expect(409);
    expect(
      await prisma.contentSchedule.count({
        where: { pageKey: 'HOMEPAGE', status: 'PENDING' },
      }),
    ).toBe(0);
    // The partial unique index itself: a second PENDING row is impossible.
    const rev = await prisma.contentRevision.findFirstOrThrow({
      where: { pageKey: 'HOMEPAGE' },
    });
    await prisma.contentSchedule.create({
      data: {
        pageKey: 'HOMEPAGE',
        revisionId: rev.id,
        runAt: new Date(Date.now() + 1e9),
        localTime: 'x',
      },
    });
    await expect(
      prisma.contentSchedule.create({
        data: {
          pageKey: 'HOMEPAGE',
          revisionId: rev.id,
          runAt: new Date(Date.now() + 1e9),
          localTime: 'y',
        },
      }),
    ).rejects.toThrow();
    await prisma.contentSchedule.updateMany({
      where: { pageKey: 'HOMEPAGE', status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
  });

  it('the worker publishes exactly once (two workers at once), after downtime too; a broken dependency fails it, leaves the live page, and a retry publishes', async () => {
    const svc = app.get(ContentStudioService);
    let v = (await get('HOMEPAGE').expect(200)).body.draft_version;
    v = (
      await put(
        'HOMEPAGE',
        v,
        homeDoc({ headlineEn: 'Scheduled headline' }),
      ).expect(200)
    ).body.draft_version;
    const s = (
      await post('HOMEPAGE/schedule', {
        version: v,
        local_date: '2030-01-01',
        local_time: '09:00',
      }).expect(201)
    ).body.schedules[0];
    // "Downtime": it fell due three days ago.
    await prisma.contentSchedule.update({
      where: { id: s.id },
      data: { runAt: new Date(Date.now() - 3 * 86_400_000) },
    });
    const [a, b] = await Promise.all([
      svc.runDueSchedules(),
      svc.runDueSchedules(),
    ]);
    expect(a.published + b.published).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: {
          action: 'content.schedule_published',
          afterState: { path: ['schedule_id'], equals: s.id },
        },
      }),
    ).toBe(1);
    const page = await prisma.contentPage.findUniqueOrThrow({
      where: { key: 'HOMEPAGE' },
    });
    expect(page.publishedRevisionId).toBe(s.revision_id);
    expect(
      (await request(srv()).get('/api/v1/content/HOMEPAGE').expect(200)).body
        .sections[0].fields.headline.en,
    ).toBe('Scheduled headline');
    expect((await svc.runDueSchedules()).published).toBe(0);

    // A schedule whose media is gone when it runs: FAILED, live page unchanged.
    const img = await asset();
    v = (
      await put(
        'HOMEPAGE',
        v,
        homeDoc({
          heroImage: {
            source: 'library',
            assetId: img.id,
            alt: tx('صورة', 'Hero picture'),
          },
        }),
      ).expect(200)
    ).body.draft_version;
    const s2 = (
      await post('HOMEPAGE/schedule', {
        version: v,
        local_date: '2030-01-02',
        local_time: '09:00',
      }).expect(201)
    ).body.schedules[0];
    await prisma.mediaAsset.update({
      where: { id: img.id },
      data: {
        status: 'ARCHIVED',
        archivedAt: new Date(),
        archivedById: admin.id,
      },
    });
    await prisma.contentSchedule.update({
      where: { id: s2.id },
      data: { runAt: new Date(Date.now() - 1000) },
    });
    expect((await svc.runDueSchedules()).failed).toBe(1);
    const failed = (await get('HOMEPAGE').expect(200)).body;
    expect(failed.schedules[0]).toMatchObject({
      id: s2.id,
      status: 'FAILED',
      attempts: 1,
    });
    expect(failed.schedules[0].last_error).toMatch(/missing or archived/);
    expect(
      (
        await prisma.contentPage.findUniqueOrThrow({
          where: { key: 'HOMEPAGE' },
        })
      ).publishedRevisionId,
    ).toBe(s.revision_id);
    // Retry: still broken -> FAILED again; fixed -> PUBLISHED.
    expect(
      (await post(`HOMEPAGE/schedules/${s2.id}/retry`).expect(201)).body.result,
    ).toBe('FAILED');
    await prisma.mediaAsset.update({
      where: { id: img.id },
      data: { status: 'ACTIVE', archivedAt: null, archivedById: null },
    });
    expect(
      (await post(`HOMEPAGE/schedules/${s2.id}/retry`).expect(201)).body.result,
    ).toBe('PUBLISHED');
    await post(`HOMEPAGE/schedules/${s2.id}/retry`).expect(409);
  });

  it('restore re-validates dependencies; archive only revisions neither live nor scheduled; revisions are immutable', async () => {
    const d = (await get('HOMEPAGE').expect(200)).body;
    const live = d.revisions.find((r: { live: boolean }) => r.live);
    const old = d.revisions.find((r: { number: number }) => r.number === 1);
    await post(`HOMEPAGE/revisions/${live.id}/archive`).expect(409);
    await post(`HOMEPAGE/revisions/${live.id}/restore`).expect(409);
    const restored = (
      await post(`HOMEPAGE/revisions/${old.id}/restore`).expect(201)
    ).body;
    const now = restored.revisions.find((r: { live: boolean }) => r.live);
    expect(now).toMatchObject({ source: 'RESTORE', restored_from_id: old.id });
    // A revision whose media is unavailable now cannot be restored.
    const withMedia = d.revisions.find(
      (r: { number: number }) => r.number === 2,
    );
    const doc2 = (
      await prisma.contentRevision.findUniqueOrThrow({
        where: { id: withMedia.id },
      })
    ).document as {
      sections: { items: { fields: { image: { assetId?: string } } }[] }[];
    };
    const assetId = doc2.sections[1].items[0].fields.image.assetId!;
    await prisma.mediaAsset.update({
      where: { id: assetId },
      data: {
        status: 'ARCHIVED',
        archivedAt: new Date(),
        archivedById: admin.id,
      },
    });
    expect(
      (await post(`HOMEPAGE/revisions/${withMedia.id}/restore`).expect(400))
        .body.error.code,
    ).toBe('CONTENT_NOT_PUBLISHABLE');
    await prisma.mediaAsset.update({
      where: { id: assetId },
      data: { status: 'ACTIVE', archivedAt: null, archivedById: null },
    });
    // Archive an old revision: its REVISION usage goes away.
    await post(`HOMEPAGE/revisions/${withMedia.id}/archive`).expect(201);
    expect(
      await prisma.mediaUsage.count({
        where: { assetId, revisionId: withMedia.id },
      }),
    ).toBe(0);
    await post(`HOMEPAGE/revisions/${withMedia.id}/restore`).expect(409);
    // Load into the draft: version-checked.
    const cur = (await get('HOMEPAGE').expect(200)).body.draft_version;
    await post(`HOMEPAGE/revisions/${old.id}/load-draft`, {
      version: cur - 1,
    }).expect(409);
    expect(
      (
        await post(`HOMEPAGE/revisions/${old.id}/load-draft`, {
          version: cur,
        }).expect(201)
      ).body.draft_version,
    ).toBe(cur + 1);
    // Immutable at the database level.
    await expect(
      prisma.contentRevision.update({
        where: { id: old.id },
        data: { document: { schemaVersion: 1, sections: [] } },
      }),
    ).rejects.toThrow(/immutable/);
  });

  it('after publication: broken media falls back / drops the item and is recorded as an issue (resolved when it renders again); unpublish keeps the shell', async () => {
    const img = await asset();
    let v = (await get('TRENDING').expect(200)).body.draft_version;
    expect(v).toBeUndefined();
    const doc = {
      schemaVersion: 1,
      sections: [
        {
          id: 'hero',
          key: 'trend.hero',
          enabled: true,
          fields: {
            headline: tx('الرائج', 'Trending'),
            subline: null,
          },
          items: [],
        },
        {
          id: 'reels',
          key: 'trend.reels',
          enabled: true,
          fields: { heading: tx('ريلز', 'Reels') },
          items: [
            {
              id: 'r1',
              fields: {
                title: tx('أ', 'A'),
                video: {
                  source: 'library',
                  assetId: img.id,
                  alt: tx('ريل أول', 'First reel'),
                },
              },
            },
            {
              id: 'r2',
              fields: {
                title: tx('ب', 'B'),
                video: {
                  source: 'bundled',
                  path: '/videos/reel.mp4',
                  alt: tx('ريل ثان', 'Second reel'),
                },
              },
            },
          ],
        },
      ],
    };
    v = (await post('TRENDING/import', { document: doc }).expect(201)).body
      .draft_version;
    // The file breaks after publication (e.g. restored from an old backup).
    await prisma.mediaAsset.update({
      where: { id: img.id },
      data: { status: 'PURGING', archivedAt: new Date() },
    });
    const view = (
      await request(srv()).get('/api/v1/content/TRENDING').expect(200)
    ).body;
    expect(
      view.sections.find((s: { key: string }) => s.key === 'trend.hero'),
    ).toBeTruthy(); // the healthy section stays
    const reels = view.sections.find(
      (s: { key: string }) => s.key === 'trend.reels',
    );
    expect(reels.items.map((i: { id: string }) => i.id)).toEqual(['r2']); // the broken item is dropped
    const issues = (await get('TRENDING').expect(200)).body.issues;
    expect(
      issues.map((i: { kind: string; item_id: string | null }) => [
        i.kind,
        i.item_id,
      ]),
    ).toEqual([['MEDIA_UNAVAILABLE', 'r1']]);

    // A required STRUCTURAL visual (the Ads hero slide image) that breaks:
    // the slide stays, with no media - the page uses its bundled fallback.
    const ads = (await get('ADS').expect(200)).body;
    const slideImg = await asset();
    const adsDoc = {
      ...ads.draft,
      sections: [
        {
          id: 'ads-hero',
          key: 'ads.hero',
          enabled: true,
          fields: {},
          items: [
            {
              id: 'women',
              fields: {
                title: tx('أساسيات', 'Essentials'),
                text: null,
                image: {
                  source: 'library',
                  assetId: slideImg.id,
                  alt: tx('صورة الحملة', 'Campaign image'),
                },
                link: null,
              },
            },
          ],
        },
        ...ads.draft.sections,
      ],
    };
    const av = (await put('ADS', ads.draft_version, adsDoc).expect(200)).body
      .draft_version;
    await post('ADS/publish', { version: av }).expect(201);
    await prisma.mediaAsset.update({
      where: { id: slideImg.id },
      data: { status: 'PURGING', archivedAt: new Date() },
    });
    const adsView = (
      await request(srv()).get('/api/v1/content/ADS').expect(200)
    ).body;
    const slide = adsView.sections.find(
      (s: { key: string }) => s.key === 'ads.hero',
    ).items[0];
    expect(slide).toMatchObject({ id: 'women', fields: { image: null } });
    expect(
      (await get('ADS').expect(200)).body.issues.map(
        (i: { kind: string; item_id: string }) => [i.kind, i.item_id],
      ),
    ).toEqual([['MEDIA_UNAVAILABLE', 'women']]);
    await prisma.mediaAsset.update({
      where: { id: img.id },
      data: { status: 'ACTIVE', archivedAt: null },
    });
    await request(srv()).get('/api/v1/content/TRENDING').expect(200);
    expect((await get('TRENDING').expect(200)).body.issues).toEqual([]);

    await post('TRENDING/unpublish').expect(201);
    expect(
      (await request(srv()).get('/api/v1/content/TRENDING').expect(200)).body,
    ).toMatchObject({ managed: true, published: false });
    await post('TRENDING/unpublish').expect(409);
    expect(
      await prisma.mediaUsage.count({
        where: { assetId: img.id, state: 'PUBLISHED' },
      }),
    ).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: {
          entityType: 'ContentPage',
          entityId: 'TRENDING',
          action: { in: ['content.imported', 'content.unpublished'] },
        },
      }),
    ).toBe(2);
  });
});
