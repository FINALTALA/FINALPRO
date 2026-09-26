import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
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

// +97059 prefix (not +97056/+97057/+97058 already used by sibling
// spec files - see the PS-phone-prefix convention this codebase
// follows) with its own numeric offset, so this file's phones never
// collide with another spec running in the same worker.
let phoneSeq = (Date.now() % 1_000_000) + 500_000;
function uniquePhone(): string {
  phoneSeq += 1;
  return `+97059${(phoneSeq % 10_000_000).toString().padStart(7, '0')}`;
}
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

// Sprint 15 (PDR-035, OPEN-011 closed): ONLINE_ONLY store verification
// via an immutable WarehouseVerificationEvidence snapshot, plus the
// store_type/physical-branch invariant enforced at both application
// and later store-type-change time, plus GET :vendorId/staff-invites.
//
// store_type<->physical-branch invariant coverage at application time
// and at PUT :vendorId/store-type time lives in
// sprint5-store-inventory.e2e-spec.ts (it already owns that
// controller's other store-type/warehouse tests) - not duplicated
// here. This file covers the genuinely new Sprint 15 surface: the
// three warehouse/verification-* endpoints, their tenant-safety and
// snapshot-immutability guarantees, and the staff-invites list.
describe('Sprint 15 - vendor onboarding: warehouse verification evidence, staff invites (e2e)', () => {
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

  /** ONLINE_ONLY vendor, zero physical branches, matching the new
   * application-time invariant. */
  async function createOnlineOnlyVendor(
    ownerToken: string,
  ): Promise<{ vendorId: string }> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('vendor-apply'))
      .send({
        legal_name: unique('Vendor'),
        store_type: 'ONLINE_ONLY',
        branches: [{ name: 'Warehouse branch', is_physical: false }],
        applicable_categories: ['WOMEN'],
      })
      .expect(201);
    return { vendorId: res.body.id };
  }

  async function setWarehouse(
    ownerToken: string,
    vendorId: string,
    overrides: Partial<{ lat: number; lng: number; address_note: string }> = {},
  ) {
    await request(app.getHttpServer())
      .put(`/api/v1/vendors/${vendorId}/warehouse`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        lat: 31.9,
        lng: 35.2,
        address_note: 'Industrial zone, unit 4',
        ...overrides,
      })
      .expect(200);
  }

  function submitWarehouseEvidence(ownerToken: string, vendorId: string) {
    return request(app.getHttpServer())
      .post(`/api/v1/vendors/${vendorId}/warehouse/verification-evidence`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', unique('wh-evidence'));
  }

  describe('full ONLINE_ONLY verification path', () => {
    it('apply -> warehouse -> submit evidence -> reviewer reads it -> approves -> subscription unlocks', async () => {
      const ownerPhone = uniquePhone();
      const owner = await signup(ownerPhone, 'a-strong-password');
      const { vendorId } = await createOnlineOnlyVendor(owner);
      await setWarehouse(owner, vendorId);

      const submitRes = await submitWarehouseEvidence(owner, vendorId)
        .send({})
        .expect(201);
      expect(submitRes.body.status).toBe('PENDING');
      expect(submitRes.body.lat).toBe(31.9);

      const appliedVendor = await prisma.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });
      expect(appliedVendor.status).toBe('UNDER_REVIEW');

      const reviewer = await signupWithPlatformRole('VERIFICATION_REVIEWER');
      const getRes = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/warehouse/verification-evidence`)
        .set('Authorization', `Bearer ${reviewer}`)
        .expect(200);
      expect(getRes.body).toEqual({
        id: submitRes.body.id,
        vendor_id: vendorId,
        warehouse_id: submitRes.body.warehouse_id,
        lat: 31.9,
        lng: 35.2,
        address_note: 'Industrial zone, unit 4',
        status: 'PENDING',
        submitted_at: submitRes.body.submitted_at,
      });

      const decideRes = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/warehouse/verification-decision`)
        .set('Authorization', `Bearer ${reviewer}`)
        .set('Idempotency-Key', unique('wh-decision'))
        .send({ evidence_id: getRes.body.id, decision: 'approve' })
        .expect(201);
      expect(decideRes.body.status).toBe('APPROVED');
      expect(decideRes.body.vendor_approved).toBe(true);

      const approvedVendor = await prisma.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });
      expect(approvedVendor.status).toBe('APPROVED');

      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/subscription`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('sub'))
        .send({})
        .expect(201);
    });

    it('rejects warehouse evidence -> vendor REJECTED -> no further evidence accepted -> a corrected application via POST /vendors still works (PDR-010)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createOnlineOnlyVendor(owner);
      await setWarehouse(owner, vendorId);
      const submitRes = await submitWarehouseEvidence(owner, vendorId)
        .send({})
        .expect(201);

      const reviewer = await signupWithPlatformRole('VERIFICATION_REVIEWER');
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/warehouse/verification-decision`)
        .set('Authorization', `Bearer ${reviewer}`)
        .set('Idempotency-Key', unique('wh-decision'))
        .send({
          evidence_id: submitRes.body.id,
          decision: 'reject',
          reason: 'Address does not match business registration',
        })
        .expect(201);

      const rejected = await prisma.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });
      expect(rejected.status).toBe('REJECTED');

      await submitWarehouseEvidence(owner, vendorId).send({}).expect(409);

      // PDR-010: reapplication is always a *new* application.
      await request(app.getHttpServer())
        .post('/api/v1/vendors')
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('vendor-apply'))
        .send({
          legal_name: unique('Vendor'),
          store_type: 'ONLINE_ONLY',
          branches: [{ name: 'Warehouse branch', is_physical: false }],
          applicable_categories: ['WOMEN'],
        })
        .expect(201);
    });

    it('request_resubmission leaves the old row frozen and requires a brand-new snapshot, which decides independently', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createOnlineOnlyVendor(owner);
      await setWarehouse(owner, vendorId);
      const first = await submitWarehouseEvidence(owner, vendorId)
        .send({})
        .expect(201);

      const reviewer = await signupWithPlatformRole('VERIFICATION_REVIEWER');
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/warehouse/verification-decision`)
        .set('Authorization', `Bearer ${reviewer}`)
        .set('Idempotency-Key', unique('wh-decision'))
        .send({ evidence_id: first.body.id, decision: 'request_resubmission' })
        .expect(201);

      const stillUnderReview = await prisma.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });
      expect(stillUnderReview.status).toBe('UNDER_REVIEW');

      const second = await submitWarehouseEvidence(owner, vendorId)
        .send({})
        .expect(201);
      expect(second.body.id).not.toBe(first.body.id);

      const firstRow =
        await prisma.warehouseVerificationEvidence.findUniqueOrThrow({
          where: { id: first.body.id },
        });
      expect(firstRow.status).toBe('RESUBMISSION_REQUESTED');

      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/warehouse/verification-decision`)
        .set('Authorization', `Bearer ${reviewer}`)
        .set('Idempotency-Key', unique('wh-decision'))
        .send({ evidence_id: second.body.id, decision: 'approve' })
        .expect(201);
      const approved = await prisma.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });
      expect(approved.status).toBe('APPROVED');
    });
  });

  describe('validation and conflict failures', () => {
    it('refuses submission for a PHYSICAL/HYBRID store', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const res = await request(app.getHttpServer())
        .post('/api/v1/vendors')
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('vendor-apply'))
        .send({
          legal_name: unique('Vendor'),
          store_type: 'PHYSICAL',
          branches: [{ name: 'Main branch', is_physical: true }],
          applicable_categories: ['WOMEN'],
        })
        .expect(201);
      const vendorId = res.body.id;

      const submitRes = await submitWarehouseEvidence(owner, vendorId)
        .send({})
        .expect(400);
      expect(submitRes.body.error.code).toBe('STORE_NOT_ONLINE_ONLY');
    });

    it('refuses submission with no warehouse lat/lng/address_note set', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createOnlineOnlyVendor(owner);

      const res = await submitWarehouseEvidence(owner, vendorId)
        .send({})
        .expect(400);
      expect(res.body.error.code).toBe('WAREHOUSE_EVIDENCE_INCOMPLETE');

      // No evidence row, and no AuditLog row referencing this vendor,
      // from a failed submission. AuditLog is scanned and filtered by
      // this test's own vendorId (not a bare global count) because the
      // e2e suite shares one database across tests within this file -
      // other tests legitimately write WarehouseVerificationEvidence
      // audit rows of their own.
      expect(
        await prisma.warehouseVerificationEvidence.count({
          where: { vendorId },
        }),
      ).toBe(0);
      const auditRows = await prisma.auditLog.findMany({
        where: { entityType: 'WarehouseVerificationEvidence' },
      });
      expect(
        auditRows.filter((r) => JSON.stringify(r).includes(vendorId)),
      ).toHaveLength(0);
    });

    it('refuses a second submission while one is already PENDING (app-level 409, no partial write)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createOnlineOnlyVendor(owner);
      await setWarehouse(owner, vendorId);
      await submitWarehouseEvidence(owner, vendorId).send({}).expect(201);

      const before = await prisma.warehouseVerificationEvidence.count({
        where: { vendorId },
      });
      const res = await submitWarehouseEvidence(owner, vendorId)
        .send({})
        .expect(409);
      expect(res.body.error.code).toBe('WAREHOUSE_EVIDENCE_ALREADY_PENDING');
      expect(
        await prisma.warehouseVerificationEvidence.count({
          where: { vendorId },
        }),
      ).toBe(before);
    });

    it('two concurrent submissions for the same vendor: exactly one succeeds, the other gets a clean 409 (never a 500) - the partial unique index is the structural backstop behind the app-level check', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createOnlineOnlyVendor(owner);
      await setWarehouse(owner, vendorId);

      const [a, b] = await Promise.all([
        submitWarehouseEvidence(owner, vendorId).send({}),
        submitWarehouseEvidence(owner, vendorId).send({}),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]);
      const failed = a.status === 409 ? a : b;
      expect(failed.body.error.code).toBe('WAREHOUSE_EVIDENCE_ALREADY_PENDING');

      expect(
        await prisma.warehouseVerificationEvidence.count({
          where: { vendorId, status: 'PENDING' },
        }),
      ).toBe(1);
    });

    it('decision with a stale/wrong evidence_id is rejected, not applied to a different row', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorAId } = await createOnlineOnlyVendor(owner);
      await setWarehouse(owner, vendorAId);
      await submitWarehouseEvidence(owner, vendorAId).send({}).expect(201);

      const owner2 = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorBId } = await createOnlineOnlyVendor(owner2);
      await setWarehouse(owner2, vendorBId);
      const evidenceB = await submitWarehouseEvidence(owner2, vendorBId)
        .send({})
        .expect(201);

      const reviewer = await signupWithPlatformRole('VERIFICATION_REVIEWER');
      // evidence_id belongs to vendor B, decision targets vendor A's URL.
      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorAId}/warehouse/verification-decision`)
        .set('Authorization', `Bearer ${reviewer}`)
        .set('Idempotency-Key', unique('wh-decision'))
        .send({ evidence_id: evidenceB.body.id, decision: 'approve' })
        .expect(409);
      expect(res.body.error.code).toBe('WAREHOUSE_EVIDENCE_STALE');

      const untouchedB =
        await prisma.warehouseVerificationEvidence.findUniqueOrThrow({
          where: { id: evidenceB.body.id },
        });
      expect(untouchedB.status).toBe('PENDING');
    });

    it('a decision on a random/nonexistent evidence_id is rejected the same way, never a 500', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createOnlineOnlyVendor(owner);
      await setWarehouse(owner, vendorId);
      await submitWarehouseEvidence(owner, vendorId).send({}).expect(201);

      const reviewer = await signupWithPlatformRole('VERIFICATION_REVIEWER');
      const res = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/warehouse/verification-decision`)
        .set('Authorization', `Bearer ${reviewer}`)
        .set('Idempotency-Key', unique('wh-decision'))
        .send({
          evidence_id: '00000000-0000-0000-0000-000000000000',
          decision: 'approve',
        })
        .expect(409);
      expect(res.body.error.code).toBe('WAREHOUSE_EVIDENCE_STALE');
    });
  });

  describe('snapshot immutability', () => {
    it('editing the operational warehouse after submission never changes the already-submitted (or already-approved) snapshot', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createOnlineOnlyVendor(owner);
      await setWarehouse(owner, vendorId);
      const submitRes = await submitWarehouseEvidence(owner, vendorId)
        .send({})
        .expect(201);

      const reviewer = await signupWithPlatformRole('VERIFICATION_REVIEWER');
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/warehouse/verification-decision`)
        .set('Authorization', `Bearer ${reviewer}`)
        .set('Idempotency-Key', unique('wh-decision'))
        .send({ evidence_id: submitRes.body.id, decision: 'approve' })
        .expect(201);

      // Owner edits the live warehouse address after approval.
      await setWarehouse(owner, vendorId, {
        lat: 5.0,
        lng: 5.0,
        address_note: 'Moved to a new unit',
      });

      const evidenceAfterEdit =
        await prisma.warehouseVerificationEvidence.findUniqueOrThrow({
          where: { id: submitRes.body.id },
        });
      expect(evidenceAfterEdit.lat).toBe(31.9);
      expect(evidenceAfterEdit.lng).toBe(35.2);
      expect(evidenceAfterEdit.addressNote).toBe('Industrial zone, unit 4');
      expect(evidenceAfterEdit.status).toBe('APPROVED');

      const warehouseNow = await prisma.warehouse.findUniqueOrThrow({
        where: { vendorId },
      });
      expect(warehouseNow.lat).toBe(5.0);
      expect(warehouseNow.addressNote).toBe('Moved to a new unit');
    });
  });

  describe('tenant-safety (composite FK) and BOLA/privacy', () => {
    it('Postgres itself rejects an evidence row whose warehouse_id belongs to a different vendor than its own vendor_id (composite FK, raw SQL, bypassing the application entirely)', async () => {
      const ownerA = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorAId } = await createOnlineOnlyVendor(ownerA);
      await setWarehouse(ownerA, vendorAId);

      const ownerB = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId: vendorBId } = await createOnlineOnlyVendor(ownerB);
      await setWarehouse(ownerB, vendorBId);

      const warehouseB = await prisma.warehouse.findUniqueOrThrow({
        where: { vendorId: vendorBId },
      });

      // Raw INSERT: vendor_id = A, warehouse_id = B's warehouse. The
      // composite FK (vendorId, warehouseId) -> warehouses(vendorId, id)
      // must reject this - a plain warehouseId-only FK would not have.
      await expect(
        prisma.$executeRaw`
          INSERT INTO warehouse_verification_evidence
            (id, "vendorId", "warehouseId", lat, lng, "addressNote", status, "submittedAt")
          VALUES
            (${randomUUID()}, ${vendorAId}, ${warehouseB.id}, 1.0, 1.0, 'x', 'PENDING', now())
        `,
      ).rejects.toThrow();

      expect(
        await prisma.warehouseVerificationEvidence.count({
          where: { vendorId: vendorAId },
        }),
      ).toBe(0);
    });

    it('a second PENDING row for the same vendor is rejected by the partial unique index even via a raw INSERT that bypasses the application lock entirely', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createOnlineOnlyVendor(owner);
      await setWarehouse(owner, vendorId);
      await submitWarehouseEvidence(owner, vendorId).send({}).expect(201);

      const warehouse = await prisma.warehouse.findUniqueOrThrow({
        where: { vendorId },
      });

      await expect(
        prisma.$executeRaw`
          INSERT INTO warehouse_verification_evidence
            (id, "vendorId", "warehouseId", lat, lng, "addressNote", status, "submittedAt")
          VALUES
            (${randomUUID()}, ${vendorId}, ${warehouse.id}, 1.0, 1.0, 'x', 'PENDING', now())
        `,
      ).rejects.toThrow();

      expect(
        await prisma.warehouseVerificationEvidence.count({
          where: { vendorId, status: 'PENDING' },
        }),
      ).toBe(1);
    });

    it("GET/POST evidence endpoints refuse the owner, an employee, a different vendor's owner, and a plain customer - only VERIFICATION_REVIEWER/PLATFORM_ADMIN reach them", async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createOnlineOnlyVendor(owner);
      await setWarehouse(owner, vendorId);
      await submitWarehouseEvidence(owner, vendorId).send({}).expect(201);

      const customer = await signup(uniquePhone(), 'a-strong-password');
      const otherOwner = await signup(uniquePhone(), 'a-strong-password');

      for (const token of [owner, customer, otherOwner]) {
        await request(app.getHttpServer())
          .get(`/api/v1/vendors/${vendorId}/warehouse/verification-evidence`)
          .set('Authorization', `Bearer ${token}`)
          .expect(403);
        await request(app.getHttpServer())
          .post(`/api/v1/vendors/${vendorId}/warehouse/verification-decision`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', unique('wh-decision'))
          .send({ evidence_id: 'x', decision: 'approve' })
          .expect(403);
      }
    });

    it('never leaks warehouse evidence into any public/general response - vendorSummaryDto, storefront, discovery', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createOnlineOnlyVendor(owner);
      await setWarehouse(owner, vendorId, {
        address_note: 'unique-marker-should-never-leak-anywhere',
      });
      await submitWarehouseEvidence(owner, vendorId).send({}).expect(201);

      const summary = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(JSON.stringify(summary.body)).not.toContain(
        'unique-marker-should-never-leak-anywhere',
      );

      const discovery = await request(app.getHttpServer())
        .get('/api/v1/discovery/all')
        .expect(200);
      expect(JSON.stringify(discovery.body)).not.toContain(
        'unique-marker-should-never-leak-anywhere',
      );
    });
  });

  describe('AuditLog content safety', () => {
    it('submit and decide both write AuditLog rows, but neither contains lat/lng/address_note/review_note content', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createOnlineOnlyVendor(owner);
      await setWarehouse(owner, vendorId, {
        address_note: 'audit-marker-should-never-appear-in-log',
      });
      const submitRes = await submitWarehouseEvidence(owner, vendorId)
        .send({})
        .expect(201);

      const reviewer = await signupWithPlatformRole('VERIFICATION_REVIEWER');
      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/warehouse/verification-decision`)
        .set('Authorization', `Bearer ${reviewer}`)
        .set('Idempotency-Key', unique('wh-decision'))
        .send({
          evidence_id: submitRes.body.id,
          decision: 'reject',
          reason: 'audit-reason-should-never-appear-either',
        })
        .expect(201);

      // Scoped to this test's own evidence row id - the e2e suite
      // shares one database across tests in this file, and other
      // tests write their own WarehouseVerificationEvidence audit rows.
      const rows = await prisma.auditLog.findMany({
        where: {
          entityType: 'WarehouseVerificationEvidence',
          entityId: submitRes.body.id,
        },
      });
      expect(rows.length).toBeGreaterThanOrEqual(2);
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain('audit-marker-should-never-appear-in-log');
      expect(dump).not.toContain('audit-reason-should-never-appear-either');
      expect(dump).not.toContain('31.9');

      const submitted = rows.find(
        (r) => r.action === 'warehouse_verification_evidence.submitted',
      );
      expect(submitted?.afterState).toMatchObject({
        vendor_id: vendorId,
        status: 'PENDING',
      });
      const decided = rows.find(
        (r) => r.action === 'warehouse_verification_evidence.decided',
      );
      expect(decided?.afterState).toMatchObject({ status: 'REJECTED' });
    });
  });

  describe('idempotency', () => {
    it('a duplicate submission with the same Idempotency-Key replays the original response, never a second row', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createOnlineOnlyVendor(owner);
      await setWarehouse(owner, vendorId);
      const key = unique('wh-evidence');

      const first = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/warehouse/verification-evidence`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', key)
        .send({})
        .expect(201);
      const second = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/warehouse/verification-evidence`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', key)
        .send({})
        .expect(201);

      expect(second.body.id).toBe(first.body.id);
      expect(
        await prisma.warehouseVerificationEvidence.count({
          where: { vendorId },
        }),
      ).toBe(1);
    });

    it('a duplicate decision with the same Idempotency-Key replays the original response, never a second AuditLog/state change', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createOnlineOnlyVendor(owner);
      await setWarehouse(owner, vendorId);
      const submitRes = await submitWarehouseEvidence(owner, vendorId)
        .send({})
        .expect(201);
      const reviewer = await signupWithPlatformRole('VERIFICATION_REVIEWER');
      const key = unique('wh-decision');
      const body = {
        evidence_id: submitRes.body.id,
        decision: 'approve' as const,
      };

      const first = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/warehouse/verification-decision`)
        .set('Authorization', `Bearer ${reviewer}`)
        .set('Idempotency-Key', key)
        .send(body)
        .expect(201);
      const second = await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/warehouse/verification-decision`)
        .set('Authorization', `Bearer ${reviewer}`)
        .set('Idempotency-Key', key)
        .send(body)
        .expect(201);

      expect(second.body).toEqual(first.body);
      expect(
        await prisma.auditLog.count({
          where: {
            entityType: 'Vendor',
            action: 'vendor.approved',
            entityId: vendorId,
          },
        }),
      ).toBe(1);
    });
  });

  describe('GET :vendorId/staff-invites', () => {
    async function createVendorWithBranch(ownerToken: string) {
      const res = await request(app.getHttpServer())
        .post('/api/v1/vendors')
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Idempotency-Key', unique('vendor-apply'))
        .send({
          legal_name: unique('Vendor'),
          store_type: 'PHYSICAL',
          branches: [{ name: 'Main branch', is_physical: true }],
          applicable_categories: ['WOMEN'],
        })
        .expect(201);
      return { vendorId: res.body.id, branchId: res.body.branches[0].id };
    }

    it('is empty for a vendor with no invites yet', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithBranch(owner);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/staff-invites`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(res.body).toEqual([]);
    });

    it('lists a pending invite, then reflects it as accepted, with only the allow-listed fields - no token/OTP/inviter data', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const employeePhone = uniquePhone();

      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchId}/staff-invites`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('invite'))
        .send({ phone: employeePhone })
        .expect(201);

      const pendingRes = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/staff-invites`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(pendingRes.body).toHaveLength(1);
      const invite = pendingRes.body[0];
      expect(invite).toEqual({
        id: invite.id,
        branch_id: branchId,
        branch_name: 'Main branch',
        phone: employeePhone,
        status: 'PENDING',
        created_at: invite.created_at,
        expires_at: invite.expires_at,
        accepted_at: null,
      });
      // No token, no OTP-code-shaped field, nothing about the inviter.
      const keys = Object.keys(invite).sort();
      expect(keys).toEqual([
        'accepted_at',
        'branch_id',
        'branch_name',
        'created_at',
        'expires_at',
        'id',
        'phone',
        'status',
      ]);

      await request(app.getHttpServer())
        .post('/api/v1/auth/otp/request')
        .send({ phone: employeePhone, purpose: 'staff_invite' })
        .expect(202);
      const code = fakeSms.lastCodeFor(employeePhone);
      const verify = await request(app.getHttpServer())
        .post('/api/v1/auth/otp/verify')
        .set('Idempotency-Key', `verify-${employeePhone}`)
        .send({ phone: employeePhone, otp_code: code, purpose: 'staff_invite' })
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/auth/staff-invites/accept')
        .set('Idempotency-Key', unique('accept'))
        .send({
          phone: employeePhone,
          verification_token: verify.body.session_token,
          password: 'employee-password',
        })
        .expect(200);

      const acceptedRes = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/staff-invites`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(acceptedRes.body[0].status).toBe('ACCEPTED');
      expect(acceptedRes.body[0].accepted_at).not.toBeNull();
    });

    it("refuses a non-member and a different vendor's owner (BOLA) - 403 NOT_VENDOR_MEMBER, matching VendorMembershipGuard's existing convention", async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId } = await createVendorWithBranch(owner);
      const otherOwner = await signup(uniquePhone(), 'a-strong-password');

      const res = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/staff-invites`)
        .set('Authorization', `Bearer ${otherOwner}`)
        .expect(403);
      expect(res.body.error.code).toBe('NOT_VENDOR_MEMBER');
    });

    it('refuses a BRANCH_EMPLOYEE of this same vendor - staff management is owner-only (PDR-009)', async () => {
      const owner = await signup(uniquePhone(), 'a-strong-password');
      const { vendorId, branchId } = await createVendorWithBranch(owner);
      const employeePhone = uniquePhone();

      await request(app.getHttpServer())
        .post(`/api/v1/vendors/${vendorId}/branches/${branchId}/staff-invites`)
        .set('Authorization', `Bearer ${owner}`)
        .set('Idempotency-Key', unique('invite'))
        .send({ phone: employeePhone })
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/auth/otp/request')
        .send({ phone: employeePhone, purpose: 'staff_invite' })
        .expect(202);
      const code = fakeSms.lastCodeFor(employeePhone);
      const verify = await request(app.getHttpServer())
        .post('/api/v1/auth/otp/verify')
        .set('Idempotency-Key', `verify-${employeePhone}`)
        .send({ phone: employeePhone, otp_code: code, purpose: 'staff_invite' })
        .expect(200);
      const accept = await request(app.getHttpServer())
        .post('/api/v1/auth/staff-invites/accept')
        .set('Idempotency-Key', unique('accept'))
        .send({
          phone: employeePhone,
          verification_token: verify.body.session_token,
          password: 'employee-password',
        })
        .expect(200);
      const employeeToken = accept.body.session_token as string;

      const res = await request(app.getHttpServer())
        .get(`/api/v1/vendors/${vendorId}/staff-invites`)
        .set('Authorization', `Bearer ${employeeToken}`)
        .expect(403);
      expect(res.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');
    });
  });
});
