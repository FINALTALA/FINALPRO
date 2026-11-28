import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as os from 'os';
import * as path from 'path';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { uniqueTestPhone } from './helpers/test-phone';

// VIA phase 6 extension - the Women, Men and Kids pages in the same Content
// Studio: the additive enum migration, their registry sections (hero,
// ticker, offer strip - no catalogue data), import = published revision 1
// and never a second time, decorative images (Women) need no alt text while
// informative ones (Men / Kids) do, Arabic + English rules, 409 on a stale
// draft, Media Library usage under CONTENT_<PAGE>, schedule + cancel,
// restore, and PLATFORM_ADMIN-only administration with an open public view.
// The shared engine itself is proven by content-studio-6.e2e-spec.ts.

let seq = 0;
const unique = (l: string) => `${l}-${Date.now()}-${++seq}`;
const tx = (ar: string, en: string) => ({ ar, en });
const bundled = (p: string, alt = tx('', '')) => ({ source: 'bundled', path: p, alt });

function audienceDoc(
  page: 'WOMEN' | 'MEN' | 'KIDS',
  o: { image?: object; ctaEn?: string } = {},
) {
  const p = page.toLowerCase();
  const hero: Record<string, unknown> = {
    title: tx('عنوان', 'Title'),
    cta_label: tx('تسوّق الآن', o.ctaEn ?? 'Shop now'),
    cta_link: { href: `/${p}#${p}-products` },
    image:
      o.image ??
      (page === 'WOMEN'
        ? bundled('/images/women-hero-runway.png')
        : bundled(`/images/${p}-hero.png`, tx('صورة الواجهة', 'Hero picture'))),
  };
  if (page === 'WOMEN') {
    hero.title_art = bundled('/images/via-women-hero-title.svg');
    hero.subject = bundled('/images/women-hero-runway-subject.png');
  } else {
    hero.copy_strong = tx('أزياء', 'Fashion');
    hero.copy_span = tx('أناقة', 'Style');
  }
  return {
    schemaVersion: 1,
    sections: [
      { id: `${p}-hero`, key: `${p}.hero`, enabled: true, fields: hero, items: [] },
      {
        id: `${p}-ticker`,
        key: `${p}.ticker`,
        enabled: true,
        fields: { label: tx('اكتشف', 'Discover') },
        items: [
          { id: 'phrase-1', fields: { text: tx('اكتشف', 'Discover') } },
          { id: 'phrase-2', fields: { text: tx('قارن', 'Compare') } },
        ],
      },
      {
        id: `${p}-offer`,
        key: `${p}.offer`,
        enabled: true,
        fields: {
          pre: tx('اشتري بـ ', 'Spend '),
          amount: tx('500 ₪', '₪500'),
          mid: tx(' واحصل على ', ' and get '),
          benefit: tx('توصيل مجاني', 'free delivery'),
          link_label: tx('تسوّق الآن', 'Shop now'),
          link: { href: `/${p}#${p}-products` },
        },
        items: [],
      },
    ],
  };
}

describe('Phase 6 extension - Women, Men and Kids in the Content Studio (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: { id: string; token: string };
  let reviewer: { id: string; token: string };

  beforeAll(async () => {
    process.env.PLATFORM_MEDIA_DIR = path.join(os.tmpdir(), `via-content-aud-${process.pid}`);
    const m: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = m.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    admin = await account('PLATFORM_ADMIN');
    reviewer = await account('VERIFICATION_REVIEWER');
  });
  afterAll(async () => {
    await app?.close();
  });

  const srv = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  async function account(platformRole: 'PLATFORM_ADMIN' | 'VERIFICATION_REVIEWER') {
    const phone = uniqueTestPhone();
    const user = await prisma.user.create({
      data: { phone, passwordHash: 'x', phoneVerifiedAt: new Date(), platformRole },
    });
    const token = await app.get(SessionService).create({
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
  const put = (page: string, version: number, document: object) =>
    request(srv()).put(`/api/v1/admin/content/${page}/draft`).set(auth(admin.token)).send({ version, document });
  const get = (p: string, who = admin) => request(srv()).get(`/api/v1/admin/content/${p}`).set(auth(who.token));

  async function asset() {
    const id = (await prisma.$queryRaw<{ id: string }[]>`SELECT gen_random_uuid()::text AS id`)[0].id;
    return prisma.mediaAsset.create({
      data: {
        id,
        name: unique('asset'),
        category: 'HOMEPAGE',
        kind: 'IMAGE',
        mimeType: 'image/png',
        storageKey: `homepage/2026/${id}.png`,
        sizeBytes: 10,
        width: 10,
        height: 10,
        sha256: 'b'.repeat(64),
        validationState: 'VALID',
        uploadedById: admin.id,
      },
    });
  }

  it('migration + registry: three new page keys with editorial sections only; authorization', async () => {
    const labels = await prisma.$queryRaw<{ v: string }[]>`
      SELECT unnest(enum_range(NULL::"ContentPageKey"))::text AS v`;
    expect(labels.map((l) => l.v)).toEqual(['HOMEPAGE', 'TRENDING', 'ADS', 'WOMEN', 'MEN', 'KIDS']);

    const reg = (await get('registry').expect(200)).body as { pages: string[]; sections: { key: string; page: string }[] };
    expect(reg.pages).toEqual(['HOMEPAGE', 'TRENDING', 'ADS', 'WOMEN', 'MEN', 'KIDS']);
    for (const p of ['WOMEN', 'MEN', 'KIDS'])
      expect(reg.sections.filter((s) => s.page === p).map((s) => s.key)).toEqual(
        ['hero', 'ticker', 'offer'].map((k) => `${p.toLowerCase()}.${k}`),
      );
    const overview = (await get('').expect(200)).body as { page: string; exists: boolean }[];
    expect(overview.map((r) => r.page)).toEqual(reg.pages);

    await get('WOMEN', reviewer).expect(403);
    await post('MEN/import', { document: audienceDoc('MEN') }, reviewer).expect(403);
    await request(srv()).get('/api/v1/admin/content/KIDS').expect(401);
    // Public view is open; not imported yet -> the page keeps its built-in content.
    const pub = await request(srv()).get('/api/v1/content/WOMEN').expect(200);
    expect(pub.body).toMatchObject({ managed: false, published: false });
    // A section of another page is refused.
    const wrong = audienceDoc('WOMEN');
    wrong.sections[0].key = 'men.hero';
    await post('WOMEN/import', { document: wrong }).expect(400);
  });

  it('import = published revision 1, once only; decorative Women images need no alt, Men/Kids images do', async () => {
    for (const p of ['WOMEN', 'MEN', 'KIDS'] as const) {
      const d = (await post(`${p}/import`, { document: audienceDoc(p) }).expect(201)).body;
      expect(d.revisions).toHaveLength(1);
      expect(d.revisions[0]).toMatchObject({ number: 1, source: 'IMPORT', live: true });
      expect(d.draft_problems).toEqual([]);
      const pub = await request(srv()).get(`/api/v1/content/${p}`).expect(200);
      expect(pub.body.managed).toBe(true);
      expect(pub.body.sections.map((s: { key: string }) => s.key)).toEqual(
        ['hero', 'ticker', 'offer'].map((k) => `${p.toLowerCase()}.${k}`),
      );
      // Idempotent: a second import is refused and changes nothing.
      const again = await post(`${p}/import`, { document: audienceDoc(p, { ctaEn: 'Other' }) }).expect(409);
      expect(again.body.error.code).toBe('CONTENT_ALREADY_IMPORTED');
      expect((await get(p)).body.revisions).toHaveLength(1);
    }
    // Informative Men image without alt text, and a missing English text: both block publication.
    const men = (await get('MEN')).body;
    const doc = audienceDoc('MEN', { image: bundled('/images/men-hero.png'), ctaEn: '' });
    const saved = (await put('MEN', men.draft_version, doc).expect(200)).body;
    const codes = saved.draft_problems.map((x: { code: string; field: string }) => `${x.code}:${x.field}`).sort();
    expect(codes).toEqual(['ALT_TEXT_MISSING:image', 'TRANSLATION_MISSING:cta_label']);
    const refused = await post('MEN/publish', { version: saved.draft_version }).expect(400);
    expect(refused.body.error.code).toBe('CONTENT_NOT_PUBLISHABLE');
  });

  it('draft stays private, 409 on a stale save, publish, schedule + cancel, restore; Library usage under CONTENT_KIDS', async () => {
    const kids = (await get('KIDS')).body;
    const img = await asset();
    const doc = audienceDoc('KIDS', {
      image: { source: 'library', assetId: img.id, alt: tx('أطفال بأزياء عصرية', 'Children in modern outfits') },
      ctaEn: 'Shop the edit',
    });
    const v2 = (await put('KIDS', kids.draft_version, doc).expect(200)).body;
    // A second editor still on the old version is refused.
    await put('KIDS', kids.draft_version, audienceDoc('KIDS')).expect(409);
    // Private until published.
    const before = (await request(srv()).get('/api/v1/content/KIDS')).body;
    expect(before.sections[0].fields.cta_label.en).toBe('Shop now');
    const preview = (await get('KIDS/preview').expect(200)).body;
    expect(preview.sections[0].fields.cta_label.en).toBe('Shop the edit');
    expect(preview.sections[0].fields.image.url).toContain('/media/preview/');
    await request(srv()).get('/api/v1/admin/content/KIDS/preview').expect(401);

    const draftUse = await prisma.mediaUsage.findMany({ where: { assetId: img.id, ownerType: 'CONTENT_KIDS' } });
    expect(draftUse.map((u) => u.state)).toEqual(['DRAFT']);

    // Schedule (Asia/Hebron wall time) then cancel.
    const day = new Date(Date.now() + 3 * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Hebron' });
    const s = (await post('KIDS/schedule', { version: v2.draft_version, local_date: day, local_time: '09:15' }).expect(201)).body;
    expect(s.schedules[0]).toMatchObject({ status: 'PENDING', local_time: `${day} 09:15` });
    await post('KIDS/schedule/cancel').expect(201);

    // Publish now: the public view follows, the asset is in published use.
    const pubd = (await post('KIDS/publish', { version: v2.draft_version }).expect(201)).body;
    const live = (await request(srv()).get('/api/v1/content/KIDS')).body;
    expect(live.sections[0].fields.cta_label.en).toBe('Shop the edit');
    expect(live.sections[0].fields.image.url).toContain('/media/p/');
    const states = (await prisma.mediaUsage.findMany({ where: { assetId: img.id, ownerType: 'CONTENT_KIDS' } })).map((u) => u.state);
    expect(states).toContain('PUBLISHED');

    // Restore the import (revision 1): a new revision goes live with the original copy.
    const rev1 = pubd.revisions.find((r: { number: number }) => r.number === 1);
    const restored = (await post(`KIDS/revisions/${rev1.id}/restore`).expect(201)).body;
    expect(restored.revisions[0]).toMatchObject({ source: 'RESTORE', live: true });
    expect((await request(srv()).get('/api/v1/content/KIDS')).body.sections[0].fields.cta_label.en).toBe('Shop now');

    // Unpublish keeps the page shell: the public view says so, the page renders its frame without these sections.
    await post('WOMEN/unpublish').expect(201);
    expect((await request(srv()).get('/api/v1/content/WOMEN')).body).toMatchObject({ managed: true, published: false });

    const audit = await prisma.auditLog.findMany({
      where: { entityType: 'ContentPage', entityId: { in: ['WOMEN', 'MEN', 'KIDS'] } },
      select: { action: true, entityId: true },
    });
    const acts = new Set(audit.map((a) => `${a.entityId}:${a.action}`));
    for (const a of ['WOMEN:content.imported', 'MEN:content.imported', 'KIDS:content.imported', 'KIDS:content.scheduled', 'KIDS:content.published', 'KIDS:content.restored', 'WOMEN:content.unpublished'])
      expect(acts).toContain(a);
  });
});
