import { execFileSync } from 'child_process';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { API_ROOT } from './helpers/seed-demo-db';
import {
  createDisposableDatabase,
  dropDisposableDatabase,
} from './helpers/test-databases';
import { uniqueTestPhone } from './helpers/test-phone';

// VIA Control Center phase 2B - the Approval Center's counts
// (GET /admin/approval-center/summary) over the seven EXISTING sources.
// Runs on its OWN new, marked database so every count is exact: each
// source gets items that must count and items that must not (decided,
// not decidable, the user's own conflict), and every count is checked
// against that source's own list endpoint.

const DAY = 86_400_000;
let seq = 0;
const unique = (label: string) => `${label}-${Date.now()}-${++seq}`;

describe('Phase 2B - Approval Center (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const sharedUrl = process.env.DATABASE_URL!;
  const dbName = `finalpro_approval_center_test_${process.pid}`;

  beforeAll(async () => {
    const url = await createDisposableDatabase(sharedUrl, dbName);
    execFileSync(
      process.execPath,
      [
        require.resolve('prisma/build/index.js'),
        'migrate',
        'deploy',
        '--config',
        'prisma7.config.ts',
      ],
      {
        cwd: API_ROOT,
        env: { ...process.env, DATABASE_URL: url },
        stdio: 'pipe',
      },
    );
    process.env.DATABASE_URL = url;
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
    await seedWorld();
  }, 180_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await app?.close();
    process.env.DATABASE_URL = sharedUrl;
    await dropDisposableDatabase(sharedUrl, dbName);
  }, 120_000);

  const http = () => app.getHttpServer();
  const get = (path: string, token: string) =>
    request(http())
      .get(`/api/v1${path}`)
      .set('Authorization', `Bearer ${token}`);

  async function account(
    platformRole: 'PLATFORM_ADMIN' | 'VERIFICATION_REVIEWER' | null,
  ) {
    const phone = uniqueTestPhone();
    const user = await prisma.user.create({
      data: {
        phone,
        passwordHash: 'x',
        phoneVerifiedAt: new Date(),
        platformRole,
      },
    });
    const profile = await prisma.customerProfile.create({
      data: { userId: user.id },
    });
    const token = await app.get(SessionService).create({
      userId: user.id,
      phone,
      phoneVerifiedAt: user.phoneVerifiedAt!.toISOString(),
      sessionVersion: user.sessionVersion,
    });
    return { id: user.id, profileId: profile.id, token };
  }

  const vendor = (
    status: 'UNDER_REVIEW' | 'ACTIVE' | 'REJECTED',
    storeType: 'PHYSICAL' | 'ONLINE_ONLY' = 'PHYSICAL',
  ) =>
    prisma.vendor.create({
      data: {
        slug: unique('ac').toLowerCase(),
        legalName: unique('متجر'),
        status,
        storeType,
        subscriptionStatus: status === 'ACTIVE' ? 'ACTIVE' : 'NONE',
      },
    });

  const pendingBranch = (vendorId: string, extra: object = {}) =>
    prisma.storeBranch.create({
      data: {
        vendorId,
        name: unique('فرع'),
        isPhysical: true,
        lat: 31.9,
        lng: 35.2,
        verificationPhotoUrl: 'https://example.com/p.jpg',
        verificationStatus: 'PENDING',
        evidenceRevision: 1,
        evidenceSubmittedAt: new Date(),
        ...extra,
      },
    });

  let admin: Awaited<ReturnType<typeof account>>;
  let reviewer: Awaited<ReturnType<typeof account>>;
  let customer: Awaited<ReturnType<typeof account>>;
  const ids: Record<string, string> = {};

  async function seedWorld() {
    admin = await account('PLATFORM_ADMIN');
    reviewer = await account('VERIFICATION_REVIEWER');
    customer = await account(null);
    const owner = await account(null);

    // --- 1/2: verification -------------------------------------------
    const initial = await vendor('UNDER_REVIEW');
    ids.initialBranch = (await pendingBranch(initial.id)).id; // counts
    const live = await vendor('ACTIVE');
    await prisma.storeBranch.create({
      data: {
        vendorId: live.id,
        name: unique('فرع معتمد'),
        isPhysical: true,
        verificationStatus: 'APPROVED',
      },
    });
    ids.lateBranch = (await pendingBranch(live.id)).id; // counts (late branch, ACTIVE store)
    await pendingBranch(live.id, { archivedAt: new Date() }); // archived: never decidable
    const rejected = await vendor('REJECTED');
    await pendingBranch(rejected.id); // closed application: not decidable
    const own = await vendor('UNDER_REVIEW'); // the admin is a member: D4
    await prisma.vendorUser.create({
      data: { vendorId: own.id, userId: admin.id, role: 'OWNER' },
    });
    ids.adminOwnBranch = (await pendingBranch(own.id)).id;

    const online = await vendor('UNDER_REVIEW', 'ONLINE_ONLY');
    const warehouse = await prisma.warehouse.create({
      data: { vendorId: online.id, lat: 31.9, lng: 35.2, addressNote: 'x' },
    });
    ids.warehouseEvidence = (
      await prisma.warehouseVerificationEvidence.create({
        data: {
          vendorId: online.id,
          warehouseId: warehouse.id,
          lat: 31.9,
          lng: 35.2,
          addressNote: 'x',
          submittedAt: new Date(Date.now() - DAY),
        },
      })
    ).id; // counts
    const onlineDecided = await vendor('UNDER_REVIEW', 'ONLINE_ONLY');
    const w2 = await prisma.warehouse.create({
      data: { vendorId: onlineDecided.id, lat: 1, lng: 1, addressNote: 'y' },
    });
    await prisma.warehouseVerificationEvidence.create({
      data: {
        vendorId: onlineDecided.id,
        warehouseId: w2.id,
        lat: 1,
        lng: 1,
        addressNote: 'y',
        status: 'RESUBMISSION_REQUESTED',
      },
    }); // decided: not counted

    // A store with a catalogue for the other sources.
    const shop = await vendor('ACTIVE');
    await prisma.vendorUser.create({
      data: { vendorId: shop.id, userId: owner.id, role: 'OWNER' },
    });
    const branch = await prisma.storeBranch.create({
      data: {
        vendorId: shop.id,
        name: unique('الفرع'),
        isPhysical: true,
        verificationStatus: 'APPROVED',
      },
    });
    const brand = await prisma.brand.create({
      data: { name: unique('Brand'), normalizedName: unique('brand') },
    });
    const category = await prisma.category.create({
      data: { nameAr: unique('تصنيف'), nameEn: unique('Category') },
    });
    const product = await prisma.canonicalProduct.create({
      data: {
        brandId: brand.id,
        categoryId: category.id,
        modelName: unique('Model'),
        canonicalNameAr: 'منتج',
        canonicalNameEn: 'Product',
        status: 'PUBLISHED',
      },
    });
    const offer = await prisma.vendorOffer.create({
      data: {
        vendorId: shop.id,
        titleAr: 'عرض',
        titleEn: 'Offer',
        status: 'ACTIVE',
      },
    });
    const variant = await prisma.offerVariant.create({
      data: {
        vendorId: shop.id,
        vendorOfferId: offer.id,
        sellerSku: unique('sku'),
        storeInventoryBarcode: unique('sib'),
        basePrice: 50,
      },
    });

    // --- 3: name changes: 2 pending, 1 decided --------------------------
    for (const status of ['PENDING', 'PENDING', 'APPROVED'] as const) {
      await prisma.canonicalNameChangeRequest.create({
        data: {
          canonicalProductId: product.id,
          vendorId: shop.id,
          requestedNameAr: unique('اسم'),
          requestedNameEn: unique('Name'),
          status,
          ...(status === 'APPROVED'
            ? { decidedAt: new Date(), decidedById: admin.id }
            : {}),
        },
      });
    }

    // --- 4: brand requests: 1 pending, 1 rejected -----------------------
    for (const status of ['PENDING', 'REJECTED'] as const) {
      await prisma.brandRequest.create({
        data: {
          vendorId: shop.id,
          requestedByUserId: owner.id,
          name: unique('NewBrand'),
          normalizedName: unique('newbrand'),
          status,
          ...(status === 'REJECTED'
            ? {
                decidedAt: new Date(),
                decidedByUserId: admin.id,
                rejectionReason: 'duplicate',
              }
            : {}),
        },
      });
    }

    // --- 7: size guide requests: 1 pending, 1 resolved -----------------
    for (const status of ['PENDING', 'REJECTED'] as const) {
      await prisma.sizeGuideRequest.create({
        data: {
          vendorId: shop.id,
          vendorOfferId: offer.id,
          requestedById: owner.id,
          message: unique('نحتاج دليل مقاسات'),
          status,
          ...(status === 'REJECTED'
            ? { decidedAt: new Date(), decidedById: admin.id }
            : {}),
        },
      });
    }

    // Order items for reviews and returns.
    const orderItem = async (buyerProfileId: string) => {
      const co = await prisma.customerOrder.create({
        data: { customerId: buyerProfileId },
      });
      const bo = await prisma.branchOrder.create({
        data: {
          customerOrderId: co.id,
          vendorId: shop.id,
          branchId: branch.id,
          fulfilmentMethod: 'PICKUP',
          paymentMethod: 'COD',
          status: 'COMPLETED',
          subtotal: 50,
          total: 50,
          pickupCode: String(100000 + seq++),
        },
      });
      return prisma.branchOrderItem.create({
        data: {
          vendorId: shop.id,
          branchOrderId: bo.id,
          offerVariantId: variant.id,
          quantity: 1,
          unitPrice: 50,
        },
      });
    };

    // --- 5: reported reviews: one review with TWO pending reports counts
    // once; a review whose only report was dismissed and a deleted review
    // do not count.
    const review = async (extra: object = {}) =>
      prisma.review.create({
        data: {
          customerId: customer.profileId,
          sourceBranchOrderItemId: (await orderItem(customer.profileId)).id,
          targetType: 'STORE',
          vendorId: shop.id,
          rating: 2,
          body: unique('مراجعة'),
          ...extra,
        },
      });
    const reported = await review();
    ids.reportedReview = reported.id;
    for (let i = 0; i < 2; i++) {
      const reporter = await account(null);
      await prisma.reviewReport.create({
        data: {
          reviewId: reported.id,
          reporterId: reporter.profileId,
          reason: 'SPAM',
        },
      });
    }
    const dismissed = await review();
    await prisma.reviewReport.create({
      data: {
        reviewId: dismissed.id,
        reporterId: owner.profileId,
        reason: 'SPAM',
        status: 'DISMISSED',
        decidedAt: new Date(),
        decidedByUserId: admin.id,
      },
    });
    const deleted = await review({ deletedAt: new Date() });
    await prisma.reviewReport.create({
      data: {
        reviewId: deleted.id,
        reporterId: owner.profileId,
        reason: 'SPAM',
      },
    });

    // --- 6: escalated returns: 2 escalated (one on the ADMIN's own order
    // - TB-28, not theirs to decide), 1 merely requested.
    const ret = async (
      buyerProfileId: string,
      status: 'ESCALATED' | 'REQUESTED',
    ) => {
      const item = await orderItem(buyerProfileId);
      return prisma.return.create({
        data: {
          vendorId: shop.id,
          branchOrderItemId: item.id,
          reason: 'DAMAGED',
          status,
          vendorReviewDueAt: new Date(Date.now() + DAY),
          escalatedAt: status === 'ESCALATED' ? new Date() : null,
        },
      });
    };
    ids.escalatedReturn = (await ret(customer.profileId, 'ESCALATED')).id;
    ids.adminOwnReturn = (await ret(admin.profileId, 'ESCALATED')).id;
    await ret(customer.profileId, 'REQUESTED');
  }

  interface SourceRow {
    source: string;
    status: string;
    pending: number | null;
    oldest_at: string | null;
    excluded_self?: number;
  }
  const bySource = (body: {
    sources: SourceRow[];
  }): Record<string, SourceRow> =>
    Object.fromEntries(body.sources.map((s) => [s.source, s]));

  it('PLATFORM_ADMIN: all seven sources, each counting only what this admin can decide, each record once', async () => {
    const res = await get('/admin/approval-center/summary', admin.token).expect(
      200,
    );
    expect(res.body.role).toBe('PLATFORM_ADMIN');
    expect(res.body.sources.map((s: { source: string }) => s.source)).toEqual([
      'BRANCH_VERIFICATION',
      'WAREHOUSE_VERIFICATION',
      'NAME_CHANGE',
      'BRAND_REQUEST',
      'REPORTED_REVIEW',
      'ESCALATED_RETURN',
      'SIZE_GUIDE_REQUEST',
    ]);
    const s = bySource(res.body);
    for (const v of Object.values(s)) expect(v.status).toBe('AVAILABLE');
    expect(s.BRANCH_VERIFICATION.pending).toBe(2); // initial + late (not own, archived, rejected)
    expect(s.WAREHOUSE_VERIFICATION.pending).toBe(1);
    expect(s.NAME_CHANGE.pending).toBe(2);
    expect(s.BRAND_REQUEST.pending).toBe(1);
    expect(s.REPORTED_REVIEW.pending).toBe(1); // two reports, one decision target
    expect(s.ESCALATED_RETURN.pending).toBe(1);
    expect(s.ESCALATED_RETURN.excluded_self).toBe(1);
    expect(s.SIZE_GUIDE_REQUEST.pending).toBe(1);
    expect(res.body.total).toBe(9);
    expect(res.body.partial).toBe(false);
    for (const v of Object.values(s))
      expect(v.oldest_at).toEqual(expect.any(String));
  });

  it("every count matches its source's own list (the lists the tabs show)", async () => {
    const s = bySource(
      (await get('/admin/approval-center/summary', admin.token).expect(200))
        .body,
    );
    const branchQueue = await get(
      '/admin/verification-queue?status=pending&kind=BRANCH&limit=50',
      admin.token,
    ).expect(200);
    expect(
      branchQueue.body.items.map((i: { item_id: string }) => i.item_id).sort(),
    ).toEqual([ids.initialBranch, ids.lateBranch].sort());
    expect(
      branchQueue.body.items.find(
        (i: { item_id: string }) => i.item_id === ids.lateBranch,
      ).vendor_status,
    ).toBe('ACTIVE');
    const whQueue = await get(
      '/admin/verification-queue?status=pending&kind=WAREHOUSE&limit=50',
      admin.token,
    ).expect(200);
    expect(
      whQueue.body.items.map((i: { item_id: string }) => i.item_id),
    ).toEqual([ids.warehouseEvidence]);
    expect(s.BRANCH_VERIFICATION.pending).toBe(branchQueue.body.items.length);
    expect(s.WAREHOUSE_VERIFICATION.pending).toBe(whQueue.body.items.length);
    expect(
      (
        await get(
          '/canonical-products/name-change-requests',
          admin.token,
        ).expect(200)
      ).body,
    ).toHaveLength(s.NAME_CHANGE.pending!);
    expect(
      (
        await get('/admin/brand-requests?status=PENDING', admin.token).expect(
          200,
        )
      ).body.items,
    ).toHaveLength(s.BRAND_REQUEST.pending!);
    const reviews = (
      await get('/admin/reviews/reported', admin.token).expect(200)
    ).body;
    expect(reviews.map((r: { id: string }) => r.id)).toEqual([
      ids.reportedReview,
    ]);
    expect(reviews[0].pending_reports).toHaveLength(2);
    // The returns list shows every escalated return; the count leaves out
    // the admin's own (excluded_self) - together they are the list.
    const returns = (await get('/admin/returns', admin.token).expect(200)).body;
    expect(returns).toHaveLength(
      s.ESCALATED_RETURN.pending! + s.ESCALATED_RETURN.excluded_self!,
    );
    expect(
      (
        await get(
          '/admin/size-guide-requests?status=PENDING',
          admin.token,
        ).expect(200)
      ).body,
    ).toHaveLength(s.SIZE_GUIDE_REQUEST.pending!);
  });

  it('the queue without kind is unchanged; kind narrows it; a bad kind is refused', async () => {
    const all = await get(
      '/admin/verification-queue?status=pending&limit=50',
      admin.token,
    ).expect(200);
    expect(all.body.items.map((i: { kind: string }) => i.kind).sort()).toEqual([
      'BRANCH',
      'BRANCH',
      'WAREHOUSE',
    ]);
    const bad = await get('/admin/verification-queue?kind=OTHER', admin.token);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_KIND_FILTER');
  });

  it('VERIFICATION_REVIEWER: only the two verification sources, and the other sources stay closed to it', async () => {
    const res = await get(
      '/admin/approval-center/summary',
      reviewer.token,
    ).expect(200);
    expect(res.body.role).toBe('VERIFICATION_REVIEWER');
    const s = bySource(res.body);
    expect(Object.keys(s)).toEqual([
      'BRANCH_VERIFICATION',
      'WAREHOUSE_VERIFICATION',
    ]);
    // The reviewer is not a member of the admin's store: it is theirs.
    expect(s.BRANCH_VERIFICATION.pending).toBe(3);
    expect(s.WAREHOUSE_VERIFICATION.pending).toBe(1);
    expect(res.body.total).toBe(4);
    for (const path of [
      '/canonical-products/name-change-requests',
      '/admin/brand-requests?status=PENDING',
      '/admin/reviews/reported',
      '/admin/returns',
      '/admin/size-guide-requests?status=PENDING',
    ]) {
      expect((await get(path, reviewer.token)).status).toBe(403);
    }
  });

  it('a customer is refused, a visitor must sign in', async () => {
    expect(
      (await get('/admin/approval-center/summary', customer.token)).status,
    ).toBe(403);
    expect(
      (await request(http()).get('/api/v1/admin/approval-center/summary'))
        .status,
    ).toBe(401);
  });

  it('a failing source is UNAVAILABLE (no number) and the total is partial; an empty one is AVAILABLE with 0', async () => {
    const spy = jest
      .spyOn(prisma.brandRequest, 'count')
      .mockRejectedValueOnce(new Error('simulated source failure'));
    const res = await get('/admin/approval-center/summary', admin.token).expect(
      200,
    );
    spy.mockRestore();
    const s = bySource(res.body);
    expect(s.BRAND_REQUEST).toMatchObject({
      status: 'UNAVAILABLE',
      pending: null,
      oldest_at: null,
    });
    expect(res.body.partial).toBe(true);
    expect(res.body.total).toBe(8); // the other six still count

    await prisma.sizeGuideRequest.updateMany({
      where: { status: 'PENDING' },
      data: {
        status: 'REJECTED',
        decidedAt: new Date(),
        decidedById: admin.id,
      },
    });
    const empty = bySource(
      (await get('/admin/approval-center/summary', admin.token).expect(200))
        .body,
    );
    expect(empty.SIZE_GUIDE_REQUEST).toMatchObject({
      status: 'AVAILABLE',
      pending: 0,
      oldest_at: null,
    });
  });

  it('a decision made in its source leaves the inbox at once (no copy is kept)', async () => {
    const before = bySource(
      (await get('/admin/approval-center/summary', reviewer.token).expect(200))
        .body,
    );
    const branch = await prisma.storeBranch.findUniqueOrThrow({
      where: { id: ids.initialBranch },
    });
    await request(http())
      .post(
        `/api/v1/vendors/${branch.vendorId}/branches/${branch.id}/verification-decision`,
      )
      .set('Authorization', `Bearer ${reviewer.token}`)
      .set('Idempotency-Key', unique('decide'))
      .send({ decision: 'approve', evidence_revision: 1 })
      .expect(201);
    const after = bySource(
      (await get('/admin/approval-center/summary', reviewer.token).expect(200))
        .body,
    );
    expect(after.BRANCH_VERIFICATION.pending).toBe(
      before.BRANCH_VERIFICATION.pending! - 1,
    );
  });
});
