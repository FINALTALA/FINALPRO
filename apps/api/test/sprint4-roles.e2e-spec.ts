import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SmsService } from './../src/auth/sms.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';

/** Test double for the OPEN-004 SMS fallback - captures codes instead of logging them. */
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

  countFor(phone: string): number {
    return this.sent.filter((s) => s.phone === phone).length;
  }
}

// Palestinian mobile numbers validate (via class-validator's
// IsPhoneNumber -> libphonenumber-js/max, the strict metadata bundle
// it actually uses) only under the 056/059 prefixes - 057/058 parse
// but are not valid PS mobile numbers under that bundle, found the
// hard way when this file's first draft used +97057 and every OTP
// request came back 400. Reuses "56" (same as sprint3-catalog's own
// uniquePhone()) with a distinct numeric offset, not a distinct
// prefix, to avoid collisions between the two files' generated numbers.
let phoneSeq = (Date.now() % 1_000_000) + 700_000;
function uniquePhone(): string {
  phoneSeq += 1;
  return `+97056${(phoneSeq % 10_000_000).toString().padStart(7, '0')}`;
}
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

describe('Sprint 4 - roles, staff invites, workspace switcher (e2e)', () => {
  let app: INestApplication;
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
    await app.close();
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

  async function createVendorWithBranch(
    ownerToken: string,
  ): Promise<{ vendorId: string; branchId: string }> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('vendor-apply'))
      .send({
        legal_name: unique('Vendor'),
        branches: [{ name: 'Main branch', is_physical: true }],
        applicable_categories: ['WOMEN'],
      })
      .expect(201);
    return { vendorId: res.body.id, branchId: res.body.branches[0].id };
  }

  /** Owner invites `phone` to `branchId`, requests + verifies the OTP,
   * and accepts - returns the invitee's session and the raw accept body. */
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
      .send({
        phone,
        verification_token: verify.body.session_token,
        password,
      })
      .expect(200);
    return accept.body;
  }

  describe('RB-ROLE-002: staff invite (invite -> OTP -> accept)', () => {
    it('lets an owner invite a brand-new phone number, which becomes a BRANCH_EMPLOYEE scoped to exactly that branch', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const employeePhone = uniquePhone();

      const accepted = await inviteAndAcceptAsNewUser(
        owner,
        vendorId,
        branchId,
        employeePhone,
        'employee-password',
      );
      expect(accepted.vendor_id).toBe(vendorId);
      expect(accepted.branch_id).toBe(branchId);
      expect(accepted.role).toBe('BRANCH_EMPLOYEE');
      expect(typeof accepted.session_token).toBe('string');

      const membership = await prisma.vendorUser.findFirst({
        where: { vendorId, user: { phone: employeePhone } },
      });
      expect(membership?.role).toBe('BRANCH_EMPLOYEE');
      expect(membership?.branchId).toBe(branchId);

      // The invitee also got a full customer identity (PDR-008: one
      // account may be a customer and also hold a vendor role).
      const employeeUser = await prisma.user.findUnique({
        where: { phone: employeePhone },
        include: { customerProfile: true },
      });
      expect(employeeUser?.customerProfile).not.toBeNull();
    });

    it('links an EXISTING account to the branch instead of creating a duplicate user, and keeps that account usable as a customer', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);

      const existingPhone = uniquePhone();
      await signup(existingPhone, 'already-a-customer-password');

      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchId}/staff-invites`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('invite'))
        .send({ phone: existingPhone })
        .expect(201);

      await request(app.getHttpServer())
        .post('/api/v1/auth/otp/request')
        .send({ phone: existingPhone, purpose: 'staff_invite' })
        .expect(202);
      const code = fakeSms.lastCodeFor(existingPhone);
      const verify = await request(app.getHttpServer())
        .post('/api/v1/auth/otp/verify')
        .set('Idempotency-Key', unique('verify'))
        .send({ phone: existingPhone, otp_code: code, purpose: 'staff_invite' })
        .expect(200);

      // No password needed - this account already has one.
      const accept = await request(app.getHttpServer())
        .post('/api/v1/auth/staff-invites/accept')
        .set('Idempotency-Key', unique('accept'))
        .send({
          phone: existingPhone,
          verification_token: verify.body.session_token,
        })
        .expect(200);
      expect(accept.body.role).toBe('BRANCH_EMPLOYEE');

      const users = await prisma.user.findMany({
        where: { phone: existingPhone },
      });
      expect(users).toHaveLength(1);
    });

    it("refuses to issue a staff_invite OTP for a phone with no genuine pending invite (anti-abuse, mirrors PASSWORD_RESET's anti-enumeration gate)", async () => {
      const randomPhone = uniquePhone();
      await request(app.getHttpServer())
        .post('/api/v1/auth/otp/request')
        .send({ phone: randomPhone, purpose: 'staff_invite' })
        .expect(202);
      expect(fakeSms.countFor(randomPhone)).toBe(0);
    });

    it('refuses to accept an already-accepted invite a second time', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const employeePhone = uniquePhone();
      await inviteAndAcceptAsNewUser(
        owner,
        vendorId,
        branchId,
        employeePhone,
        'employee-password',
      );

      // Two legitimate sends already happened by this point: one
      // automatic on invite creation (VendorsController.inviteStaff()),
      // one from this helper's own explicit re-request while the
      // invite was still pending.
      const sentBeforeAcceptance = fakeSms.countFor(employeePhone);
      expect(sentBeforeAcceptance).toBe(2);

      // A further OTP request now correctly finds no PENDING invite
      // left (it's ACCEPTED) and must not send a third code.
      await request(app.getHttpServer())
        .post('/api/v1/auth/otp/request')
        .send({ phone: employeePhone, purpose: 'staff_invite' })
        .expect(202);
      expect(fakeSms.countFor(employeePhone)).toBe(sentBeforeAcceptance);
    });

    it('requires a password only when the invited phone has no existing account', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const newPhone = uniquePhone();

      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchId}/staff-invites`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('invite'))
        .send({ phone: newPhone })
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/auth/otp/request')
        .send({ phone: newPhone, purpose: 'staff_invite' })
        .expect(202);
      const code = fakeSms.lastCodeFor(newPhone);
      const verify = await request(app.getHttpServer())
        .post('/api/v1/auth/otp/verify')
        .set('Idempotency-Key', unique('verify'))
        .send({ phone: newPhone, otp_code: code, purpose: 'staff_invite' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/staff-invites/accept')
        .set('Idempotency-Key', unique('accept'))
        .send({
          phone: newPhone,
          verification_token: verify.body.session_token,
        })
        .expect(400);
      expect(res.body.error.code).toBe('PASSWORD_REQUIRED');
    });
  });

  describe('Review-round fix: cross-vendor branch integrity and conflicting pending invites', () => {
    it('rejects a direct write linking a VendorUser to a branch belonging to a DIFFERENT vendor (composite FK, not just a plain existence check)', async () => {
      const ownerA = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorAId } = await createVendorWithBranch(ownerA);
      const ownerB = await signup(uniquePhone(), 'a-strong-password');
      const { branchId: branchBId } = await createVendorWithBranch(ownerB);
      const rogueUser = await prisma.user.create({
        data: { phone: uniquePhone(), passwordHash: 'x' },
      });

      await expect(
        prisma.vendorUser.create({
          data: {
            userId: rogueUser.id,
            vendorId: vendorAId,
            role: 'BRANCH_EMPLOYEE',
            branchId: branchBId,
          },
        }),
      ).rejects.toThrow();
    });

    it('rejects a direct write linking a StaffInvite to a branch belonging to a DIFFERENT vendor (composite FK)', async () => {
      const ownerA = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorAId } = await createVendorWithBranch(ownerA);
      const ownerB = await signup(uniquePhone(), 'a-strong-password');
      const { branchId: branchBId } = await createVendorWithBranch(ownerB);
      const someUser = await prisma.user.create({
        data: { phone: uniquePhone(), passwordHash: 'x' },
      });

      await expect(
        prisma.staffInvite.create({
          data: {
            vendorId: vendorAId,
            branchId: branchBId,
            phone: uniquePhone(),
            invitedById: someUser.id,
            expiresAt: new Date(Date.now() + 1000 * 60 * 60),
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses a second pending invite for the same phone in the same vendor even when it targets a DIFFERENT branch - acceptance must never be ambiguous about which branch wins', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const applyRes = await request(app.getHttpServer())
        .post('/api/v1/vendors')
        .set('Authorization', `Bearer ${owner}`)
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
      const vendorId = applyRes.body.id;
      const branchAId = applyRes.body.branches[0].id;
      const branchBId = applyRes.body.branches[1].id;
      const targetPhone = uniquePhone();

      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchAId}/staff-invites`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('invite-a'))
        .send({ phone: targetPhone })
        .expect(201);

      const second = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchBId}/staff-invites`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('invite-b'))
        .send({ phone: targetPhone })
        .expect(409);
      expect(second.body.error.code).toBe('STAFF_INVITE_ALREADY_PENDING');

      const pendingInvites = await prisma.staffInvite.findMany({
        where: { vendorId, phone: targetPhone, status: 'PENDING' },
      });
      expect(pendingInvites).toHaveLength(1);
      expect(pendingInvites[0].branchId).toBe(branchAId);
    });

    it('refuses a second pending invite for the same phone from a DIFFERENT vendor too - review round 4: PENDING-invite uniqueness is global, not per-vendor, since accept() has no invite_id to disambiguate between candidates', async () => {
      const ownerA = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorAId, branchId: branchAId } =
        await createVendorWithBranch(ownerA);
      const ownerB = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorBId, branchId: branchBId } =
        await createVendorWithBranch(ownerB);
      const sharedPhone = uniquePhone();

      await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorAId}/branches/${branchAId}/staff-invites`,
        )
        .set('Authorization', `Bearer ${ownerA}`)
        .set('Idempotency-Key', unique('invite-a'))
        .send({ phone: sharedPhone })
        .expect(201);

      const second = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorBId}/branches/${branchBId}/staff-invites`,
        )
        .set('Authorization', `Bearer ${ownerB}`)
        .set('Idempotency-Key', unique('invite-b'))
        .send({ phone: sharedPhone })
        .expect(409);
      expect(second.body.error.code).toBe('STAFF_INVITE_ALREADY_PENDING');

      const pendingInvites = await prisma.staffInvite.findMany({
        where: { phone: sharedPhone, status: 'PENDING' },
      });
      expect(pendingInvites).toHaveLength(1);
      expect(pendingInvites[0].vendorId).toBe(vendorAId);
    });

    it('under two concurrent invite requests for the same phone in the same vendor targeting two different branches, exactly one succeeds and exactly one PENDING row survives', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const applyRes = await request(app.getHttpServer())
        .post('/api/v1/vendors')
        .set('Authorization', `Bearer ${owner}`)
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
      const vendorId = applyRes.body.id;
      const branchAId = applyRes.body.branches[0].id;
      const branchBId = applyRes.body.branches[1].id;
      const targetPhone = uniquePhone();

      const [resA, resB] = await Promise.all([
        request(app.getHttpServer())
          .post(
            `/api/v1/vendors/${vendorId}/branches/${branchAId}/staff-invites`,
          )
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', unique('invite-race-a'))
          .send({ phone: targetPhone }),
        request(app.getHttpServer())
          .post(
            `/api/v1/vendors/${vendorId}/branches/${branchBId}/staff-invites`,
          )
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', unique('invite-race-b'))
          .send({ phone: targetPhone }),
      ]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([201, 409]);

      const pendingInvites = await prisma.staffInvite.findMany({
        where: { vendorId, phone: targetPhone, status: 'PENDING' },
      });
      expect(pendingInvites).toHaveLength(1);
    });

    it('refuses a brand-new invite to a phone that already became a member of this same vendor through an earlier accepted invite - ALREADY_VENDOR_MEMBER, not the partial index, is what enforces this', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const employeePhone = uniquePhone();
      await inviteAndAcceptAsNewUser(
        owner,
        vendorId,
        branchId,
        employeePhone,
        'employee-password',
      );

      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchId}/staff-invites`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('invite-after-accept'))
        .send({ phone: employeePhone })
        .expect(403);
      expect(res.body.error.code).toBe('ALREADY_VENDOR_MEMBER');

      const pendingInvites = await prisma.staffInvite.findMany({
        where: { vendorId, phone: employeePhone, status: 'PENDING' },
      });
      expect(pendingInvites).toHaveLength(0);
    });

    it('under a real race between accepting an OLDER pending invite and the owner creating a NEW invite for the same phone/vendor (different branch), exactly one VendorUser ends up existing, the original invite is ACCEPTED, and no dangling PENDING invite survives', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const applyRes = await request(app.getHttpServer())
        .post('/api/v1/vendors')
        .set('Authorization', `Bearer ${owner}`)
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
      const vendorId = applyRes.body.id;
      const branchAId = applyRes.body.branches[0].id;
      const branchBId = applyRes.body.branches[1].id;
      const targetPhone = uniquePhone();

      // The invite being accepted - created and OTP-verified up front,
      // so the accept() call below only has to do its own transactional
      // work when the race actually fires, matching the real-world
      // shape of the bug (an invitee finishing acceptance while the
      // owner, unaware, tries to invite them again to a second branch).
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchAId}/staff-invites`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('invite-original'))
        .send({ phone: targetPhone })
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/auth/otp/request')
        .send({ phone: targetPhone, purpose: 'staff_invite' })
        .expect(202);
      const code = fakeSms.lastCodeFor(targetPhone);
      const verify = await request(app.getHttpServer())
        .post('/api/v1/auth/otp/verify')
        .set('Idempotency-Key', unique('verify'))
        .send({ phone: targetPhone, otp_code: code, purpose: 'staff_invite' })
        .expect(200);

      const [acceptRes, newInviteRes] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/auth/staff-invites/accept')
          .set('Idempotency-Key', unique('accept-race'))
          .send({
            phone: targetPhone,
            verification_token: verify.body.session_token,
            password: 'employee-password',
          }),
        request(app.getHttpServer())
          .post(
            `/api/v1/vendors/${vendorId}/branches/${branchBId}/staff-invites`,
          )
          .set('Authorization', `Bearer ${owner}`)
          .set('Idempotency-Key', unique('invite-race-new'))
          .send({ phone: targetPhone }),
      ]);

      // Whichever transaction wins the vendor-row lock first, the
      // outcome is deterministic: acceptance always succeeds (the
      // invite it targets was genuinely still valid at request time),
      // and the concurrent new-invite attempt always loses - because it
      // now sees the phone as an existing member of this same vendor
      // (ALREADY_VENDOR_MEMBER) or as a BRANCH_EMPLOYEE somewhere at
      // all (EMPLOYEE_ALREADY_ASSIGNED, round 4's global check - which
      // of these two non-transactional pre-checks happens to observe
      // accept()'s commit first is itself racy, but either is a
      // correct, safe rejection) if accept() committed first, or
      // because it still sees the original invite as PENDING
      // (STAFF_INVITE_ALREADY_PENDING, if it acquired the lock first
      // and correctly refused to create a second pending row) - all
      // three are safe, none ever creates the dangling invite the bug
      // report described.
      expect(acceptRes.status).toBe(200);
      // ALREADY_VENDOR_MEMBER/EMPLOYEE_ALREADY_ASSIGNED are 403
      // (ForbiddenException); STAFF_INVITE_ALREADY_PENDING is 409
      // (ConflictException) - which one fires depends on which
      // transaction wins the lock race, so this asserts the code, not
      // a single fixed status.
      expect([403, 409]).toContain(newInviteRes.status);
      expect([
        'ALREADY_VENDOR_MEMBER',
        'EMPLOYEE_ALREADY_ASSIGNED',
        'STAFF_INVITE_ALREADY_PENDING',
      ]).toContain(newInviteRes.body.error.code);

      const vendorUsers = await prisma.vendorUser.findMany({
        where: { vendorId, user: { phone: targetPhone } },
      });
      expect(vendorUsers).toHaveLength(1);
      expect(vendorUsers[0].branchId).toBe(branchAId);

      const originalInvite = await prisma.staffInvite.findFirst({
        where: { vendorId, branchId: branchAId, phone: targetPhone },
      });
      expect(originalInvite?.status).toBe('ACCEPTED');

      const pendingInvites = await prisma.staffInvite.findMany({
        where: { vendorId, phone: targetPhone, status: 'PENDING' },
      });
      expect(pendingInvites).toHaveLength(0);
    });
  });

  describe('Review-round fix (round 4): a BRANCH_EMPLOYEE is assigned to one branch at a time, across every vendor (PDR-008, SRS Part 3 G.0)', () => {
    it('rejects a direct write making the same User a BRANCH_EMPLOYEE at a SECOND vendor while still assigned at the first (global partial unique index)', async () => {
      const ownerA = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorAId, branchId: branchAId } =
        await createVendorWithBranch(ownerA);
      const ownerB = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorBId, branchId: branchBId } =
        await createVendorWithBranch(ownerB);

      const employeeUser = await prisma.user.create({
        data: { phone: uniquePhone(), passwordHash: 'x' },
      });
      await prisma.vendorUser.create({
        data: {
          userId: employeeUser.id,
          vendorId: vendorAId,
          role: 'BRANCH_EMPLOYEE',
          branchId: branchAId,
        },
      });

      await expect(
        prisma.vendorUser.create({
          data: {
            userId: employeeUser.id,
            vendorId: vendorBId,
            role: 'BRANCH_EMPLOYEE',
            branchId: branchBId,
          },
        }),
      ).rejects.toThrow();
    });

    it('still allows the same account to OWN multiple vendors - the global uniqueness only applies to the BRANCH_EMPLOYEE role', async () => {
      const ownerPhone = uniquePhone();
      const owner = await signup(ownerPhone, 'a-strong-password');
      const first = await createVendorWithBranch(owner);
      const second = await createVendorWithBranch(owner);
      expect(second.vendorId).not.toBe(first.vendorId);

      const ownerships = await prisma.vendorUser.findMany({
        where: { user: { phone: ownerPhone } },
      });
      expect(ownerships).toHaveLength(2);
      expect(ownerships.every((m) => m.role === 'OWNER')).toBe(true);
      expect(ownerships.map((m) => m.vendorId).sort()).toEqual(
        [first.vendorId, second.vendorId].sort(),
      );
    });

    it('refuses to invite a phone that is already a BRANCH_EMPLOYEE at a different vendor - EMPLOYEE_ALREADY_ASSIGNED, distinct from ALREADY_VENDOR_MEMBER', async () => {
      const ownerA = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorAId, branchId: branchAId } =
        await createVendorWithBranch(ownerA);
      const ownerB = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorBId, branchId: branchBId } =
        await createVendorWithBranch(ownerB);
      const employeePhone = uniquePhone();
      await inviteAndAcceptAsNewUser(
        ownerA,
        vendorAId,
        branchAId,
        employeePhone,
        'employee-password',
      );

      const res = await request(app.getHttpServer())
        .post(
          `/api/v1/vendors/${vendorBId}/branches/${branchBId}/staff-invites`,
        )
        .set('Authorization', `Bearer ${ownerB}`)
        .set('Idempotency-Key', unique('invite-cross-vendor'))
        .send({ phone: employeePhone })
        .expect(403);
      expect(res.body.error.code).toBe('EMPLOYEE_ALREADY_ASSIGNED');

      const pendingInvites = await prisma.staffInvite.findMany({
        where: { phone: employeePhone, status: 'PENDING' },
      });
      expect(pendingInvites).toHaveLength(0);
    });

    it('refuses to ACCEPT an invite for a phone that became a BRANCH_EMPLOYEE elsewhere in the meantime, even if that invite is still genuinely PENDING', async () => {
      // Builds the exact edge case the fresh in-transaction check (not
      // just the DB constraint) exists for: an invite that was valid
      // when created, but whose invitee accepted a *different* vendor's
      // invite first. Constructed directly since the global pending-
      // invite index (this same round's other fix) makes two genuinely
      // concurrent PENDING invites for one phone impossible to reach
      // through the API - this proves the accept-time re-check is what
      // actually protects the case where an old invite from *before*
      // that index existed (or before it applied) is accepted late.
      const ownerA = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorAId, branchId: branchAId } =
        await createVendorWithBranch(ownerA);
      const ownerB = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorBId, branchId: branchBId } =
        await createVendorWithBranch(ownerB);
      const targetPhone = uniquePhone();

      await inviteAndAcceptAsNewUser(
        ownerA,
        vendorAId,
        branchAId,
        targetPhone,
        'employee-password',
      );

      // A stale invite to vendor B, inserted directly (bypassing the
      // now-global pending-uniqueness index, which the API itself
      // would correctly have refused to let coexist with vendor A's
      // pending invite before it was accepted).
      const staleInvite = await prisma.staffInvite.create({
        data: {
          vendorId: vendorBId,
          branchId: branchBId,
          phone: targetPhone,
          invitedById: (
            await prisma.vendorUser.findFirstOrThrow({
              where: { vendorId: vendorBId, role: 'OWNER' },
            })
          ).userId,
          expiresAt: new Date(Date.now() + 1000 * 60 * 60),
        },
      });

      await request(app.getHttpServer())
        .post('/api/v1/auth/otp/request')
        .send({ phone: targetPhone, purpose: 'staff_invite' })
        .expect(202);
      const code = fakeSms.lastCodeFor(targetPhone);
      const verify = await request(app.getHttpServer())
        .post('/api/v1/auth/otp/verify')
        .set('Idempotency-Key', unique('verify'))
        .send({ phone: targetPhone, otp_code: code, purpose: 'staff_invite' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/staff-invites/accept')
        .set('Idempotency-Key', unique('accept-stale'))
        .send({
          phone: targetPhone,
          verification_token: verify.body.session_token,
        })
        .expect(403);
      expect(res.body.error.code).toBe('EMPLOYEE_ALREADY_ASSIGNED');

      const vendorUsers = await prisma.vendorUser.findMany({
        where: { user: { phone: targetPhone }, role: 'BRANCH_EMPLOYEE' },
      });
      expect(vendorUsers).toHaveLength(1);
      expect(vendorUsers[0].vendorId).toBe(vendorAId);

      const refreshedStaleInvite = await prisma.staffInvite.findUniqueOrThrow({
        where: { id: staleInvite.id },
      });
      expect(refreshedStaleInvite.status).toBe('PENDING');
    });

    it('under two concurrent invite requests for the same phone from two DIFFERENT vendors, exactly one succeeds and exactly one PENDING invite survives globally', async () => {
      const ownerA = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorAId, branchId: branchAId } =
        await createVendorWithBranch(ownerA);
      const ownerB = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorBId, branchId: branchBId } =
        await createVendorWithBranch(ownerB);
      const targetPhone = uniquePhone();

      const [resA, resB] = await Promise.all([
        request(app.getHttpServer())
          .post(
            `/api/v1/vendors/${vendorAId}/branches/${branchAId}/staff-invites`,
          )
          .set('Authorization', `Bearer ${ownerA}`)
          .set('Idempotency-Key', unique('invite-cross-race-a'))
          .send({ phone: targetPhone }),
        request(app.getHttpServer())
          .post(
            `/api/v1/vendors/${vendorBId}/branches/${branchBId}/staff-invites`,
          )
          .set('Authorization', `Bearer ${ownerB}`)
          .set('Idempotency-Key', unique('invite-cross-race-b'))
          .send({ phone: targetPhone }),
      ]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([201, 409]);

      const pendingInvites = await prisma.staffInvite.findMany({
        where: { phone: targetPhone, status: 'PENDING' },
      });
      expect(pendingInvites).toHaveLength(1);
    });
  });

  describe('RB-ROLE-004: least-privilege authorization (BOLA and cross-branch access)', () => {
    async function setupVendorWithTwoBranchesAndEmployee() {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const applyRes = await request(app.getHttpServer())
        .post('/api/v1/vendors')
        .set('Authorization', `Bearer ${owner}`)
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
      const vendorId = applyRes.body.id;
      const branchAId = applyRes.body.branches[0].id;
      const branchBId = applyRes.body.branches[1].id;

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

    it('lets an owner see and manage every branch under their own vendor', async () => {
      const { owner, vendorId, branchAId, branchBId } =
        await setupVendorWithTwoBranchesAndEmployee();

      const list = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/branches`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(list.body.map((b: { id: string }) => b.id).sort()).toEqual(
        [branchAId, branchBId].sort(),
      );

      await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/branches/${branchBId}`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
    });

    it("scopes an employee's branch list to only their own assigned branch, never a sibling branch of the same vendor", async () => {
      const { vendorId, branchAId, employeeToken } =
        await setupVendorWithTwoBranchesAndEmployee();

      const list = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/branches`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0].id).toBe(branchAId);
    });

    it("refuses an employee's attempt to read another branch of the SAME vendor they are not assigned to (BOLA)", async () => {
      const { vendorId, branchBId, employeeToken } =
        await setupVendorWithTwoBranchesAndEmployee();

      const res = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/branches/${branchBId}`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(403);
      expect(res.body.error.code).toBe('BRANCH_ACCESS_DENIED');
    });

    it('lets an employee read their own assigned branch', async () => {
      const { vendorId, branchAId, employeeToken } =
        await setupVendorWithTwoBranchesAndEmployee();

      const res = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/branches/${branchAId}`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(200);
      expect(res.body.id).toBe(branchAId);
    });

    it('refuses an employee from inviting other staff - store staffing is owner-only (PDR-009)', async () => {
      const { vendorId, branchAId, employeeToken } =
        await setupVendorWithTwoBranchesAndEmployee();

      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchAId}/staff-invites`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .set('Idempotency-Key', unique('invite'))
        .send({ phone: uniquePhone() })
        .expect(403);
      expect(res.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');
    });

    it("refuses a completely unrelated authenticated user (not a member of this vendor at all) - never leaks that the vendor's own branches even exist beyond the standard membership check (BOLA)", async () => {
      const { vendorId, branchAId } =
        await setupVendorWithTwoBranchesAndEmployee();
      const outsider = await signup(uniquePhone(), 'outsider-password');

      const res = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/branches/${branchAId}`)
        .set('Authorization', `Bearer ${outsider}`)
        .expect(403);
      expect(res.body.error.code).toBe('NOT_VENDOR_MEMBER');
    });

    it('refuses an employee of a DIFFERENT vendor entirely (cross-tenant BOLA) - membership is vendor-specific, never inferred from having any BRANCH_EMPLOYEE role somewhere', async () => {
      const { vendorId, branchAId } =
        await setupVendorWithTwoBranchesAndEmployee();
      const otherSetup = await setupVendorWithTwoBranchesAndEmployee();

      const res = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/branches/${branchAId}`)
        .set('Authorization', `Bearer ${otherSetup.employeeToken}`)
        .expect(403);
      expect(res.body.error.code).toBe('NOT_VENDOR_MEMBER');
    });

    it('rejects a direct attempt to create a VendorUser row that violates the role/branch invariant, at the database layer', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithBranch(owner);
      const rogueUser = await prisma.user.create({
        data: {
          phone: uniquePhone(),
          passwordHash: 'x',
        },
      });

      await expect(
        prisma.vendorUser.create({
          data: {
            userId: rogueUser.id,
            vendorId,
            role: 'BRANCH_EMPLOYEE',
            branchId: null,
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe('RB-ROLE-005: workspace switcher foundation', () => {
    it('lists an implicit customer workspace for a plain user, plus one entry per vendor membership with the correct role/branch', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const before = await request(app.getHttpServer())
        .get('/api/v1/me/workspaces')
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(before.body.workspaces).toEqual([{ type: 'customer' }]);

      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const after = await request(app.getHttpServer())
        .get('/api/v1/me/workspaces')
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(after.body.workspaces).toEqual([
        { type: 'customer' },
        expect.objectContaining({
          type: 'vendor',
          vendor_id: vendorId,
          role: 'OWNER',
          branch_id: null,
        }),
      ]);

      const employeePhone = uniquePhone();
      const accepted = await inviteAndAcceptAsNewUser(
        owner,
        vendorId,
        branchId,
        employeePhone,
        'employee-password',
      );
      const employeeWorkspaces = await request(app.getHttpServer())
        .get('/api/v1/me/workspaces')
        .set('Authorization', `Bearer ${accepted.session_token}`)
        .expect(200);
      expect(employeeWorkspaces.body.workspaces).toEqual([
        { type: 'customer' },
        expect.objectContaining({
          type: 'vendor',
          vendor_id: vendorId,
          role: 'BRANCH_EMPLOYEE',
          branch_id: branchId,
          branch_name: 'Main branch',
        }),
      ]);
    });
  });

  // Sprint 5 (RB-ROLE-006): completes the RB-ROLE-004 regression suite
  // above. This block's first two tests cover a real gap found while
  // writing it - VendorOffersController's every route used to be
  // guarded by a private requireOwner() that only checked *membership*
  // (any role), not role - a BRANCH_EMPLOYEE could reach catalog/price
  // writes, a direct PDR-009 violation. Fixed alongside these tests by
  // switching that controller to the same VendorMembershipGuard/
  // @RequireVendorRole('OWNER') pattern already proven here.
  describe('RB-ROLE-006: regression tests completing employee/owner permission coverage', () => {
    it("refuses a BRANCH_EMPLOYEE from listing a vendor's offers - catalog is owner-only (PDR-009), not just price-editing", async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const employeePhone = uniquePhone();
      const accepted = await inviteAndAcceptAsNewUser(
        owner,
        vendorId,
        branchId,
        employeePhone,
        'employee-password',
      );

      const res = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/offers`)
        .set('Authorization', `Bearer ${accepted.session_token}`)
        .expect(403);
      expect(res.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');
    });

    it('refuses a BRANCH_EMPLOYEE from creating a vendor offer (price/catalog write) - the exact PDR-009 violation this round found and fixed', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const employeePhone = uniquePhone();
      const accepted = await inviteAndAcceptAsNewUser(
        owner,
        vendorId,
        branchId,
        employeePhone,
        'employee-password',
      );

      // The guard runs before the handler body, so this is rejected
      // before the (unrelated) subscription-active gate is ever
      // reached - no need to activate a subscription for this test.
      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/offers`)
        .set('Authorization', `Bearer ${accepted.session_token}`)
        .set('Idempotency-Key', unique('offer-as-employee'))
        .send({ title_ar: 'منتج', title_en: 'Product' })
        .expect(403);
      expect(res.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');

      const offers = await prisma.vendorOffer.findMany({ where: { vendorId } });
      expect(offers).toHaveLength(0);
    });

    it('still lets the OWNER list their own (empty) offers - the fix must not also lock out legitimate owner access', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithBranch(owner);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/offers`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(res.body).toEqual([]);
    });

    it("refuses a BRANCH_EMPLOYEE of vendor A from reading vendor B's offers at all (cross-tenant BOLA, not just cross-role)", async () => {
      const ownerA = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorAId, branchId: branchAId } =
        await createVendorWithBranch(ownerA);
      const employeePhone = uniquePhone();
      const accepted = await inviteAndAcceptAsNewUser(
        ownerA,
        vendorAId,
        branchAId,
        employeePhone,
        'employee-password',
      );

      const ownerB = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorBId } = await createVendorWithBranch(ownerB);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorBId}/offers`)
        .set('Authorization', `Bearer ${accepted.session_token}`)
        .expect(403);
      expect(res.body.error.code).toBe('NOT_VENDOR_MEMBER');
    });

    // SubscriptionsController had the exact same requireOwner()-only-
    // checks-membership bug as VendorOffersController above - found and
    // fixed alongside it (subscription is explicitly on PDR-009's
    // owner-only list too).
    it('refuses a BRANCH_EMPLOYEE from reading or activating the vendor subscription - PDR-009 lists it as owner-only', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const employeePhone = uniquePhone();
      const accepted = await inviteAndAcceptAsNewUser(
        owner,
        vendorId,
        branchId,
        employeePhone,
        'employee-password',
      );
      const employeeToken = accepted.session_token as string;

      const readRes = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/subscription`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(403);
      expect(readRes.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');

      const activateRes = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/subscription`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .set('Idempotency-Key', unique('sub-as-employee'))
        .send({})
        .expect(403);
      expect(activateRes.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');

      const sub = await prisma.vendorSubscription.findFirst({
        where: { vendorId },
      });
      expect(sub).toBeNull();
    });
  });
});
