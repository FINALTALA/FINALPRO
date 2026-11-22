import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { uniqueTestPhone } from './helpers/test-phone';

// Security fix: VendorMembershipGuard used to read @RequireVendorRole from
// the handler only, so a CLASS-level @RequireVendorRole('OWNER') was
// silently ignored - a BRANCH_EMPLOYEE could list and suspend staff
// (StaffController) and read the owner-only performance report
// (VendorPerformanceController). These tests pin the fix: a branch
// employee is refused on every route of both controllers, nothing
// changes, and the owner still gets through. Users are inserted
// directly with a SessionService session (no OTP, so no phone lane);
// their phones use a +999 prefix no lane draws from.
const FLAG_KEY = 'vendor_performance_dashboard_enabled';
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

describe('Class-level @RequireVendorRole is enforced (e2e)', () => {
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
    await prisma.featureFlag.deleteMany({ where: { key: FLAG_KEY } });
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
    const vendorUser = await prisma.vendorUser.create({
      data: { userId: user.id, vendorId, role, branchId },
    });
    const token = await app.get(SessionService).create({
      userId: user.id,
      phone,
      phoneVerifiedAt: user.phoneVerifiedAt!.toISOString(),
      sessionVersion: user.sessionVersion,
    });
    return { vendorUser, token };
  }

  async function store() {
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('guard-store'),
        legalName: unique('Legal'),
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
      },
    });
    const branchA = await prisma.storeBranch.create({
      data: { vendorId: vendor.id, name: 'A' },
    });
    const branchB = await prisma.storeBranch.create({
      data: { vendorId: vendor.id, name: 'B' },
    });
    const owner = await member(vendor.id, 'OWNER');
    const employee = await member(vendor.id, 'BRANCH_EMPLOYEE', branchA.id);
    const colleague = await member(vendor.id, 'BRANCH_EMPLOYEE', branchA.id);
    return { vendor, branchA, branchB, owner, employee, colleague };
  }

  describe('StaffController', () => {
    it('a branch employee cannot list, transfer, suspend or reactivate staff, and nothing changes', async () => {
      const s = await store();
      const base = `/api/v1/vendors/${s.vendor.id}/staff`;
      const target = s.colleague.vendorUser.id;
      const asEmployee = (
        req: request.Test,
        body?: object,
      ): Promise<request.Response> =>
        req
          .set('Authorization', `Bearer ${s.employee.token}`)
          .set('Idempotency-Key', unique('guard'))
          .send(body ?? {});

      const list = await asEmployee(request(http()).get(base));
      expect(list.status).toBe(403);
      expect(list.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');
      for (const [path, body] of [
        [`${base}/${target}/transfer`, { branch_id: s.branchB.id }],
        [`${base}/${target}/suspend`, {}],
        [`${base}/${target}/reactivate`, {}],
      ] as const) {
        const res = await asEmployee(request(http()).post(path), body);
        expect({ path, status: res.status }).toEqual({ path, status: 403 });
        expect(res.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');
      }

      const colleague = await prisma.vendorUser.findUniqueOrThrow({
        where: { id: target },
      });
      expect(colleague.status).toBe('ACTIVE');
      expect(colleague.branchId).toBe(s.branchA.id);
    });

    it('the owner still manages staff', async () => {
      const s = await store();
      await request(http())
        .get(`/api/v1/vendors/${s.vendor.id}/staff`)
        .set('Authorization', `Bearer ${s.owner.token}`)
        .expect(200);
      await request(http())
        .post(
          `/api/v1/vendors/${s.vendor.id}/staff/${s.colleague.vendorUser.id}/suspend`,
        )
        .set('Authorization', `Bearer ${s.owner.token}`)
        .set('Idempotency-Key', unique('guard'))
        .send({})
        .expect((r) => expect(r.status).toBeLessThan(300));
      const colleague = await prisma.vendorUser.findUniqueOrThrow({
        where: { id: s.colleague.vendorUser.id },
      });
      expect(colleague.status).toBe('SUSPENDED');
    });
  });

  describe('VendorPerformanceController', () => {
    async function enableFlag() {
      await prisma.featureFlag.upsert({
        where: { key: FLAG_KEY },
        create: { key: FLAG_KEY, enabled: true, description: 'test' },
        update: { enabled: true },
      });
    }

    it('a branch employee cannot read the owner-only performance report', async () => {
      const s = await store();
      await enableFlag();
      const res = await request(http())
        .get(`/api/v1/vendors/${s.vendor.id}/performance`)
        .set('Authorization', `Bearer ${s.employee.token}`)
        .expect(403);
      expect(res.body.error.code).toBe('VENDOR_ROLE_FORBIDDEN');
      expect(res.body).not.toHaveProperty('cancellation_rate');
    });

    it('the owner still reads it', async () => {
      const s = await store();
      await enableFlag();
      const res = await request(http())
        .get(`/api/v1/vendors/${s.vendor.id}/performance`)
        .set('Authorization', `Bearer ${s.owner.token}`)
        .expect(200);
      expect(res.body.vendor_id).toBe(s.vendor.id);
    });
  });
});
