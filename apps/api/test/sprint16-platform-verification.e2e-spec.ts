import * as request from 'supertest';
import { AuditLogService } from './../src/audit/audit-log.service';
import {
  Sprint16Ctx,
  bootApp,
  createFixtures,
} from './helpers/sprint16-fixtures';

/** Every key at every depth of a JSON value. */
function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((v) => allKeys(v, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.add(k);
      allKeys(v, out);
    }
  }
  return out;
}

const EVIDENCE_KEYS = [
  'lat',
  'lng',
  'address_note',
  'photo_url',
  'verification_photo_url',
];

// Sprint 16 (FR-VEND-003, G-AD-01, D3/D4/D7/D8): the reviewer queue, the
// audited single-item evidence reads, evidence-revision binding, the
// reason rules on decisions, the owner's verification-status read, and
// the sequential half of the conflict-of-interest rule. The concurrent
// half (barriers against acceptStaffInvite) is in
// sprint16-moderation-concurrency.e2e-spec.ts.
describe('Sprint 16 - platform verification: queue, evidence reads, decisions (e2e)', () => {
  const ctx = {} as Sprint16Ctx;
  let f: ReturnType<typeof createFixtures>;

  beforeEach(async () => {
    await bootApp(ctx);
    f = createFixtures(ctx, 0);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await ctx.app.close();
  });

  const http = () => ctx.app.getHttpServer();

  async function queueAll(token: string, status?: string) {
    const items: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 200; i++) {
      const qs = new URLSearchParams({ limit: '50' });
      if (status) qs.set('status', status);
      if (cursor) qs.set('cursor', cursor);
      const res = await request(http())
        .get(`/api/v1/admin/verification-queue?${qs.toString()}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      items.push(...res.body.items);
      cursor = res.body.next_cursor;
      if (!cursor) break;
    }
    return items;
  }

  // ---------------------------------------------------------------
  describe('reviewer queue (GET /admin/verification-queue)', () => {
    it('lists only items with submitted evidence for an UNDER_REVIEW vendor, with no evidence content at all', async () => {
      const reviewer = await f.platformUser('VERIFICATION_REVIEWER');
      const ownerA = await f.signup(f.uniquePhone(), 'a-strong-password');
      const { vendorId: vendorA, branchIds } = await f.createPhysicalVendor(
        ownerA,
        2,
      );
      // Only branch 1 gets evidence; branch 2 stays PENDING with revision 0.
      await f
        .submitBranchEvidence(ownerA, vendorA, branchIds[0], {
          verification_photo_url: 'https://example.com/queue-secret-photo.jpg',
        })
        .expect(201);

      const ownerB = await f.signup(f.uniquePhone(), 'a-strong-password');
      const { vendorId: vendorB } = await f.createOnlineOnlyVendor(ownerB);
      await f.setWarehouse(ownerB, vendorB, {
        lat: 31.123456,
        lng: 35.654321,
        address_note: 'queue-secret-warehouse-note',
      });
      const wh = await f.submitWarehouseEvidence(ownerB, vendorB).expect(201);

      // A third vendor still APPLIED (no evidence at all): must not appear.
      const ownerC = await f.signup(f.uniquePhone(), 'a-strong-password');
      const { vendorId: vendorC } = await f.createPhysicalVendor(ownerC, 1);

      const items = await queueAll(reviewer.token);
      const mine = items.filter((i) =>
        [vendorA, vendorB, vendorC].includes(i.vendor_id as string),
      );
      expect(mine).toHaveLength(2);
      const branchItem = mine.find((i) => i.kind === 'BRANCH')!;
      const whItem = mine.find((i) => i.kind === 'WAREHOUSE')!;
      expect(branchItem).toMatchObject({
        item_id: branchIds[0],
        vendor_id: vendorA,
        store_type: 'PHYSICAL',
        branch_name: 'Branch 1',
      });
      expect(whItem).toMatchObject({
        item_id: wh.body.id,
        vendor_id: vendorB,
        store_type: 'ONLINE_ONLY',
      });
      expect(typeof branchItem.submitted_at).toBe('string');

      const serialized = JSON.stringify(items);
      for (const secret of [
        'queue-secret-photo',
        'queue-secret-warehouse-note',
        '31.123456',
        '35.654321',
      ]) {
        expect(serialized).not.toContain(secret);
      }
      const keys = allKeys(items);
      for (const k of EVIDENCE_KEYS) expect(keys.has(k)).toBe(false);
    });

    it('excludes stores the caller is a member of (they could not act on them anyway)', async () => {
      const reviewer = await f.platformUser('VERIFICATION_REVIEWER');
      const owner = await f.signup(f.uniquePhone(), 'a-strong-password');
      const { vendorId, branchIds } = await f.createPhysicalVendor(owner, 1);
      await f.submitBranchEvidence(owner, vendorId, branchIds[0]).expect(201);

      const before = await queueAll(reviewer.token);
      expect(before.some((i) => i.vendor_id === vendorId)).toBe(true);

      await ctx.prisma.vendorUser.create({
        data: { userId: reviewer.userId, vendorId, role: 'OWNER' },
      });
      const after = await queueAll(reviewer.token);
      expect(after.some((i) => i.vendor_id === vendorId)).toBe(false);
    });

    it("'decided' is an explicit opt-in: decided items leave 'pending' and appear under status=decided with status and reviewed_at", async () => {
      const reviewer = await f.platformUser('VERIFICATION_REVIEWER');
      const owner = await f.signup(f.uniquePhone(), 'a-strong-password');
      const { vendorId, branchIds } = await f.createPhysicalVendor(owner, 1);
      await f.submitBranchEvidence(owner, vendorId, branchIds[0]).expect(201);
      await f
        .decideBranch(reviewer.token, vendorId, branchIds[0], {
          decision: 'reject',
          evidence_revision: 1,
          reason: 'The storefront photo does not match the pin',
        })
        .expect(201);

      const pending = await queueAll(reviewer.token);
      expect(pending.some((i) => i.vendor_id === vendorId)).toBe(false);
      const decided = await queueAll(reviewer.token, 'decided');
      const row = decided.find((i) => i.vendor_id === vendorId)!;
      expect(row).toMatchObject({
        kind: 'BRANCH',
        item_id: branchIds[0],
        status: 'REJECTED',
      });
      expect(typeof row.reviewed_at).toBe('string');
      expect(row).not.toHaveProperty('review_note');
    });

    it('has a total, stable order (submitted_at, kind, item_id) and a cursor that never skips or repeats', async () => {
      const reviewer = await f.platformUser('VERIFICATION_REVIEWER');
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const owner = await f.signup(f.uniquePhone(), 'a-strong-password');
        const { vendorId, branchIds } = await f.createPhysicalVendor(owner, 1);
        await f.submitBranchEvidence(owner, vendorId, branchIds[0]).expect(201);
        ids.push(branchIds[0]);
      }

      const all = await queueAll(reviewer.token);
      const keys = all.map(
        (i) =>
          `${i.submitted_at as string}|${i.kind as string}|${i.item_id as string}`,
      );
      expect(new Set(keys).size).toBe(keys.length);
      const sorted = [...keys].sort((a, b) => {
        const [at, ak, ai] = a.split('|');
        const [bt, bk, bi] = b.split('|');
        if (at !== bt) return at < bt ? -1 : 1;
        if (ak !== bk) return ak < bk ? -1 : 1;
        return ai < bi ? -1 : ai > bi ? 1 : 0;
      });
      expect(keys).toEqual(sorted);
      const positions = ids.map((id) => all.findIndex((i) => i.item_id === id));
      expect(positions.every((p) => p >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));

      // limit=1 walks: consecutive pages are strictly increasing.
      const p1 = await request(http())
        .get('/api/v1/admin/verification-queue?limit=1')
        .set('Authorization', `Bearer ${reviewer.token}`)
        .expect(200);
      expect(p1.body.items).toHaveLength(1);
      expect(typeof p1.body.next_cursor).toBe('string');
      const p2 = await request(http())
        .get(
          `/api/v1/admin/verification-queue?limit=1&cursor=${p1.body.next_cursor as string}`,
        )
        .set('Authorization', `Bearer ${reviewer.token}`)
        .expect(200);
      expect(p2.body.items).toHaveLength(1);
      expect(p2.body.items[0].item_id).not.toBe(p1.body.items[0].item_id);
      expect(all[1].item_id).toBe(p2.body.items[0].item_id);
    });

    it('rejects a malformed cursor, an out-of-range/non-numeric limit, and an unknown status filter with 400', async () => {
      const reviewer = await f.platformUser('VERIFICATION_REVIEWER');
      const get = (qs: string) =>
        request(http())
          .get(`/api/v1/admin/verification-queue?${qs}`)
          .set('Authorization', `Bearer ${reviewer.token}`);
      expect(
        (await get('cursor=not-a-cursor').expect(400)).body.error.code,
      ).toBe('INVALID_CURSOR');
      const forged = Buffer.from(
        JSON.stringify(["1'; DROP TABLE users;--", 'BRANCH', 'x']),
      ).toString('base64url');
      expect((await get(`cursor=${forged}`).expect(400)).body.error.code).toBe(
        'INVALID_CURSOR',
      );
      for (const bad of ['0', '51', 'abc', '-1', '1.5']) {
        expect((await get(`limit=${bad}`).expect(400)).body.error.code).toBe(
          'INVALID_LIMIT',
        );
      }
      expect((await get('status=everything').expect(400)).body.error.code).toBe(
        'INVALID_STATUS_FILTER',
      );
    });

    it('is forbidden to a customer and to a store owner, and needs a session', async () => {
      const customer = await f.signup(f.uniquePhone(), 'a-strong-password');
      const owner = await f.signup(f.uniquePhone(), 'a-strong-password');
      await f.createPhysicalVendor(owner, 1);
      for (const token of [customer, owner]) {
        await request(http())
          .get('/api/v1/admin/verification-queue')
          .set('Authorization', `Bearer ${token}`)
          .expect(403);
      }
      await request(http()).get('/api/v1/admin/verification-queue').expect(401);
    });
  });

  // ---------------------------------------------------------------
  describe('branch evidence read (GET .../branches/:branchId/verification-evidence)', () => {
    async function setup() {
      const reviewer = await f.platformUser('VERIFICATION_REVIEWER');
      const owner = await f.signup(f.uniquePhone(), 'a-strong-password');
      const { vendorId, branchIds } = await f.createPhysicalVendor(owner, 2);
      await f
        .submitBranchEvidence(owner, vendorId, branchIds[0], {
          lat: 32.111111,
          lng: 35.222222,
          verification_photo_url: 'https://example.com/audit-canary-photo.jpg',
        })
        .expect(201);
      return { reviewer, owner, vendorId, branchIds };
    }

    it('returns the current PENDING evidence with the revision the decision must quote, and audits the read without any evidence content', async () => {
      const { reviewer, vendorId, branchIds } = await setup();
      const res = await f
        .getBranchEvidence(reviewer.token, vendorId, branchIds[0])
        .expect(200);
      expect(res.body).toEqual({
        vendor_id: vendorId,
        branch_id: branchIds[0],
        evidence_revision: 1,
        lat: 32.111111,
        lng: 35.222222,
        photo_url: 'https://example.com/audit-canary-photo.jpg',
        status: 'PENDING',
        submitted_at: expect.any(String),
      });

      const rows = await ctx.prisma.auditLog.findMany({
        where: {
          action: 'branch_verification_evidence.viewed',
          entityId: branchIds[0],
        },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].actorId).toBe(reviewer.userId);
      expect(rows[0].afterState).toEqual({
        vendor_id: vendorId,
        evidence_revision: 1,
      });
      const serialized = JSON.stringify(rows[0]);
      for (const canary of ['32.111111', '35.222222', 'audit-canary-photo']) {
        expect(serialized).not.toContain(canary);
      }
    });

    it('has no evidence to show for a branch without a submission, an already-decided branch, or a vendor no longer under review (404 NO_PENDING_BRANCH_EVIDENCE)', async () => {
      const { reviewer, vendorId, branchIds } = await setup();
      // branch 2: never submitted.
      const none = await f
        .getBranchEvidence(reviewer.token, vendorId, branchIds[1])
        .expect(404);
      expect(none.body.error.code).toBe('NO_PENDING_BRANCH_EVIDENCE');

      // branch 1: decided (request_resubmission) -> no longer PENDING.
      await f
        .decideBranch(reviewer.token, vendorId, branchIds[0], {
          decision: 'request_resubmission',
          evidence_revision: 1,
          reason: 'Please retake the photo in daylight',
        })
        .expect(201);
      const decided = await f
        .getBranchEvidence(reviewer.token, vendorId, branchIds[0])
        .expect(404);
      expect(decided.body.error.code).toBe('NO_PENDING_BRANCH_EVIDENCE');

      // No audit row is written for a read that released nothing.
      expect(
        await ctx.prisma.auditLog.count({
          where: {
            action: 'branch_verification_evidence.viewed',
            entityId: { in: branchIds },
          },
        }),
      ).toBe(0);
    });

    it('treats a legacy row with a whitespace-only photo URL as incomplete: GET evidence is 404 NO_PENDING_BRANCH_EVIDENCE, approve is 400 BRANCH_EVIDENCE_INCOMPLETE, and neither writes a decision or an AuditLog row', async () => {
      const { reviewer, vendorId, branchIds } = await setup();
      // Simulate a legacy/direct-DB row: complete-looking except the
      // photo URL is whitespace-only, written outside submitEvidence()
      // (which always trims/validates via SubmitBranchEvidenceDto).
      await ctx.prisma.storeBranch.update({
        where: { id: branchIds[1] },
        data: {
          lat: 33.0,
          lng: 36.0,
          verificationPhotoUrl: '   ',
          verificationStatus: 'PENDING',
          evidenceRevision: 1,
          evidenceSubmittedAt: new Date(),
        },
      });

      const read = await f
        .getBranchEvidence(reviewer.token, vendorId, branchIds[1])
        .expect(404);
      expect(read.body.error.code).toBe('NO_PENDING_BRANCH_EVIDENCE');
      expect(
        await ctx.prisma.auditLog.count({
          where: {
            action: 'branch_verification_evidence.viewed',
            entityId: branchIds[1],
          },
        }),
      ).toBe(0);

      const approve = await f
        .decideBranch(reviewer.token, vendorId, branchIds[1], {
          decision: 'approve',
          evidence_revision: 1,
        })
        .expect(400);
      expect(approve.body.error.code).toBe('BRANCH_EVIDENCE_INCOMPLETE');
      const branch = await ctx.prisma.storeBranch.findUniqueOrThrow({
        where: { id: branchIds[1] },
      });
      expect(branch.verificationStatus).toBe('PENDING');
      expect(branch.reviewedBy).toBeNull();
      expect(
        await ctx.prisma.auditLog.count({
          where: {
            action: 'store_branch.verification_decided',
            entityId: branchIds[1],
          },
        }),
      ).toBe(0);
    });

    it('is path-safe: a branch of another vendor under this vendor id is 404, a non-physical branch is 400', async () => {
      const { reviewer, vendorId } = await setup();
      const otherOwner = await f.signup(f.uniquePhone(), 'a-strong-password');
      const { branchIds: otherBranches } = await f.createPhysicalVendor(
        otherOwner,
        1,
      );
      const mismatch = await f
        .getBranchEvidence(reviewer.token, vendorId, otherBranches[0])
        .expect(404);
      expect(mismatch.body.error.code).toBe('BRANCH_NOT_FOUND');

      const onlineOwner = await f.signup(f.uniquePhone(), 'a-strong-password');
      const { vendorId: onlineVendor } =
        await f.createOnlineOnlyVendor(onlineOwner);
      const nonPhysical = await ctx.prisma.storeBranch.findFirstOrThrow({
        where: { vendorId: onlineVendor },
      });
      const res = await f
        .getBranchEvidence(reviewer.token, onlineVendor, nonPhysical.id)
        .expect(400);
      expect(res.body.error.code).toBe('BRANCH_NOT_PHYSICAL');
    });

    it('is reviewer/admin only: the store owner, an employee, and a customer are all refused', async () => {
      const { owner, vendorId, branchIds } = await setup();
      const employeePhone = f.uniquePhone();
      const invite = await f.prepareStaffInvite(
        owner,
        vendorId,
        branchIds[0],
        employeePhone,
      );
      const accepted = await f
        .acceptStaffInvite(invite.phone, invite.verificationToken)
        .send({ password: 'a-strong-password' })
        .expect(200);
      const customer = await f.signup(f.uniquePhone(), 'a-strong-password');
      const admin = await f.platformUser('PLATFORM_ADMIN');

      for (const token of [
        owner,
        accepted.body.session_token as string,
        customer,
      ]) {
        await f.getBranchEvidence(token, vendorId, branchIds[0]).expect(403);
      }
      await f
        .getBranchEvidence(admin.token, vendorId, branchIds[0])
        .expect(200);
    });

    it('fails closed: if the audit row cannot be written the request fails and no evidence is released', async () => {
      const { reviewer, vendorId, branchIds } = await setup();
      const audit = ctx.app.get(AuditLogService);
      const original = audit.record.bind(audit);
      jest.spyOn(audit, 'record').mockImplementation((input, tx) => {
        if (input.action === 'branch_verification_evidence.viewed') {
          return Promise.reject(new Error('audit store down'));
        }
        return original(input, tx);
      });

      const res = await f
        .getBranchEvidence(reviewer.token, vendorId, branchIds[0])
        .expect(500);
      const serialized = JSON.stringify(res.body);
      for (const canary of ['32.111111', '35.222222', 'audit-canary-photo']) {
        expect(serialized).not.toContain(canary);
      }
      expect(
        await ctx.prisma.auditLog.count({
          where: {
            action: 'branch_verification_evidence.viewed',
            entityId: branchIds[0],
          },
        }),
      ).toBe(0);
    });
  });

  // ---------------------------------------------------------------
  describe('warehouse evidence read (GET .../warehouse/verification-evidence) - audited', () => {
    async function setup() {
      const reviewer = await f.platformUser('VERIFICATION_REVIEWER');
      const owner = await f.signup(f.uniquePhone(), 'a-strong-password');
      const { vendorId } = await f.createOnlineOnlyVendor(owner);
      await f.setWarehouse(owner, vendorId, {
        lat: 31.777777,
        lng: 35.888888,
        address_note: 'wh-audit-canary-note',
      });
      const submit = await f
        .submitWarehouseEvidence(owner, vendorId)
        .expect(201);
      return {
        reviewer,
        owner,
        vendorId,
        evidenceId: submit.body.id as string,
      };
    }

    it('audits the read (actor, evidence id, vendor id) without lat/lng/address', async () => {
      const { reviewer, vendorId, evidenceId } = await setup();
      const res = await f
        .getWarehouseEvidence(reviewer.token, vendorId)
        .expect(200);
      expect(res.body.lat).toBe(31.777777);

      const rows = await ctx.prisma.auditLog.findMany({
        where: {
          action: 'warehouse_verification_evidence.viewed',
          entityId: evidenceId,
        },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].actorId).toBe(reviewer.userId);
      expect(rows[0].afterState).toEqual({ vendor_id: vendorId });
      const serialized = JSON.stringify(rows[0]);
      for (const canary of ['31.777777', '35.888888', 'wh-audit-canary-note']) {
        expect(serialized).not.toContain(canary);
      }
    });

    it('fails closed: if the audit row cannot be written the address is never released', async () => {
      const { reviewer, vendorId, evidenceId } = await setup();
      const audit = ctx.app.get(AuditLogService);
      const original = audit.record.bind(audit);
      jest.spyOn(audit, 'record').mockImplementation((input, tx) => {
        if (input.action === 'warehouse_verification_evidence.viewed') {
          return Promise.reject(new Error('audit store down'));
        }
        return original(input, tx);
      });
      const res = await f
        .getWarehouseEvidence(reviewer.token, vendorId)
        .expect(500);
      const serialized = JSON.stringify(res.body);
      for (const canary of ['31.777777', '35.888888', 'wh-audit-canary-note']) {
        expect(serialized).not.toContain(canary);
      }
      expect(
        await ctx.prisma.auditLog.count({
          where: {
            action: 'warehouse_verification_evidence.viewed',
            entityId: evidenceId,
          },
        }),
      ).toBe(0);
    });
  });

  // ---------------------------------------------------------------
  describe('decisions: reason rules and evidence-revision binding', () => {
    async function setup() {
      const reviewer = await f.platformUser('VERIFICATION_REVIEWER');
      const owner = await f.signup(f.uniquePhone(), 'a-strong-password');
      const { vendorId, branchIds } = await f.createPhysicalVendor(owner, 1);
      await f.submitBranchEvidence(owner, vendorId, branchIds[0]).expect(201);
      return { reviewer, owner, vendorId, branchId: branchIds[0] };
    }

    it('branch: reject / request_resubmission need a trimmed 10-1000 char reason; approve must not carry one; every refusal is a 400 that changes nothing', async () => {
      const { reviewer, vendorId, branchId } = await setup();
      const bad: Record<string, unknown>[] = [
        { decision: 'reject', evidence_revision: 1 },
        { decision: 'reject', evidence_revision: 1, reason: '' },
        { decision: 'reject', evidence_revision: 1, reason: '   ' },
        { decision: 'reject', evidence_revision: 1, reason: '\t \n' },
        { decision: 'reject', evidence_revision: 1, reason: 'too short' },
        { decision: 'reject', evidence_revision: 1, reason: '  short 9  ' },
        { decision: 'reject', evidence_revision: 1, reason: 'x'.repeat(1001) },
        { decision: 'reject', evidence_revision: 1, reason: 12345678901 },
        { decision: 'request_resubmission', evidence_revision: 1 },
        {
          decision: 'request_resubmission',
          evidence_revision: 1,
          reason: '   ',
        },
        {
          decision: 'approve',
          evidence_revision: 1,
          reason: 'A note on approve',
        },
        { decision: 'approve', evidence_revision: 1, reason: '' },
        { decision: 'approve', evidence_revision: 1, reason: '   ' },
      ];
      for (const body of bad) {
        await f
          .decideBranch(reviewer.token, vendorId, branchId, body)
          .expect(400);
      }
      const branch = await ctx.prisma.storeBranch.findUniqueOrThrow({
        where: { id: branchId },
      });
      expect(branch.verificationStatus).toBe('PENDING');
      expect(branch.reviewNote).toBeNull();

      // Boundary: exactly 10 characters after trimming is accepted, and
      // the stored note is the trimmed value.
      const ok = await f
        .decideBranch(reviewer.token, vendorId, branchId, {
          decision: 'request_resubmission',
          evidence_revision: 1,
          reason: '   abcdefghij   ',
        })
        .expect(201);
      expect(ok.body.review_note).toBe('abcdefghij');
    });

    it('branch: evidence_revision is required and must be a positive integer', async () => {
      const { reviewer, vendorId, branchId } = await setup();
      for (const rev of [undefined, 0, -1, 1.5, '1', null]) {
        const body: Record<string, unknown> = { decision: 'approve' };
        if (rev !== undefined) body.evidence_revision = rev;
        await f
          .decideBranch(reviewer.token, vendorId, branchId, body)
          .expect(400);
      }
      await f
        .decideBranch(reviewer.token, vendorId, branchId, {
          decision: 'approve',
          evidence_revision: 1,
        })
        .expect(201);
    });

    it("branch: a resubmission between the reviewer's read and decision is a 409 BRANCH_EVIDENCE_STALE and the branch stays PENDING", async () => {
      const { reviewer, owner, vendorId, branchId } = await setup();
      const read = await f
        .getBranchEvidence(reviewer.token, vendorId, branchId)
        .expect(200);
      expect(read.body.evidence_revision).toBe(1);

      // The owner replaces the photo while the reviewer is still looking.
      const resubmit = await f
        .submitBranchEvidence(owner, vendorId, branchId, {
          verification_photo_url: 'https://example.com/replaced.jpg',
        })
        .expect(201);
      expect(resubmit.body.evidence_revision).toBe(2);

      const stale = await f
        .decideBranch(reviewer.token, vendorId, branchId, {
          decision: 'approve',
          evidence_revision: 1,
        })
        .expect(409);
      expect(stale.body.error.code).toBe('BRANCH_EVIDENCE_STALE');
      const branch = await ctx.prisma.storeBranch.findUniqueOrThrow({
        where: { id: branchId },
      });
      expect(branch.verificationStatus).toBe('PENDING');
      expect(branch.evidenceRevision).toBe(2);
      expect(
        await ctx.prisma.auditLog.count({
          where: {
            action: 'store_branch.verification_decided',
            entityId: branchId,
          },
        }),
      ).toBe(0);

      // Deciding on the revision actually read succeeds.
      const fresh = await f
        .getBranchEvidence(reviewer.token, vendorId, branchId)
        .expect(200);
      expect(fresh.body.evidence_revision).toBe(2);
      expect(fresh.body.photo_url).toBe('https://example.com/replaced.jpg');
      await f
        .decideBranch(reviewer.token, vendorId, branchId, {
          decision: 'approve',
          evidence_revision: 2,
        })
        .expect(201);
    });

    it('branch: every submission bumps the revision and stamps evidenceSubmittedAt; a resubmission after request_resubmission is PENDING at the next revision', async () => {
      const { reviewer, owner, vendorId, branchId } = await setup();
      const first = await ctx.prisma.storeBranch.findUniqueOrThrow({
        where: { id: branchId },
      });
      expect(first.evidenceRevision).toBe(1);
      expect(first.evidenceSubmittedAt).not.toBeNull();

      await f
        .decideBranch(reviewer.token, vendorId, branchId, {
          decision: 'request_resubmission',
          evidence_revision: 1,
          reason: 'Photo is too blurry to read',
        })
        .expect(201);
      const again = await f
        .submitBranchEvidence(owner, vendorId, branchId)
        .expect(201);
      expect(again.body.evidence_revision).toBe(2);
      expect(again.body.verification_status).toBe('PENDING');
      const second = await ctx.prisma.storeBranch.findUniqueOrThrow({
        where: { id: branchId },
      });
      expect(second.evidenceSubmittedAt!.getTime()).toBeGreaterThanOrEqual(
        first.evidenceSubmittedAt!.getTime(),
      );
    });

    it('branch: replaying a decision with the same Idempotency-Key returns the same result and writes exactly one decision', async () => {
      const { reviewer, vendorId, branchId } = await setup();
      const key = f.unique('decision-replay');
      const body = {
        decision: 'reject',
        evidence_revision: 1,
        reason: 'The photo shows a different storefront',
      };
      const first = await f
        .decideBranch(reviewer.token, vendorId, branchId, body, key)
        .expect(201);
      const replay = await f
        .decideBranch(reviewer.token, vendorId, branchId, body, key)
        .expect(201);
      expect(replay.body).toEqual(first.body);
      expect(
        await ctx.prisma.auditLog.count({
          where: {
            action: 'store_branch.verification_decided',
            entityId: branchId,
          },
        }),
      ).toBe(1);
      const different = await f.decideBranch(
        reviewer.token,
        vendorId,
        branchId,
        { ...body, reason: 'A completely different reason text' },
        key,
      );
      expect(different.status).toBeGreaterThanOrEqual(400);
      expect(different.status).toBeLessThan(500);
    });

    it('warehouse: same reason rules - reject / request_resubmission need one, approve must not carry one', async () => {
      const reviewer = await f.platformUser('VERIFICATION_REVIEWER');
      const owner = await f.signup(f.uniquePhone(), 'a-strong-password');
      const { vendorId } = await f.createOnlineOnlyVendor(owner);
      await f.setWarehouse(owner, vendorId);
      const ev = await f.submitWarehouseEvidence(owner, vendorId).expect(201);

      const bad: Record<string, unknown>[] = [
        { evidence_id: ev.body.id, decision: 'reject' },
        { evidence_id: ev.body.id, decision: 'reject', reason: '   ' },
        { evidence_id: ev.body.id, decision: 'reject', reason: 'too short' },
        { evidence_id: ev.body.id, decision: 'request_resubmission' },
        {
          evidence_id: ev.body.id,
          decision: 'request_resubmission',
          reason: '',
        },
        {
          evidence_id: ev.body.id,
          decision: 'reject',
          reason: 'x'.repeat(1001),
        },
        {
          evidence_id: ev.body.id,
          decision: 'approve',
          reason: 'A note on approve',
        },
        { evidence_id: ev.body.id, decision: 'approve', reason: '' },
      ];
      for (const body of bad) {
        await f.decideWarehouse(reviewer.token, vendorId, body).expect(400);
      }
      const row =
        await ctx.prisma.warehouseVerificationEvidence.findUniqueOrThrow({
          where: { id: ev.body.id },
        });
      expect(row.status).toBe('PENDING');

      const ok = await f
        .decideWarehouse(reviewer.token, vendorId, {
          evidence_id: ev.body.id,
          decision: 'request_resubmission',
          reason: '  Address note is missing the floor  ',
        })
        .expect(201);
      expect(ok.body.review_note).toBe('Address note is missing the floor');
    });
  });

  // ---------------------------------------------------------------
  describe("owner's verification-status (GET /vendors/:vendorId/verification-status)", () => {
    it("shows the owner each branch's status and the reviewer's reason, and clears the reason once the branch is resubmitted", async () => {
      const reviewer = await f.platformUser('VERIFICATION_REVIEWER');
      const owner = await f.signup(f.uniquePhone(), 'a-strong-password');
      const { vendorId, branchIds } = await f.createPhysicalVendor(owner, 2);
      await f.submitBranchEvidence(owner, vendorId, branchIds[0]).expect(201);
      await f
        .decideBranch(reviewer.token, vendorId, branchIds[0], {
          decision: 'request_resubmission',
          evidence_revision: 1,
          reason: 'Photo is too blurry to read',
        })
        .expect(201);

      const get = () =>
        request(http())
          .get(`/api/v1/vendors/${vendorId}/verification-status`)
          .set('Authorization', `Bearer ${owner}`)
          .expect(200);
      const res = await get();
      expect(res.body.vendor).toMatchObject({
        id: vendorId,
        status: 'UNDER_REVIEW',
      });
      const [b1, b2] = res.body.branches;
      expect(b1).toMatchObject({
        id: branchIds[0],
        status: 'RESUBMISSION_REQUESTED',
        evidence_submitted: true,
        review_note: 'Photo is too blurry to read',
      });
      expect(b2).toMatchObject({
        id: branchIds[1],
        status: 'PENDING',
        evidence_submitted: false,
        review_note: null,
      });
      expect(res.body.warehouse).toBeNull();
      expect(res.body.suspension).toBeNull();

      await f.submitBranchEvidence(owner, vendorId, branchIds[0]).expect(201);
      const after = await get();
      expect(after.body.branches[0]).toMatchObject({
        status: 'PENDING',
        review_note: null,
      });
    });

    it('shows an ONLINE_ONLY owner the latest warehouse decision and reason - never lat/lng/address_note and never who reviewed it', async () => {
      const reviewer = await f.platformUser('VERIFICATION_REVIEWER');
      const owner = await f.signup(f.uniquePhone(), 'a-strong-password');
      const { vendorId } = await f.createOnlineOnlyVendor(owner);
      await f.setWarehouse(owner, vendorId, {
        lat: 31.424242,
        lng: 35.313131,
        address_note: 'status-canary-address',
      });
      const ev = await f.submitWarehouseEvidence(owner, vendorId).expect(201);
      await f
        .decideWarehouse(reviewer.token, vendorId, {
          evidence_id: ev.body.id,
          decision: 'request_resubmission',
          reason: 'Please add the building number',
        })
        .expect(201);

      const res = await request(http())
        .get(`/api/v1/vendors/${vendorId}/verification-status`)
        .set('Authorization', `Bearer ${owner}`)
        .expect(200);
      expect(res.body.warehouse).toEqual({
        status: 'RESUBMISSION_REQUESTED',
        submitted_at: expect.any(String),
        reviewed_at: expect.any(String),
        review_note: 'Please add the building number',
      });
      expect(res.body.branches).toEqual([]);
      const serialized = JSON.stringify(res.body);
      for (const canary of [
        '31.424242',
        '35.313131',
        'status-canary-address',
        reviewer.userId,
      ]) {
        expect(serialized).not.toContain(canary);
      }
      const keys = allKeys(res.body);
      for (const k of [...EVIDENCE_KEYS, 'reviewed_by', 'warehouse_id']) {
        expect(keys.has(k)).toBe(false);
      }
    });

    it("is owner-only: an employee (VENDOR_ROLE_FORBIDDEN), another store's owner and a platform reviewer (NOT_VENDOR_MEMBER) are all refused, and it needs a session", async () => {
      const reviewer = await f.platformUser('VERIFICATION_REVIEWER');
      const owner = await f.signup(f.uniquePhone(), 'a-strong-password');
      const { vendorId, branchIds } = await f.createPhysicalVendor(owner, 1);
      const invite = await f.prepareStaffInvite(
        owner,
        vendorId,
        branchIds[0],
        f.uniquePhone(),
      );
      const accepted = await f
        .acceptStaffInvite(invite.phone, invite.verificationToken)
        .send({ password: 'a-strong-password' })
        .expect(200);
      const otherOwner = await f.signup(f.uniquePhone(), 'a-strong-password');
      await f.createPhysicalVendor(otherOwner, 1);

      const url = `/api/v1/vendors/${vendorId}/verification-status`;
      const employee = await request(http())
        .get(url)
        .set('Authorization', `Bearer ${accepted.body.session_token as string}`)
        .expect(403);
      expect(employee.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');
      for (const token of [otherOwner, reviewer.token]) {
        const res = await request(http())
          .get(url)
          .set('Authorization', `Bearer ${token}`)
          .expect(403);
        expect(res.body.error.code).toBe('NOT_VENDOR_MEMBER');
      }
      await request(http()).get(url).expect(401);
    });
  });

  // ---------------------------------------------------------------
  describe('conflict of interest (D4), sequential half', () => {
    it('a reviewer who is a member of the store cannot decide its branch evidence: 403 PLATFORM_VENDOR_CONFLICT_OF_INTEREST, nothing changes', async () => {
      const reviewer = await f.platformUser('VERIFICATION_REVIEWER');
      const owner = await f.signup(f.uniquePhone(), 'a-strong-password');
      const { vendorId, branchIds } = await f.createPhysicalVendor(owner, 1);
      await f.submitBranchEvidence(owner, vendorId, branchIds[0]).expect(201);
      await ctx.prisma.vendorUser.create({
        data: { userId: reviewer.userId, vendorId, role: 'OWNER' },
      });

      const res = await f
        .decideBranch(reviewer.token, vendorId, branchIds[0], {
          decision: 'approve',
          evidence_revision: 1,
        })
        .expect(403);
      expect(res.body.error.code).toBe('PLATFORM_VENDOR_CONFLICT_OF_INTEREST');
      const branch = await ctx.prisma.storeBranch.findUniqueOrThrow({
        where: { id: branchIds[0] },
      });
      expect(branch.verificationStatus).toBe('PENDING');
      expect(
        await ctx.prisma.auditLog.count({
          where: {
            action: 'store_branch.verification_decided',
            entityId: branchIds[0],
          },
        }),
      ).toBe(0);
      const vendor = await ctx.prisma.vendor.findUniqueOrThrow({
        where: { id: vendorId },
      });
      expect(vendor.status).toBe('UNDER_REVIEW');
    });

    it('a platform ADMIN who became a branch employee via a real invite is refused the same way, on both the branch and the warehouse path', async () => {
      const admin = await f.platformUser('PLATFORM_ADMIN');
      const owner = await f.signup(f.uniquePhone(), 'a-strong-password');
      const { vendorId, branchIds } = await f.createPhysicalVendor(owner, 1);
      await f.submitBranchEvidence(owner, vendorId, branchIds[0]).expect(201);
      const invite = await f.prepareStaffInvite(
        owner,
        vendorId,
        branchIds[0],
        admin.phone,
      );
      await f
        .acceptStaffInvite(invite.phone, invite.verificationToken)
        .expect(200);

      const branchRes = await f
        .decideBranch(admin.token, vendorId, branchIds[0], {
          decision: 'approve',
          evidence_revision: 1,
        })
        .expect(403);
      expect(branchRes.body.error.code).toBe(
        'PLATFORM_VENDOR_CONFLICT_OF_INTEREST',
      );

      // Warehouse path, on a second store the same admin is a member of.
      const owner2 = await f.signup(f.uniquePhone(), 'a-strong-password');
      const { vendorId: vendor2 } = await f.createOnlineOnlyVendor(owner2);
      await f.setWarehouse(owner2, vendor2);
      const ev = await f.submitWarehouseEvidence(owner2, vendor2).expect(201);
      await ctx.prisma.vendorUser.create({
        data: { userId: admin.userId, vendorId: vendor2, role: 'OWNER' },
      });
      const whRes = await f
        .decideWarehouse(admin.token, vendor2, {
          evidence_id: ev.body.id,
          decision: 'approve',
        })
        .expect(403);
      expect(whRes.body.error.code).toBe(
        'PLATFORM_VENDOR_CONFLICT_OF_INTEREST',
      );
      const row =
        await ctx.prisma.warehouseVerificationEvidence.findUniqueOrThrow({
          where: { id: ev.body.id },
        });
      expect(row.status).toBe('PENDING');
    });

    it('a reviewer who is NOT a member of the store can still decide (the rule is about membership, not the platform role)', async () => {
      const reviewer = await f.platformUser('VERIFICATION_REVIEWER');
      const owner = await f.signup(f.uniquePhone(), 'a-strong-password');
      const { vendorId, branchIds } = await f.createPhysicalVendor(owner, 1);
      await f.submitBranchEvidence(owner, vendorId, branchIds[0]).expect(201);
      // A membership in a DIFFERENT store must not matter.
      const otherOwner = await f.signup(f.uniquePhone(), 'a-strong-password');
      const { vendorId: otherVendor } = await f.createPhysicalVendor(
        otherOwner,
        1,
      );
      await ctx.prisma.vendorUser.create({
        data: { userId: reviewer.userId, vendorId: otherVendor, role: 'OWNER' },
      });
      await f
        .decideBranch(reviewer.token, vendorId, branchIds[0], {
          decision: 'approve',
          evidence_revision: 1,
        })
        .expect(201);
    });
  });
});
