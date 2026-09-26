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
}

// Same +97056 prefix as every other e2e spec's own uniquePhone() (the
// only PS mobile prefixes class-validator's IsPhoneNumber accepts under
// libphonenumber-js/max) - a distinct numeric offset avoids collisions
// between files.
let phoneSeq = (Date.now() % 1_000_000) + 800_000;
function uniquePhone(): string {
  phoneSeq += 1;
  return `+97056${(phoneSeq % 10_000_000).toString().padStart(7, '0')}`;
}
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

// Security remediation (post-Sprint-6 review): VendorVerificationController.
// submitEvidence() used to check vendor membership by hand (any role, no
// branch scoping) instead of going through VendorMembershipGuard - the
// same class of gap already found and fixed twice before
// (VendorOffersController, SubscriptionsController). A BRANCH_EMPLOYEE
// could submit/resubmit verification evidence for any branch of the
// vendor, a direct PDR-009 violation (store configuration is owner-only).
describe('Vendor verification evidence - owner-only authorization fix (e2e)', () => {
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

  async function signupWithPlatformRole(
    role: 'PLATFORM_ADMIN' | 'VERIFICATION_REVIEWER',
  ): Promise<string> {
    const phone = uniquePhone();
    const token = await signup(phone, 'a-strong-password');
    await prisma.user.update({
      where: { phone },
      data: { platformRole: role },
    });
    return token;
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
        store_type: 'PHYSICAL',
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

  it('still lets the OWNER submit verification evidence (the fix must not lock out legitimate access)', async () => {
    const owner = await signup(uniquePhone(), 'a-strong-password');
    const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);

    const res = await request(app.getHttpServer())
      .post(
        `/api/v1/vendors/${vendorId}/branches/${branchAId}/verification-evidence`,
      )
      .set('Authorization', `Bearer ${owner}`)
      .set('Idempotency-Key', unique('evidence'))
      .send({
        lat: 32.22,
        lng: 35.26,
        verification_photo_url: 'https://example.com/photo.jpg',
      })
      .expect(201);
    expect(res.body.verification_status).toBe('PENDING');

    const branch = await prisma.storeBranch.findUniqueOrThrow({
      where: { id: branchAId },
    });
    expect(branch.verificationPhotoUrl).toBe('https://example.com/photo.jpg');
  });

  it('refuses a BRANCH_EMPLOYEE from submitting evidence even for their OWN assigned branch', async () => {
    const owner = await signup(uniquePhone(), 'a-strong-password');
    const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
    const employeePhone = uniquePhone();
    const accepted = await inviteAndAcceptAsNewUser(
      owner,
      vendorId,
      branchAId,
      employeePhone,
      'employee-password',
    );
    const employeeToken = accepted.session_token as string;

    const res = await request(app.getHttpServer())
      .post(
        `/api/v1/vendors/${vendorId}/branches/${branchAId}/verification-evidence`,
      )
      .set('Authorization', `Bearer ${employeeToken}`)
      .set('Idempotency-Key', unique('evidence'))
      .send({
        lat: 32.22,
        lng: 35.26,
        verification_photo_url: 'https://example.com/photo.jpg',
      })
      .expect(403);
    expect(res.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');

    const branch = await prisma.storeBranch.findUniqueOrThrow({
      where: { id: branchAId },
    });
    expect(branch.verificationPhotoUrl).toBeNull();
  });

  it('refuses a BRANCH_EMPLOYEE from submitting evidence for a SIBLING branch of the same vendor', async () => {
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
    const employeeToken = accepted.session_token as string;

    const res = await request(app.getHttpServer())
      .post(
        `/api/v1/vendors/${vendorId}/branches/${branchBId}/verification-evidence`,
      )
      .set('Authorization', `Bearer ${employeeToken}`)
      .set('Idempotency-Key', unique('evidence'))
      .send({
        lat: 32.22,
        lng: 35.26,
        verification_photo_url: 'https://example.com/photo.jpg',
      })
      .expect(403);
    // The role check runs before branch-scoping in VendorMembershipGuard,
    // so this is rejected as VENDOR_ROLE_FORBIDDEN, not
    // BRANCH_ACCESS_DENIED - an employee is excluded from this route
    // entirely, regardless of which branch they target.
    expect(res.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');
  });

  it('refuses a completely unrelated user (not a member of this vendor at all) with NOT_VENDOR_MEMBER', async () => {
    const owner = await signup(uniquePhone(), 'a-strong-password');
    const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
    const outsider = await signup(uniquePhone(), 'outsider-password');

    const res = await request(app.getHttpServer())
      .post(
        `/api/v1/vendors/${vendorId}/branches/${branchAId}/verification-evidence`,
      )
      .set('Authorization', `Bearer ${outsider}`)
      .set('Idempotency-Key', unique('evidence'))
      .send({
        lat: 32.22,
        lng: 35.26,
        verification_photo_url: 'https://example.com/photo.jpg',
      })
      .expect(403);
    expect(res.body.error.code).toBe('NOT_VENDOR_MEMBER');
  });

  it('leaves the platform reviewer decision path untouched - PLATFORM_ADMIN/VERIFICATION_REVIEWER can still approve/reject', async () => {
    const owner = await signup(uniquePhone(), 'a-strong-password');
    const { vendorId, branchAId } = await createVendorWithTwoBranches(owner);
    await request(app.getHttpServer())
      .post(
        `/api/v1/vendors/${vendorId}/branches/${branchAId}/verification-evidence`,
      )
      .set('Authorization', `Bearer ${owner}`)
      .set('Idempotency-Key', unique('evidence'))
      .send({
        lat: 32.22,
        lng: 35.26,
        verification_photo_url: 'https://example.com/photo.jpg',
      })
      .expect(201);

    const reviewer = await signupWithPlatformRole('VERIFICATION_REVIEWER');
    const decisionRes = await request(app.getHttpServer())
      .post(
        `/api/v1/vendors/${vendorId}/branches/${branchAId}/verification-decision`,
      )
      .set('Authorization', `Bearer ${reviewer}`)
      .set('Idempotency-Key', unique('decision'))
      .send({ decision: 'approve' })
      .expect(201);
    expect(decisionRes.body.verification_status).toBe('APPROVED');

    // A second, independent vendor/branch, decided by a PLATFORM_ADMIN
    // instead, confirms both platform roles this route already
    // accepted still work.
    const secondOwner = await signup(uniquePhone(), 'a-strong-password');
    const secondVendorRes = await request(app.getHttpServer())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${secondOwner}`)
      .set('Idempotency-Key', unique('vendor-apply'))
      .send({
        legal_name: unique('Vendor'),
        store_type: 'PHYSICAL',
        branches: [{ name: 'Solo branch', is_physical: true }],
        applicable_categories: ['WOMEN'],
      })
      .expect(201);
    const secondVendorId = secondVendorRes.body.id;
    const soloBranchId = secondVendorRes.body.branches[0].id;
    await request(app.getHttpServer())
      .post(
        `/api/v1/vendors/${secondVendorId}/branches/${soloBranchId}/verification-evidence`,
      )
      .set('Authorization', `Bearer ${secondOwner}`)
      .set('Idempotency-Key', unique('evidence'))
      .send({
        lat: 32.22,
        lng: 35.26,
        verification_photo_url: 'https://example.com/photo.jpg',
      })
      .expect(201);

    const admin = await signupWithPlatformRole('PLATFORM_ADMIN');
    const adminDecisionRes = await request(app.getHttpServer())
      .post(
        `/api/v1/vendors/${secondVendorId}/branches/${soloBranchId}/verification-decision`,
      )
      .set('Authorization', `Bearer ${admin}`)
      .set('Idempotency-Key', unique('decision'))
      .send({ decision: 'approve' })
      .expect(201);
    expect(adminDecisionRes.body.verification_status).toBe('APPROVED');
  });
});
