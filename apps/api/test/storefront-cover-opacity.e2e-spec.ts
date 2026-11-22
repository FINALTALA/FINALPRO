import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { uniqueTestPhone } from './helpers/test-phone';

// Storefront cover look as per-store settings: coverImageOpacity (default
// .2) and coverTintOpacity (default .3) - the values the public hero used
// before they became settings. Users are inserted directly and given a
// session through SessionService (no OTP, so no phone lane).
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

describe('Storefront cover opacity settings (e2e)', () => {
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

  /** An existing store with a cover image and colour, created without
   * the new fields (as every store before this migration). */
  async function makeStore() {
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('cover-store'),
        legalName: unique('Legal'),
        displayName: 'متجر الغلاف',
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        storefrontPublished: true,
        coverImageUrl: 'https://example.com/cover.jpg',
        coverColor: '#D6AFA4',
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

  it('an existing store keeps the current look: defaults 0.2 / 0.3 on the owner and public endpoints', async () => {
    const { vendor, owner } = await makeStore();
    const own = await ownerGet(vendor.id, owner).expect(200);
    expect(own.body).toMatchObject({
      cover_image_url: 'https://example.com/cover.jpg',
      cover_color: '#D6AFA4',
      cover_image_opacity: 0.2,
      cover_tint_opacity: 0.3,
    });
    const pub = await publicGet(vendor.slug).expect(200);
    expect(pub.body).toMatchObject({
      cover_image_opacity: 0.2,
      cover_tint_opacity: 0.3,
    });
  });

  it('the existing storefront update saves both, and the public page returns them', async () => {
    const { vendor, owner } = await makeStore();
    const res = await ownerPut(vendor.id, owner, {
      cover_image_opacity: 0.65,
      cover_tint_opacity: 0.1,
    }).expect(200);
    expect(res.body).toMatchObject({
      cover_image_opacity: 0.65,
      cover_tint_opacity: 0.1,
      // Untouched: not sent.
      cover_image_url: 'https://example.com/cover.jpg',
      cover_color: '#D6AFA4',
    });
    const pub = await publicGet(vendor.slug).expect(200);
    expect(pub.body.cover_image_opacity).toBe(0.65);
    expect(pub.body.cover_tint_opacity).toBe(0.1);
  });

  it('each field is optional (partial update), and the bounds 0 and 1 are valid', async () => {
    const { vendor, owner } = await makeStore();
    await ownerPut(vendor.id, owner, { cover_image_opacity: 0 }).expect(200);
    let own = await ownerGet(vendor.id, owner).expect(200);
    expect(own.body.cover_image_opacity).toBe(0);
    expect(own.body.cover_tint_opacity).toBe(0.3);
    await ownerPut(vendor.id, owner, { cover_tint_opacity: 1 }).expect(200);
    own = await ownerGet(vendor.id, owner).expect(200);
    expect(own.body.cover_image_opacity).toBe(0);
    expect(own.body.cover_tint_opacity).toBe(1);
    // Other storefront edits never reset them.
    await ownerPut(vendor.id, owner, { bio: 'نبذة' }).expect(200);
    own = await ownerGet(vendor.id, owner).expect(200);
    expect(own.body).toMatchObject({
      cover_image_opacity: 0,
      cover_tint_opacity: 1,
    });
  });

  it('refuses anything that is not a number between 0 and 1, changing nothing', async () => {
    const { vendor, owner } = await makeStore();
    for (const body of [
      { cover_image_opacity: -0.01 },
      { cover_image_opacity: 1.01 },
      { cover_image_opacity: '0.5' },
      { cover_tint_opacity: 2 },
      { cover_tint_opacity: 'high' },
      { cover_tint_opacity: null },
    ]) {
      const res = await ownerPut(vendor.id, owner, body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    const own = await ownerGet(vendor.id, owner).expect(200);
    expect(own.body).toMatchObject({
      cover_image_opacity: 0.2,
      cover_tint_opacity: 0.3,
    });
  });

  it('cover_image_url and cover_color behave exactly as before (removing the colour = no colour layer)', async () => {
    const { vendor, owner } = await makeStore();
    const res = await ownerPut(vendor.id, owner, {
      cover_color: '',
      cover_image_opacity: 0.4,
    }).expect(200);
    expect(res.body).toMatchObject({
      cover_color: null,
      cover_image_opacity: 0.4,
      cover_tint_opacity: 0.3,
    });
    const bad = await ownerPut(vendor.id, owner, {
      cover_color: 'pink',
    }).expect(400);
    expect(bad.body.error.code).toBeDefined();
  });

  it('owner only, like the rest of the storefront settings; the database also refuses an out-of-range value', async () => {
    const { vendor, branch, owner } = await makeStore();
    const employee = await member(vendor.id, 'BRANCH_EMPLOYEE', branch.id);
    const denied = await ownerPut(vendor.id, employee, {
      cover_image_opacity: 1,
    }).expect(403);
    expect(denied.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');
    await expect(
      prisma.vendor.update({
        where: { id: vendor.id },
        data: { coverTintOpacity: 1.5 },
      }),
    ).rejects.toThrow(/coverTintOpacity_range|check constraint/i);
    const own = await ownerGet(vendor.id, owner).expect(200);
    expect(own.body.cover_tint_opacity).toBe(0.3);
  });
});
