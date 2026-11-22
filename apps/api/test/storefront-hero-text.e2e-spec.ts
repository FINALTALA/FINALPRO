import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { uniqueTestPhone } from './helpers/test-phone';

// The hero title's and description's own text styling (their pencils):
// colour, font, weight and a readability shadow, independent of each
// other; null = the stylesheet's default.
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

const DEFAULT_TEXT = {
  hero_title_color: null,
  hero_title_font: null,
  hero_title_weight: null,
  hero_title_shadow_enabled: false,
  hero_title_shadow_strength: 0.5,
  bio_color: null,
  bio_font: null,
  bio_weight: null,
  bio_shadow_enabled: false,
  bio_shadow_strength: 0.5,
};

describe('Storefront hero text styling (e2e)', () => {
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

  const http = () => app.getHttpServer();

  async function member(
    vendorId: string,
    role: 'OWNER' | 'BRANCH_EMPLOYEE',
    branchId?: string,
  ) {
    const phone = uniqueTestPhone();
    const user = await prisma.user.create({
      data: { phone, passwordHash: 'not-used', phoneVerifiedAt: new Date() },
    });
    await prisma.vendorUser.create({
      data: { userId: user.id, vendorId, role, branchId: branchId ?? null },
    });
    return app.get(SessionService).create({
      userId: user.id,
      phone,
      phoneVerifiedAt: user.phoneVerifiedAt!.toISOString(),
      sessionVersion: user.sessionVersion,
    });
  }

  async function makeStore() {
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('hero-text-store'),
        legalName: unique('Legal'),
        displayName: 'متجر النصوص',
        heroTitle: 'متجر فلسطيني للألبسة الشرعية',
        bio: 'وصف قصير',
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        storefrontPublished: true,
      },
    });
    const branch = await prisma.storeBranch.create({
      data: { vendorId: vendor.id, name: 'الفرع' },
    });
    return {
      vendor,
      owner: await member(vendor.id, 'OWNER'),
      employee: await member(vendor.id, 'BRANCH_EMPLOYEE', branch.id),
    };
  }

  const ownerGet = (vendorId: string, token: string) =>
    request(http())
      .get(`/api/v1/vendors/${vendorId}/storefront`)
      .set('Authorization', `Bearer ${token}`);
  const ownerPut = (vendorId: string, token: string, body: object) =>
    request(http())
      .put(`/api/v1/vendors/${vendorId}/storefront`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const publicGet = (slug: string) =>
    request(http()).get(`/api/v1/storefronts/${slug}`);

  it('existing stores render the default typography (no settings)', async () => {
    const { vendor, owner } = await makeStore();
    expect((await ownerGet(vendor.id, owner).expect(200)).body).toMatchObject(
      DEFAULT_TEXT,
    );
    expect((await publicGet(vendor.slug).expect(200)).body).toMatchObject(
      DEFAULT_TEXT,
    );
  });

  it('the title colour/font/weight/shadow save with its text and survive a reload; the description is untouched', async () => {
    const { vendor, owner } = await makeStore();
    const res = await ownerPut(vendor.id, owner, {
      hero_title: 'عنوان جديد',
      hero_title_color: '#4A1626',
      hero_title_font: 'REEM_KUFI',
      hero_title_weight: 600,
      hero_title_shadow_enabled: true,
      hero_title_shadow_strength: 0.7,
    }).expect(200);
    expect(res.body).toMatchObject({
      hero_title: 'عنوان جديد',
      hero_title_color: '#4A1626',
      hero_title_font: 'REEM_KUFI',
      hero_title_weight: 600,
      hero_title_shadow_enabled: true,
      hero_title_shadow_strength: 0.7,
    });
    const pub = (await publicGet(vendor.slug).expect(200)).body;
    expect(pub).toMatchObject({
      hero_title: 'عنوان جديد',
      hero_title_color: '#4A1626',
      hero_title_font: 'REEM_KUFI',
      hero_title_weight: 600,
      hero_title_shadow_enabled: true,
      hero_title_shadow_strength: 0.7,
      bio: 'وصف قصير',
      bio_color: null,
      bio_font: null,
      bio_weight: null,
      bio_shadow_enabled: false,
    });
  });

  it('the description has its own settings; changing one never changes the other', async () => {
    const { vendor, owner } = await makeStore();
    await ownerPut(vendor.id, owner, {
      hero_title_color: '#813E51',
      hero_title_font: 'AMIRI',
    }).expect(200);
    await ownerPut(vendor.id, owner, {
      bio: 'وصف جديد',
      bio_color: '#6B5F5A',
      bio_font: 'BALOO_BHAIJAAN',
      bio_weight: 500,
    }).expect(200);
    const after = (await publicGet(vendor.slug).expect(200)).body;
    expect(after).toMatchObject({
      hero_title_color: '#813E51',
      hero_title_font: 'AMIRI',
      hero_title_weight: null,
      bio: 'وصف جديد',
      bio_color: '#6B5F5A',
      bio_font: 'BALOO_BHAIJAAN',
      bio_weight: 500,
    });
    // Back to the default for the title only (null and "" both reset).
    await ownerPut(vendor.id, owner, {
      hero_title_color: null,
      hero_title_font: '',
    }).expect(200);
    const reset = (await publicGet(vendor.slug).expect(200)).body;
    expect(reset).toMatchObject({
      hero_title_color: null,
      hero_title_font: null,
      bio_color: '#6B5F5A',
      bio_font: 'BALOO_BHAIJAAN',
    });
    // Turning the shadow off keeps its strength.
    await ownerPut(vendor.id, owner, {
      bio_shadow_enabled: true,
      bio_shadow_strength: 0.3,
    }).expect(200);
    const off = await ownerPut(vendor.id, owner, {
      bio_shadow_enabled: false,
    }).expect(200);
    expect(off.body).toMatchObject({
      bio_shadow_enabled: false,
      bio_shadow_strength: 0.3,
      hero_title_shadow_enabled: false,
    });
  });

  it('refuses invalid colours, fonts, weights and shadow strengths - nothing is stored', async () => {
    const { vendor, owner } = await makeStore();
    for (const body of [
      { hero_title_color: 'red' },
      { bio_color: '#12345' },
      { hero_title_color: 'url(x)' },
      { hero_title_font: 'Comic Sans' },
      { bio_font: 'https://evil.example/font.woff2' },
      { hero_title_weight: 800 },
      { bio_weight: '700' },
      { hero_title_shadow_strength: 0 },
      { bio_shadow_strength: 1.5 },
      { hero_title_shadow_enabled: 'yes' },
    ]) {
      const res = await ownerPut(vendor.id, owner, body).expect(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
    }
    // Amiri ships its bold face only - also against the stored weight.
    const amiri = await ownerPut(vendor.id, owner, {
      hero_title_font: 'AMIRI',
      hero_title_weight: 400,
    }).expect(400);
    expect(amiri.body.error.code).toBe('FONT_WEIGHT_UNAVAILABLE');
    await ownerPut(vendor.id, owner, { bio_weight: 500 }).expect(200);
    const later = await ownerPut(vendor.id, owner, {
      bio_font: 'AMIRI',
    }).expect(400);
    expect(later.body.error.code).toBe('FONT_WEIGHT_UNAVAILABLE');
    await ownerPut(vendor.id, owner, {
      bio_font: 'AMIRI',
      bio_weight: 700,
    }).expect(200);
    const stored = (await publicGet(vendor.slug).expect(200)).body;
    expect(stored).toMatchObject({
      ...DEFAULT_TEXT,
      bio_font: 'AMIRI',
      bio_weight: 700,
    });
    // The database refuses what the API would.
    await expect(
      prisma.vendor.update({
        where: { id: vendor.id },
        data: { heroTitleFont: 'Arial' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.vendor.update({
        where: { id: vendor.id },
        data: { heroTitleColor: 'red' },
      }),
    ).rejects.toThrow();
  });

  it('only the owner may change them; the public endpoint only reads', async () => {
    const { vendor, employee } = await makeStore();
    const denied = await ownerPut(vendor.id, employee, {
      hero_title_color: '#4A1626',
    }).expect(403);
    expect(denied.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');
    const stranger = await makeStore();
    await ownerPut(vendor.id, stranger.owner, {
      bio_color: '#4A1626',
    }).expect(403);
    await request(http())
      .put(`/api/v1/vendors/${vendor.id}/storefront`)
      .send({ bio_color: '#4A1626' })
      .expect(401);
    await request(http())
      .put(`/api/v1/storefronts/${vendor.slug}`)
      .send({ bio_color: '#4A1626' })
      .expect(404);
    expect((await publicGet(vendor.slug).expect(200)).body).toMatchObject(
      DEFAULT_TEXT,
    );
  });
});
