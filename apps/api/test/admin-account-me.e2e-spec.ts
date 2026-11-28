import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
// POST /auth/login validates the phone as a Palestinian mobile number, so
// helpers/test-phone's +999 numbers cannot sign in. e2e-phone-lanes.ts
// hands out +97056 0000000-9989999 (30 lanes * 333,000); the numbers
// from 9990001 up belong to no lane, and only this file uses them.
const RUN_STAMP = Date.now() % 1000;
let phoneSeq = 0;
function uniqueLoginPhone(): string {
  phoneSeq += 1;
  const n = 9_990_000 + RUN_STAMP * 9 + phoneSeq;
  if (n > 9_999_999) throw new Error('admin-account-me: phone range exhausted');
  return `+97056${n}`;
}

// VIA Control Center phase 1: a platform staff account made out of band
// (seed-platform-staff.ts) has no CustomerProfile. GET /customers/me is
// read by AppShell on every page, so it must answer for that account
// from the User row (display_name null) instead of failing - while the
// admin can still sign in and open the platform workspace.

const PASSWORD = 'admin-phase1-password';

describe('VIA admin phase 1 - GET /customers/me without a CustomerProfile (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let passwordHash: string;

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
    passwordHash = await bcrypt.hash(PASSWORD, 10);
  });

  afterAll(async () => {
    await app?.close();
  });

  async function account(opts: {
    platformRole?: 'PLATFORM_ADMIN' | 'VERIFICATION_REVIEWER';
    profile?: { displayName: string | null };
  }) {
    const phone = uniqueLoginPhone();
    const user = await prisma.user.create({
      data: {
        phone,
        passwordHash,
        phoneVerifiedAt: new Date(),
        languagePref: 'en',
        platformRole: opts.platformRole ?? null,
      },
    });
    if (opts.profile) {
      await prisma.customerProfile.create({
        data: { userId: user.id, displayName: opts.profile.displayName },
      });
    }
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ phone, password: PASSWORD });
    expect(login.status).toBe(200);
    return { id: user.id, phone, token: login.body.session_token as string };
  }

  const me = (token: string) =>
    request(app.getHttpServer())
      .get('/api/v1/customers/me')
      .set('Authorization', `Bearer ${token}`);

  it('a PLATFORM_ADMIN with no CustomerProfile signs in and reads its own account, display_name null', async () => {
    const admin = await account({ platformRole: 'PLATFORM_ADMIN' });
    const res = await me(admin.token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: admin.id,
      phone: admin.phone,
      email: null,
      language_pref: 'en',
      phone_verified_at: expect.any(String),
      display_name: null,
    });
    // Reading it never creates a profile behind the admin's back.
    expect(
      await prisma.customerProfile.count({ where: { userId: admin.id } }),
    ).toBe(0);
  });

  it('the same admin opens the platform workspace and reads an admin route', async () => {
    const admin = await account({ platformRole: 'PLATFORM_ADMIN' });
    const enter = await request(app.getHttpServer())
      .post('/api/v1/me/workspace-sessions')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ type: 'platform' });
    expect(enter.status).toBe(201);
    expect(enter.body.workspace_token).toEqual(expect.any(String));

    const queue = await request(app.getHttpServer())
      .get('/api/v1/admin/verification-queue')
      .set('Authorization', `Bearer ${admin.token}`)
      .set('X-Workspace-Token', enter.body.workspace_token);
    expect(queue.status).toBe(200);
  });

  it('a VERIFICATION_REVIEWER with no CustomerProfile reads its own account too', async () => {
    const reviewer = await account({ platformRole: 'VERIFICATION_REVIEWER' });
    const res = await me(reviewer.token);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(reviewer.id);
    expect(res.body.display_name).toBeNull();
  });

  it('a customer still gets its profile display_name (and null when it never set one)', async () => {
    const named = await account({
      profile: { displayName: 'زبون المرحلة الأولى' },
    });
    const namedRes = await me(named.token);
    expect(namedRes.status).toBe(200);
    expect(namedRes.body.display_name).toBe('زبون المرحلة الأولى');

    const unnamed = await account({ profile: { displayName: null } });
    const unnamedRes = await me(unnamed.token);
    expect(unnamedRes.status).toBe(200);
    expect(unnamedRes.body.display_name).toBeNull();
  });

  let keySeq = 0;
  const patchMe = (token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .patch('/api/v1/customers/me')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', `admin-me-${Date.now()}-${++keySeq}`)
      .send(body);

  it('the admin without a CustomerProfile saves its language (PATCH), still without a profile', async () => {
    const admin = await account({ platformRole: 'PLATFORM_ADMIN' });
    const res = await patchMe(admin.token, { language_pref: 'ar' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: admin.id,
      phone: admin.phone,
      language_pref: 'ar',
      display_name: null,
      session_token: null,
      session_status: null,
    });
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: admin.id },
    });
    expect(after.languagePref).toBe('ar');
    expect((await me(admin.token)).body.language_pref).toBe('ar');
    expect(
      await prisma.customerProfile.count({ where: { userId: admin.id } }),
    ).toBe(0);
  });

  it('the admin cannot set a display_name: refused before anything is written, no profile created', async () => {
    const admin = await account({ platformRole: 'PLATFORM_ADMIN' });
    const res = await patchMe(admin.token, {
      language_pref: 'ar',
      display_name: 'اسم',
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CUSTOMER_PROFILE_REQUIRED');
    // The language in the same request was not saved either.
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: admin.id },
    });
    expect(after.languagePref).toBe('en');
    expect(
      await prisma.customerProfile.count({ where: { userId: admin.id } }),
    ).toBe(0);
  });

  it('a customer still saves its display_name and language together', async () => {
    const customer = await account({ profile: { displayName: 'قبل' } });
    const res = await patchMe(customer.token, {
      language_pref: 'ar',
      display_name: 'بعد',
    });
    expect(res.status).toBe(200);
    expect(res.body.display_name).toBe('بعد');
    expect(res.body.language_pref).toBe('ar');
    const profile = await prisma.customerProfile.findUniqueOrThrow({
      where: { userId: customer.id },
    });
    expect(profile.displayName).toBe('بعد');
  });

  it('GET /cart: the admin without a profile has an empty cart; changing it is a typed 403, never a 500', async () => {
    const admin = await account({ platformRole: 'PLATFORM_ADMIN' });
    const list = await request(app.getHttpServer())
      .get('/api/v1/cart')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);

    const add = await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Idempotency-Key', `admin-cart-${Date.now()}`)
      .send({
        vendor_id: '00000000-0000-4000-8000-000000000001',
        offer_variant_id: '00000000-0000-4000-8000-000000000002',
        quantity: 1,
      });
    expect(add.status).toBe(403);
    expect(add.body.error.code).toBe('CUSTOMER_PROFILE_REQUIRED');
    expect(
      await prisma.customerProfile.count({ where: { userId: admin.id } }),
    ).toBe(0);
  });

  it('GET /cart: a customer with a profile and an empty cart still gets 200 []', async () => {
    const customer = await account({ profile: { displayName: null } });
    const list = await request(app.getHttpServer())
      .get('/api/v1/cart')
      .set('Authorization', `Bearer ${customer.token}`);
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
  });

  it('a visitor without a session is refused', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/customers/me');
    expect(res.status).toBe(401);
  });
});
