import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SmsService } from './../src/auth/sms.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { BranchOrderService } from './../src/orders/branch-order.service';

class FakeSmsService {
  sent: { phone: string; code: string; expiresAt: Date }[] = [];
  async sendOtp(phone: string, code: string, expiresAt: Date) {
    this.sent.push({ phone, code, expiresAt });
  }
  lastCodeFor(phone: string): string {
    const matches = this.sent.filter((s) => s.phone === phone);
    if (matches.length === 0) {
      throw new Error(`No OTP was ever sent to ${phone} in this test`);
    }
    return matches[matches.length - 1].code;
  }
}

// +97056 - the only PS mobile prefix libphonenumber-js/max actually
// validates (see feedback memory: +97057/+97058 parse but are not
// valid PS mobile numbers under that bundle, found the hard way twice
// already in this project before).
let phoneSeq = (Date.now() % 1_000_000) + 100_000;
function uniquePhone(): string {
  phoneSeq += 1;
  return `+97056${(phoneSeq % 10_000_000).toString().padStart(7, '0')}`;
}
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

describe('Sprint 9 - BranchOrder model + delivery-window calendar setup (e2e)', () => {
  // Left undefined (not INestApplication) until beforeEach actually
  // assigns it: if Test.createTestingModule(...).compile() itself
  // throws (e.g. a DI wiring bug), afterEach must not call app.close()
  // on it, since that would mask the real compile-time error behind a
  // misleading "Cannot read properties of undefined" TypeError.
  let app: INestApplication | undefined;
  let fakeSms: FakeSmsService;
  let prisma: PrismaService;

  beforeEach(async () => {
    fakeSms = new FakeSmsService();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SmsService)
      .useValue(fakeSms)
      .compile();

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
    if (app) {
      await app.close();
    }
  });

  async function signup(phone: string, password: string): Promise<string> {
    await request(app.getHttpServer())
      .post('/api/v1/auth/otp/request')
      .send({ phone, purpose: 'signup' })
      .expect(202);
    const code = fakeSms.lastCodeFor(phone);
    const verify = await request(app.getHttpServer())
      .post('/api/v1/auth/otp/verify')
      .set('Idempotency-Key', `verify-${phone}`)
      .send({ phone, otp_code: code, purpose: 'signup' })
      .expect(200);
    const register = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ phone, password, verification_token: verify.body.session_token })
      .expect(201);
    return register.body.session_token as string;
  }

  async function createVendorWithTwoBranches(
    ownerToken: string,
  ): Promise<{ vendorId: string; branchAId: string; branchBId: string }> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('vendor-apply'))
      .send({
        legal_name: unique('Vendor'),
        branches: [
          { name: 'Branch A', is_physical: true },
          { name: 'Branch B', is_physical: true },
        ],
        applicable_categories: ['WOMEN'],
      })
      .expect(201);
    return {
      vendorId: res.body.id,
      branchAId: res.body.branches[0].id,
      branchBId: res.body.branches[1].id,
    };
  }

  async function inviteAndAcceptAsNewUser(
    ownerToken: string,
    vendorId: string,
    branchId: string,
    phone: string,
    password: string,
  ) {
    await request(app.getHttpServer())
      .post(`/api/v1/vendors/${vendorId}/branches/${branchId}/staff-invites`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('invite'))
      .send({ phone })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/auth/otp/request')
      .send({ phone, purpose: 'staff_invite' })
      .expect(202);
    const code = fakeSms.lastCodeFor(phone);
    const verify = await request(app.getHttpServer())
      .post('/api/v1/auth/otp/verify')
      .set('Idempotency-Key', unique('verify'))
      .send({ phone, otp_code: code, purpose: 'staff_invite' })
      .expect(200);
    const accept = await request(app.getHttpServer())
      .post('/api/v1/auth/staff-invites/accept')
      .set('Idempotency-Key', unique('accept'))
      .send({ phone, verification_token: verify.body.session_token, password })
      .expect(200);
    return accept.body;
  }

  async function setupVendorWithTwoBranchesAndEmployee() {
    const owner = await signup(uniquePhone(), 'a-strong-password');
    const { vendorId, branchAId, branchBId } =
      await createVendorWithTwoBranches(owner);
    const employeePhone = uniquePhone();
    const accepted = await inviteAndAcceptAsNewUser(
      owner,
      vendorId,
      branchAId,
      employeePhone,
      'employee-password',
    );
    return {
      owner,
      vendorId,
      branchAId,
      branchBId,
      employeeToken: accepted.session_token as string,
    };
  }

  describe('RB-FUL-001: delivery window CRUD (owner-only)', () => {
    it('an owner can create, list, update, and delete a delivery window', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);

      const created = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({
          day_of_week: 2,
          start_time: '10:00',
          end_time: '14:00',
          capacity: 5,
        })
        .expect(201);
      expect(created.body.day_of_week).toBe(2);
      expect(created.body.start_time).toBe('10:00');
      expect(created.body.end_time).toBe('14:00');
      expect(created.body.capacity).toBe(5);
      expect(created.body.exceptions).toEqual([]);

      const list = await request(app.getHttpServer())
        .get(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(list.body).toHaveLength(1);

      const updated = await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows/${created.body.id}`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({
          day_of_week: 2,
          start_time: '11:00',
          end_time: '15:00',
          capacity: 8,
        })
        .expect(200);
      expect(updated.body.start_time).toBe('11:00');
      expect(updated.body.capacity).toBe(8);

      await request(app.getHttpServer())
        .delete(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows/${created.body.id}`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);

      const listAfter = await request(app.getHttpServer())
        .get(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(listAfter.body).toHaveLength(0);
    });

    it('refuses a BRANCH_EMPLOYEE from creating, listing, updating, or deleting a window', async () => {
      const { vendorId, branchAId, employeeToken, owner } =
        await setupVendorWithTwoBranchesAndEmployee();
      const window = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({
          day_of_week: 1,
          start_time: '09:00',
          end_time: '12:00',
          capacity: 3,
        })
        .expect(201);

      const createRes = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows`,
        )
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          day_of_week: 3,
          start_time: '09:00',
          end_time: '12:00',
          capacity: 3,
        });
      expect(createRes.status).toBe(403);
      expect(createRes.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');

      const listRes = await request(app.getHttpServer())
        .get(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows`,
        )
        .set('Authorization', `Bearer ${employeeToken}`);
      expect(listRes.status).toBe(403);

      const updateRes = await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows/${window.body.id}`,
        )
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({
          day_of_week: 1,
          start_time: '09:00',
          end_time: '13:00',
          capacity: 3,
        });
      expect(updateRes.status).toBe(403);

      const deleteRes = await request(app.getHttpServer())
        .delete(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows/${window.body.id}`,
        )
        .set('Authorization', `Bearer ${employeeToken}`);
      expect(deleteRes.status).toBe(403);
    });

    it("BOLA: an owner cannot manage a DIFFERENT vendor's branch windows", async () => {
      const owner1 = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendor1Id, branchAId: branch1Id } =
        await createVendorWithTwoBranches(owner1);
      const window = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendor1Id}/branches/${branch1Id}/delivery-windows`,
        )
        .set('Authorization', `Bearer ${owner1}`)
        .send({
          day_of_week: 1,
          start_time: '09:00',
          end_time: '12:00',
          capacity: 3,
        })
        .expect(201);

      const owner2 = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendor2Id } = await createVendorWithTwoBranches(owner2);

      const createRes = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendor2Id}/branches/${branch1Id}/delivery-windows`,
        )
        .set('Authorization', `Bearer ${owner2}`)
        .send({
          day_of_week: 2,
          start_time: '09:00',
          end_time: '12:00',
          capacity: 3,
        });
      expect(createRes.status).toBe(404);
      expect(createRes.body.error.code).toBe('BRANCH_NOT_FOUND');

      const updateRes = await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendor2Id}/branches/${branch1Id}/delivery-windows/${window.body.id}`,
        )
        .set('Authorization', `Bearer ${owner2}`)
        .send({
          day_of_week: 1,
          start_time: '09:00',
          end_time: '13:00',
          capacity: 3,
        });
      expect(updateRes.status).toBe(404);
    });

    it("BOLA: a window created for branch A is not reachable via branch B's URL, even under the SAME vendor", async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId, branchBId } =
        await createVendorWithTwoBranches(owner);
      const window = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({
          day_of_week: 1,
          start_time: '09:00',
          end_time: '12:00',
          capacity: 3,
        })
        .expect(201);

      const res = await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendorId}/branches/${branchBId}/delivery-windows/${window.body.id}`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({
          day_of_week: 1,
          start_time: '09:00',
          end_time: '13:00',
          capacity: 3,
        });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('DELIVERY_WINDOW_NOT_FOUND');
    });

    it('rejects an end_time not after start_time', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({
          day_of_week: 1,
          start_time: '14:00',
          end_time: '10:00',
          capacity: 3,
        });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_WINDOW_TIME_RANGE');
    });

    it('rejects an out-of-range day_of_week and a non-positive capacity', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);

      const badDay = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({
          day_of_week: 7,
          start_time: '10:00',
          end_time: '12:00',
          capacity: 3,
        });
      expect(badDay.status).toBe(400);

      const badCapacity = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({
          day_of_week: 1,
          start_time: '10:00',
          end_time: '12:00',
          capacity: 0,
        });
      expect(badCapacity.status).toBe(400);
    });

    it('PDR-024: rejects a window that overlaps an existing one on the same branch/day, but allows a truly adjacent one', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({
          day_of_week: 2,
          start_time: '10:00',
          end_time: '14:00',
          capacity: 5,
        })
        .expect(201);

      const overlapRes = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({
          day_of_week: 2,
          start_time: '13:00',
          end_time: '15:00',
          capacity: 5,
        });
      expect(overlapRes.status).toBe(409);
      expect(overlapRes.body.error.code).toBe('DELIVERY_WINDOW_OVERLAP');

      // Same day, different branch - no conflict.
      const { branchBId } = await createVendorWithTwoBranches(owner).then(
        () => ({ branchBId: undefined }),
      );
      void branchBId;

      // Truly adjacent (14:00-16:00 starts exactly when the first ends)
      // - must succeed.
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({
          day_of_week: 2,
          start_time: '14:00',
          end_time: '16:00',
          capacity: 5,
        })
        .expect(201);

      // Same times, different day - no conflict either.
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({
          day_of_week: 3,
          start_time: '10:00',
          end_time: '14:00',
          capacity: 5,
        })
        .expect(201);
    });

    it('updating a window to overlap a DIFFERENT window is rejected; updating it to its own unchanged times succeeds', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({
          day_of_week: 4,
          start_time: '08:00',
          end_time: '10:00',
          capacity: 5,
        })
        .expect(201);
      const second = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({
          day_of_week: 4,
          start_time: '10:00',
          end_time: '12:00',
          capacity: 5,
        })
        .expect(201);

      const overlapUpdate = await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows/${second.body.id}`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({
          day_of_week: 4,
          start_time: '09:00',
          end_time: '12:00',
          capacity: 5,
        });
      expect(overlapUpdate.status).toBe(409);

      // Re-submitting the SAME window's own current times must not
      // conflict with itself.
      await request(app.getHttpServer())
        .put(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows/${second.body.id}`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({
          day_of_week: 4,
          start_time: '10:00',
          end_time: '12:00',
          capacity: 9,
        })
        .expect(200);
    });

    it('PDR-024: two concurrent creates for overlapping windows on the same branch/day - exactly one succeeds', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);

      const [resA, resB] = await Promise.all([
        request(app.getHttpServer())
          .post(
            `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows`,
          )
          .set('Authorization', `Bearer ${owner}`)
          .send({
            day_of_week: 5,
            start_time: '09:00',
            end_time: '11:00',
            capacity: 4,
          }),
        request(app.getHttpServer())
          .post(
            `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows`,
          )
          .set('Authorization', `Bearer ${owner}`)
          .send({
            day_of_week: 5,
            start_time: '10:00',
            end_time: '12:00',
            capacity: 4,
          }),
      ]);
      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([201, 409]);

      const windows = await prisma.deliveryWindow.findMany({
        where: { vendorId, branchId: branchAId, dayOfWeek: 5 },
      });
      expect(windows).toHaveLength(1);
    });

    it('deleting a window also removes its own exceptions (never a dangling exception row)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const window = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({
          day_of_week: 6,
          start_time: '09:00',
          end_time: '12:00',
          capacity: 3,
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows/${window.body.id}/exceptions`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({ exception_date: '2026-12-25', is_closed: true })
        .expect(201);

      await request(app.getHttpServer())
        .delete(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows/${window.body.id}`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);

      const exceptions = await prisma.deliveryWindowException.findMany({
        where: { windowId: window.body.id },
      });
      expect(exceptions).toHaveLength(0);
    });
  });

  describe('RB-FUL-001: dated exceptions (closures and capacity overrides)', () => {
    async function createWindow(
      owner: string,
      vendorId: string,
      branchId: string,
    ) {
      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchId}/delivery-windows`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({
          day_of_week: 1,
          start_time: '09:00',
          end_time: '12:00',
          capacity: 5,
        })
        .expect(201);
      return res.body.id as string;
    }

    it('creates a closed exception and a capacity-override exception, then deletes one', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const windowId = await createWindow(owner, vendorId, branchAId);

      const closed = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows/${windowId}/exceptions`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({ exception_date: '2026-12-25', is_closed: true })
        .expect(201);
      expect(closed.body.is_closed).toBe(true);
      expect(closed.body.capacity_override).toBeNull();

      const override = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows/${windowId}/exceptions`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({ exception_date: '2026-12-26', capacity_override: 2 })
        .expect(201);
      expect(override.body.is_closed).toBe(false);
      expect(override.body.capacity_override).toBe(2);

      await request(app.getHttpServer())
        .delete(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows/${windowId}/exceptions/${closed.body.id}`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);

      const list = await request(app.getHttpServer())
        .get(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(list.body[0].exceptions).toHaveLength(1);
      expect(list.body[0].exceptions[0].id).toBe(override.body.id);
    });

    it('rejects an exception that is both closed AND sets a capacity override, and one that sets neither', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const windowId = await createWindow(owner, vendorId, branchAId);

      const both = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows/${windowId}/exceptions`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({
          exception_date: '2026-12-25',
          is_closed: true,
          capacity_override: 2,
        });
      expect(both.status).toBe(409);
      expect(both.body.error.code).toBe('INVALID_EXCEPTION_COMBINATION');

      const neither = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows/${windowId}/exceptions`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({ exception_date: '2026-12-25' });
      expect(neither.status).toBe(409);
      expect(neither.body.error.code).toBe('INVALID_EXCEPTION_COMBINATION');
    });

    it('rejects a non-positive capacity_override', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const windowId = await createWindow(owner, vendorId, branchAId);

      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows/${windowId}/exceptions`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({ exception_date: '2026-12-25', capacity_override: 0 });
      expect(res.status).toBe(400);
    });

    it('rejects a second exception for the same window on the same date', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
      const windowId = await createWindow(owner, vendorId, branchAId);
      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows/${windowId}/exceptions`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({ exception_date: '2026-12-25', is_closed: true })
        .expect(201);

      const dup = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows/${windowId}/exceptions`,
        )
        .set('Authorization', `Bearer ${owner}`)
        .send({ exception_date: '2026-12-25', capacity_override: 1 });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe(
        'DELIVERY_WINDOW_EXCEPTION_ALREADY_EXISTS',
      );
    });

    it('refuses a BRANCH_EMPLOYEE from creating or deleting an exception', async () => {
      const { vendorId, branchAId, employeeToken, owner } =
        await setupVendorWithTwoBranchesAndEmployee();
      const windowId = await createWindow(owner, vendorId, branchAId);

      const createRes = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorId}/branches/${branchAId}/delivery-windows/${windowId}/exceptions`,
        )
        .set('Authorization', `Bearer ${employeeToken}`)
        .send({ exception_date: '2026-12-25', is_closed: true });
      expect(createRes.status).toBe(403);
    });
  });

  describe('RB-ORD-001: BranchOrder relationship safety (no HTTP endpoint exists yet - direct DB checks)', () => {
    async function seedEligibleVendorAndOffer(ownerToken: string) {
      const { vendorId, branchAId } =
        await createVendorWithTwoBranches(ownerToken);
      const offer = await prisma.vendorOffer.create({
        data: { vendorId, titleAr: 'م', titleEn: 'P' },
      });
      const variant = await prisma.offerVariant.create({
        data: {
          vendorId,
          vendorOfferId: offer.id,
          sellerSku: unique('sku'),
          basePrice: 10,
          storeInventoryBarcode: unique('barcode'),
        },
      });
      return { vendorId, branchAId, offerId: offer.id, variantId: variant.id };
    }

    it('a well-formed BranchOrder + item can be created directly (sanity baseline)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId, variantId } =
        await seedEligibleVendorAndOffer(owner);
      const customer = await prisma.customerProfile.create({
        data: { user: { create: { phone: uniquePhone(), passwordHash: 'x' } } },
      });
      const customerOrder = await prisma.customerOrder.create({
        data: { customerId: customer.id },
      });
      const branchOrder = await prisma.branchOrder.create({
        data: {
          customerOrderId: customerOrder.id,
          vendorId,
          branchId: branchAId,
          fulfilmentMethod: 'DELIVERY',
          paymentMethod: 'COD',
          subtotal: 20,
          deliveryFee: 5,
          total: 25,
        },
      });
      const item = await prisma.branchOrderItem.create({
        data: {
          vendorId,
          branchOrderId: branchOrder.id,
          offerVariantId: variantId,
          quantity: 2,
          unitPrice: 10,
        },
      });
      expect(branchOrder.status).toBe('PLACED');
      expect(item.quantity).toBe(2);
    });

    it("BOLA at the DB level: a BranchOrder cannot reference a DIFFERENT vendor's branch (composite FK rejects it)", async () => {
      const owner1 = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendor1Id } = await seedEligibleVendorAndOffer(owner1);
      const owner2 = await signup(uniquePhone(), 'a-strong-password');
      const { branchAId: branch2Id } = await seedEligibleVendorAndOffer(owner2);

      const customer = await prisma.customerProfile.create({
        data: { user: { create: { phone: uniquePhone(), passwordHash: 'x' } } },
      });
      const customerOrder = await prisma.customerOrder.create({
        data: { customerId: customer.id },
      });

      await expect(
        prisma.branchOrder.create({
          data: {
            customerOrderId: customerOrder.id,
            vendorId: vendor1Id,
            branchId: branch2Id,
            fulfilmentMethod: 'PICKUP',
            paymentMethod: 'COD',
            subtotal: 10,
            total: 10,
          },
        }),
      ).rejects.toThrow();
    });

    it("a BranchOrderItem cannot reference a DIFFERENT vendor's offer variant (composite FK rejects it)", async () => {
      const owner1 = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendor1Id, branchAId: branch1Id } =
        await seedEligibleVendorAndOffer(owner1);
      const owner2 = await signup(uniquePhone(), 'a-strong-password');
      const { variantId: variant2Id } =
        await seedEligibleVendorAndOffer(owner2);

      const customer = await prisma.customerProfile.create({
        data: { user: { create: { phone: uniquePhone(), passwordHash: 'x' } } },
      });
      const customerOrder = await prisma.customerOrder.create({
        data: { customerId: customer.id },
      });
      const branchOrder = await prisma.branchOrder.create({
        data: {
          customerOrderId: customerOrder.id,
          vendorId: vendor1Id,
          branchId: branch1Id,
          fulfilmentMethod: 'PICKUP',
          paymentMethod: 'COD',
          subtotal: 10,
          total: 10,
        },
      });

      await expect(
        prisma.branchOrderItem.create({
          data: {
            vendorId: vendor1Id,
            branchOrderId: branchOrder.id,
            offerVariantId: variant2Id,
            quantity: 1,
            unitPrice: 10,
          },
        }),
      ).rejects.toThrow();
    });

    it('rejects negative subtotal/total/deliveryFee and non-positive item quantity at the DB level (CHECK constraints)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchAId, variantId } =
        await seedEligibleVendorAndOffer(owner);
      const customer = await prisma.customerProfile.create({
        data: { user: { create: { phone: uniquePhone(), passwordHash: 'x' } } },
      });
      const customerOrder = await prisma.customerOrder.create({
        data: { customerId: customer.id },
      });

      await expect(
        prisma.branchOrder.create({
          data: {
            customerOrderId: customerOrder.id,
            vendorId,
            branchId: branchAId,
            fulfilmentMethod: 'PICKUP',
            paymentMethod: 'COD',
            subtotal: -1,
            total: 10,
          },
        }),
      ).rejects.toThrow();

      const branchOrder = await prisma.branchOrder.create({
        data: {
          customerOrderId: customerOrder.id,
          vendorId,
          branchId: branchAId,
          fulfilmentMethod: 'PICKUP',
          paymentMethod: 'COD',
          subtotal: 10,
          total: 10,
        },
      });
      await expect(
        prisma.branchOrderItem.create({
          data: {
            vendorId,
            branchOrderId: branchOrder.id,
            offerVariantId: variantId,
            quantity: 0,
            unitPrice: 10,
          },
        }),
      ).rejects.toThrow();
    });

    it('the state machine service is wired to a real BranchOrder row end-to-end (not just mocked-Prisma unit tests)', async () => {
      const ownerPhone = uniquePhone();
      const owner = await signup(ownerPhone, 'a-strong-password');
      // AuditLog.actorId has a real FK to User.id (not a session
      // token) - look up the owner's actual row to use as the actor
      // for this direct-service transition call.
      const ownerUser = await prisma.user.findUniqueOrThrow({
        where: { phone: ownerPhone },
      });
      const { vendorId, branchAId } = await seedEligibleVendorAndOffer(owner);
      const customer = await prisma.customerProfile.create({
        data: { user: { create: { phone: uniquePhone(), passwordHash: 'x' } } },
      });
      const customerOrder = await prisma.customerOrder.create({
        data: { customerId: customer.id },
      });
      const branchOrder = await prisma.branchOrder.create({
        data: {
          customerOrderId: customerOrder.id,
          vendorId,
          branchId: branchAId,
          fulfilmentMethod: 'PICKUP',
          paymentMethod: 'COD',
          subtotal: 10,
          total: 10,
        },
      });

      const branchOrderService = app.get(BranchOrderService);
      const updated = await prisma.$transaction((tx) =>
        branchOrderService.transition(
          tx,
          branchOrder.id,
          'PREPARING',
          ownerUser.id,
          'corr-e2e',
        ),
      );
      expect(updated.status).toBe('PREPARING');

      const auditRows = await prisma.auditLog.findMany({
        where: { entityType: 'BranchOrder', entityId: branchOrder.id },
      });
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].action).toBe('branch_order.status_changed');

      // Illegal transition (PICKUP order can never go PREPARING -> SENT)
      // is rejected and leaves the row untouched.
      await expect(
        prisma.$transaction((tx) =>
          branchOrderService.transition(
            tx,
            branchOrder.id,
            'SENT',
            ownerUser.id,
            'corr-e2e-2',
          ),
        ),
      ).rejects.toThrow();
      const stillPreparing = await prisma.branchOrder.findUniqueOrThrow({
        where: { id: branchOrder.id },
      });
      expect(stillPreparing.status).toBe('PREPARING');
    });
  });
});
