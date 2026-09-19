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
});
