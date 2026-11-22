import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { APPEARANCE_DEFAULTS } from './../src/vendors/storefront-appearance';
import { uniqueTestPhone } from './helpers/test-phone';

// The product panel's appearance (the panel pencil): one JSONB
// configuration of overrides, returned resolved over the defaults by the
// owner and public storefront endpoints, updated only by the owner's
// partial PUT and strictly validated.
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
type Tree = Record<string, any>;

describe('Storefront product-panel appearance (e2e)', () => {
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
        slug: unique('panel-store'),
        legalName: unique('Legal'),
        displayName: 'متجر اللوحة',
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        storefrontPublished: true,
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
  const stored = async (vendorId: string) =>
    (
      await prisma.vendor.findUniqueOrThrow({
        where: { id: vendorId },
        select: { storefrontAppearance: true },
      })
    ).storefrontAppearance;

  it("every existing store stores '{}' and both endpoints return the full default configuration (= the current look)", async () => {
    const { vendor, owner } = await makeStore();
    expect(await stored(vendor.id)).toEqual({});
    const own = await ownerGet(vendor.id, owner).expect(200);
    expect(own.body.storefront_appearance).toEqual(APPEARANCE_DEFAULTS);
    const pub = await publicGet(vendor.slug).expect(200);
    expect(pub.body.storefront_appearance).toEqual(APPEARANCE_DEFAULTS);
    // Spot-check the defaults against the stylesheet's own values.
    expect(pub.body.storefront_appearance.panel.background).toBe('#FFFDFC');
    expect(
      pub.body.storefront_appearance.departments.women.active,
    ).toMatchObject({
      background: '#4A1626',
      glow: '#7A2E3A',
      glow_strength: 1,
      text: '#FFFFFF',
    });
    expect(
      pub.body.storefront_appearance.subcategories.kids.default
        .background_opacity,
    ).toBe(0.68);
  });

  it('partial updates change only what is sent, keep earlier changes, and each department is independent', async () => {
    const { vendor, owner } = await makeStore();
    await ownerPut(vendor.id, owner, {
      storefront_appearance: {
        panel: { background: '#F5EEE8', radius: 16 },
        departments: {
          women: { active: { background: '#1F2A44', text: '#FFF8F2' } },
        },
      },
    }).expect(200);
    const res = await ownerPut(vendor.id, owner, {
      storefront_appearance: {
        smart: { radius: 8, active: { glow_strength: 0.4 } },
        subcategories: { men: { default: { radius: 6 } } },
      },
    }).expect(200);
    const expected = clone(APPEARANCE_DEFAULTS) as Tree;
    expected.panel.background = '#F5EEE8';
    expected.panel.radius = 16;
    expected.departments.women.active.background = '#1F2A44';
    expected.departments.women.active.text = '#FFF8F2';
    expected.smart.radius = 8;
    expected.smart.active.glow_strength = 0.4;
    expected.subcategories.men.default.radius = 6;
    expect(res.body.storefront_appearance).toEqual(expected);
    const pub = await publicGet(vendor.slug).expect(200);
    expect(pub.body.storefront_appearance).toEqual(expected);
    // Men's / kids' / all buttons are untouched by the women change.
    for (const d of ['all', 'men', 'kids']) {
      expect(pub.body.storefront_appearance.departments[d]).toEqual(
        (APPEARANCE_DEFAULTS.departments as Tree)[d],
      );
    }
    // Only the overrides are stored.
    expect(await stored(vendor.id)).toEqual({
      panel: { background: '#F5EEE8', radius: 16 },
      departments: {
        women: { active: { background: '#1F2A44', text: '#FFF8F2' } },
      },
      smart: { radius: 8, active: { glow_strength: 0.4 } },
      subcategories: { men: { default: { radius: 6 } } },
    });
    // Other storefront fields and the cover layers are not touched.
    expect(pub.body).toMatchObject({
      cover_color: '#C99585',
      cover_image_opacity: 0.2,
      cover_bottom_fade_opacity: 0.06,
    });
  });

  it('null restores a section, group or state to the defaults', async () => {
    const { vendor, owner } = await makeStore();
    await ownerPut(vendor.id, owner, {
      storefront_appearance: {
        panel: { text: '#222222' },
        departments: {
          men: { default: { text: '#333333' } },
          kids: { active: { text: '#444444' } },
        },
      },
    }).expect(200);
    const res = await ownerPut(vendor.id, owner, {
      storefront_appearance: { panel: null, departments: { men: null } },
    }).expect(200);
    expect(res.body.storefront_appearance.panel).toEqual(
      APPEARANCE_DEFAULTS.panel,
    );
    expect(res.body.storefront_appearance.departments.men).toEqual(
      (APPEARANCE_DEFAULTS.departments as Tree).men,
    );
    expect(res.body.storefront_appearance.departments.kids.active.text).toBe(
      '#444444',
    );
    expect(await stored(vendor.id)).toEqual({
      departments: { kids: { active: { text: '#444444' } } },
    });
  });

  it('refuses invalid colours, ranges, types and unknown settings with 400 - changing nothing', async () => {
    const { vendor, owner } = await makeStore();
    await ownerPut(vendor.id, owner, {
      storefront_appearance: { panel: { radius: 20 } },
    }).expect(200);
    const cases: unknown[] = [
      { panel: { background: 'white' } },
      { panel: { background: '#FFF' } },
      { panel: { text: '#GGGGGG' } },
      { panel: { background_opacity: 1.01 } },
      { panel: { divider_opacity: -0.1 } },
      { panel: { radius: 61 } },
      { panel: { shadow_blur: 81 } },
      { panel: { shadow_offset_y: 41 } },
      { panel: { shadow_offset_y: -41 } },
      { panel: { radius: '20' } },
      { panel: { background: null } },
      { panel: { colour: '#FFFFFF' } },
      { navbar: {} },
      { smart: { radius: 1000 } },
      { smart: { default: { shadow_blur: 61 } } },
      { smart: { default: { radius: 4 } } },
      { departments: { teens: { default: {} } } },
      { departments: { women: { hover: {} } } },
      { departments: { women: { active: { glow_strength: 2 } } } },
      { subcategories: { all: { default: {} } } },
      { subcategories: { kids: { active: { border_opacity: '0.5' } } } },
      { subcategories: { kids: { active: { radius: -1 } } } },
      { panel: [] },
      [],
      'blue',
    ];
    for (const appearance of cases) {
      const res = await ownerPut(vendor.id, owner, {
        storefront_appearance: appearance,
      });
      expect({ appearance, status: res.status }).toEqual({
        appearance,
        status: 400,
      });
    }
    expect(await stored(vendor.id)).toEqual({ panel: { radius: 20 } });
    const bad = await ownerPut(vendor.id, owner, {
      storefront_appearance: { smart: { active: { text: 'red' } } },
    }).expect(400);
    expect(bad.body.error).toMatchObject({
      code: 'INVALID_STOREFRONT_APPEARANCE',
      details: ['smart.active.text'],
    });
  });

  it('accepts the documented bounds', async () => {
    const { vendor, owner } = await makeStore();
    await ownerPut(vendor.id, owner, {
      storefront_appearance: {
        panel: {
          radius: 0,
          shadow_blur: 80,
          shadow_offset_y: -40,
          background_opacity: 0,
          shadow_opacity: 1,
        },
        smart: { radius: 999, default: { shadow_blur: 60, glow_strength: 0 } },
        subcategories: { women: { active: { radius: 0 } } },
      },
    }).expect(200);
    await ownerPut(vendor.id, owner, {
      storefront_appearance: { panel: { radius: 60, shadow_offset_y: 40 } },
    }).expect(200);
    const own = await ownerGet(vendor.id, owner).expect(200);
    expect(own.body.storefront_appearance.panel).toMatchObject({
      radius: 60,
      shadow_offset_y: 40,
      shadow_blur: 80,
    });
  });

  it('only the store owner may change it; the public endpoint is read-only', async () => {
    const { vendor, branch } = await makeStore();
    const employee = await member(vendor.id, 'BRANCH_EMPLOYEE', branch.id);
    const denied = await ownerPut(vendor.id, employee, {
      storefront_appearance: { panel: { background: '#000000' } },
    }).expect(403);
    expect(denied.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');
    const other = await makeStore();
    await ownerPut(vendor.id, other.owner, {
      storefront_appearance: { panel: { background: '#000000' } },
    }).expect(403);
    await request(http())
      .put(`/api/v1/vendors/${vendor.id}/storefront`)
      .send({ storefront_appearance: { panel: { background: '#000000' } } })
      .expect(401);
    for (const method of ['put', 'patch', 'post'] as const) {
      const res = await request(http())
        [method](`/api/v1/storefronts/${vendor.slug}`)
        .send({ storefront_appearance: { panel: { background: '#000000' } } });
      expect(res.status).toBe(404);
    }
    expect(await stored(vendor.id)).toEqual({});
  });
});
