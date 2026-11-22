import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { uniqueTestPhone } from './helpers/test-phone';

// Independent storefront cover layers: image, upper wash, global colour
// layer, bottom panel fade - each with its own switch, colour and
// strength; switching one off keeps its values.
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

const DEFAULT_LOOK = {
  cover_image_enabled: true,
  cover_image_opacity: 0.2,
  cover_tint_enabled: true,
  cover_tint_opacity: 0.3,
  cover_global_overlay_enabled: false,
  cover_global_overlay_color: '#D6AFA4',
  cover_global_overlay_opacity: 0.25,
  cover_global_overlay_brightness: 1,
  cover_bottom_fade_enabled: true,
  cover_bottom_fade_color: '#4A1626',
  cover_bottom_fade_opacity: 0.06,
};

describe('Storefront cover layers (e2e)', () => {
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

  /** A store as it existed before these settings: cover image + colour. */
  async function makeStore() {
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('layers-store'),
        legalName: unique('Legal'),
        displayName: 'متجر الطبقات',
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        storefrontPublished: true,
        coverImageUrl: 'https://example.com/cover.jpg',
        coverColor: '#C99585',
      },
    });
    const branch = await prisma.storeBranch.create({
      data: { vendorId: vendor.id, name: 'الفرع' },
    });
    return { vendor, branch, owner: await member(vendor.id, 'OWNER') };
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

  it("existing stores keep today's look: image + upper wash on, global layer off, the panel fade as before", async () => {
    const { vendor, owner } = await makeStore();
    const own = await ownerGet(vendor.id, owner).expect(200);
    expect(own.body).toMatchObject({
      cover_image_url: 'https://example.com/cover.jpg',
      cover_color: '#C99585',
      ...DEFAULT_LOOK,
    });
    const pub = await publicGet(vendor.slug).expect(200);
    expect(pub.body).toMatchObject({ cover_color: '#C99585', ...DEFAULT_LOOK });
  });

  it('each layer is switched independently, and switching one off keeps its colour and strength', async () => {
    const { vendor, owner } = await makeStore();
    // Global layer on with its own settings, upper wash off.
    await ownerPut(vendor.id, owner, {
      cover_global_overlay_enabled: true,
      cover_global_overlay_color: '#1F2A44',
      cover_global_overlay_opacity: 0.55,
      cover_global_overlay_brightness: 1.3,
      cover_tint_enabled: false,
    }).expect(200);
    let pub = await publicGet(vendor.slug).expect(200);
    expect(pub.body).toMatchObject({
      cover_global_overlay_enabled: true,
      cover_global_overlay_color: '#1F2A44',
      cover_global_overlay_opacity: 0.55,
      cover_global_overlay_brightness: 1.3,
      cover_tint_enabled: false,
      // The upper wash is off, not erased.
      cover_color: '#C99585',
      cover_tint_opacity: 0.3,
    });

    // Every layer off: nothing is erased.
    await ownerPut(vendor.id, owner, {
      cover_image_enabled: false,
      cover_global_overlay_enabled: false,
      cover_bottom_fade_enabled: false,
    }).expect(200);
    pub = await publicGet(vendor.slug).expect(200);
    expect(pub.body).toMatchObject({
      cover_image_enabled: false,
      cover_image_url: 'https://example.com/cover.jpg',
      cover_image_opacity: 0.2,
      cover_global_overlay_enabled: false,
      cover_global_overlay_color: '#1F2A44',
      cover_global_overlay_opacity: 0.55,
      cover_global_overlay_brightness: 1.3,
      cover_bottom_fade_enabled: false,
      cover_bottom_fade_color: '#4A1626',
      cover_bottom_fade_opacity: 0.06,
    });

    // Back on: the saved values return unchanged.
    await ownerPut(vendor.id, owner, {
      cover_tint_enabled: true,
      cover_global_overlay_enabled: true,
    }).expect(200);
    pub = await publicGet(vendor.slug).expect(200);
    expect(pub.body).toMatchObject({
      cover_tint_enabled: true,
      cover_color: '#C99585',
      cover_global_overlay_enabled: true,
      cover_global_overlay_color: '#1F2A44',
      cover_global_overlay_opacity: 0.55,
    });
  });

  it('partial updates change only what is sent; the bottom fade colour and strength are configurable', async () => {
    const { vendor, owner } = await makeStore();
    const res = await ownerPut(vendor.id, owner, {
      cover_bottom_fade_color: '#813E51',
      cover_bottom_fade_opacity: 0.4,
    }).expect(200);
    expect(res.body).toMatchObject({
      ...DEFAULT_LOOK,
      cover_bottom_fade_color: '#813E51',
      cover_bottom_fade_opacity: 0.4,
      cover_color: '#C99585',
      cover_image_url: 'https://example.com/cover.jpg',
    });
    await ownerPut(vendor.id, owner, { bio: 'نبذة' }).expect(200);
    const own = await ownerGet(vendor.id, owner).expect(200);
    expect(own.body).toMatchObject({
      cover_bottom_fade_color: '#813E51',
      cover_bottom_fade_opacity: 0.4,
    });
  });

  it('accepts the documented bounds (opacity 0-1, brightness 0.5-1.5)', async () => {
    const { vendor, owner } = await makeStore();
    for (const body of [
      { cover_global_overlay_opacity: 0, cover_bottom_fade_opacity: 1 },
      { cover_global_overlay_opacity: 1, cover_bottom_fade_opacity: 0 },
      { cover_global_overlay_brightness: 0.5 },
      { cover_global_overlay_brightness: 1.5 },
    ]) {
      await ownerPut(vendor.id, owner, body).expect(200);
    }
    const own = await ownerGet(vendor.id, owner).expect(200);
    expect(own.body).toMatchObject({
      cover_global_overlay_opacity: 1,
      cover_bottom_fade_opacity: 0,
      cover_global_overlay_brightness: 1.5,
    });
  });

  it('refuses invalid values with 400 and changes nothing', async () => {
    const { vendor, owner } = await makeStore();
    for (const body of [
      { cover_global_overlay_opacity: 1.2 },
      { cover_global_overlay_opacity: -0.1 },
      { cover_bottom_fade_opacity: '0.3' },
      { cover_global_overlay_brightness: 0.49 },
      { cover_global_overlay_brightness: 1.51 },
      { cover_global_overlay_brightness: null },
      { cover_global_overlay_color: 'navy' },
      { cover_global_overlay_color: '#12345' },
      { cover_global_overlay_color: '' },
      { cover_bottom_fade_color: '#GGGGGG' },
      { cover_bottom_fade_color: null },
      { cover_image_enabled: 'false' },
      { cover_tint_enabled: 1 },
      { cover_global_overlay_enabled: null },
      { cover_bottom_fade_enabled: 'yes' },
    ]) {
      const res = await ownerPut(vendor.id, owner, body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    const own = await ownerGet(vendor.id, owner).expect(200);
    expect(own.body).toMatchObject(DEFAULT_LOOK);
  });

  it('owner only; and the database itself refuses an invalid colour, opacity or brightness', async () => {
    const { vendor, branch, owner } = await makeStore();
    const employee = await member(vendor.id, 'BRANCH_EMPLOYEE', branch.id);
    const denied = await ownerPut(vendor.id, employee, {
      cover_global_overlay_enabled: true,
    }).expect(403);
    expect(denied.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');
    for (const [data, constraint] of [
      [{ coverGlobalOverlayColor: 'red' }, 'coverGlobalOverlayColor_hex'],
      [{ coverBottomFadeColor: '#12' }, 'coverBottomFadeColor_hex'],
      [{ coverColor: 'pink' }, 'coverColor_hex'],
      [
        { coverGlobalOverlayBrightness: 2 },
        'coverGlobalOverlayBrightness_range',
      ],
      [{ coverBottomFadeOpacity: -1 }, 'coverBottomFadeOpacity_range'],
    ] as const) {
      await expect(
        prisma.vendor.update({ where: { id: vendor.id }, data }),
      ).rejects.toThrow(new RegExp(`${constraint}|check constraint`, 'i'));
    }
    const own = await ownerGet(vendor.id, owner).expect(200);
    expect(own.body).toMatchObject({ cover_color: '#C99585', ...DEFAULT_LOOK });
  });
});
