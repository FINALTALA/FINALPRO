import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { ProductAudience } from '../generated/prisma/client';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { SalesRankSweepService } from './../src/sales-rank/sales-rank-sweep.service';
import { SalesRankService } from './../src/sales-rank/sales-rank.service';

// PD-5.2 (PD-FR-005): the internal sales-rank snapshot - which units
// count (completed, not cancelled/refunded/returned/exchanged, sold in
// the last 30 days, not bought by the store's own people, not a
// suspended store), ranking and qualification, offer vs canonical
// scope (archived offers, merges), idempotent/concurrent rebuilds and
// the admin-only surface. Each test uses its own taxonomy scope, since
// a rebuild ranks everything in the database.
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

describe('PD-5.2 sales rank snapshot (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let salesRank: SalesRankService;

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
    salesRank = app.get(SalesRankService);
  });

  afterEach(async () => {
    await app.close();
  });

  const call = (
    method: 'get' | 'post',
    url: string,
    token: string | null,
    idem = true,
  ) => {
    let r = request(app.getHttpServer())[method](`/api/v1${url}`);
    if (method !== 'get' && idem) r = r.set('Idempotency-Key', unique('idem'));
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };

  async function account(platformRole?: 'PLATFORM_ADMIN') {
    const phone = `+997${Date.now()}${(counter += 1)}`;
    const user = await prisma.user.create({
      data: {
        phone,
        passwordHash: 'not-used',
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
    return { token, userId: user.id, customerId: profile.id };
  }
  type Account = Awaited<ReturnType<typeof account>>;

  async function store() {
    const owner = await account();
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('rank-store').toLowerCase(),
        legalName: unique('Legal'),
        displayName: 'متجر',
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        storefrontPublished: true,
      },
    });
    await prisma.vendorUser.create({
      data: { userId: owner.userId, vendorId: vendor.id, role: 'OWNER' },
    });
    const branch = await prisma.storeBranch.create({
      data: {
        vendorId: vendor.id,
        name: unique('فرع'),
        isPhysical: true,
        verificationStatus: 'APPROVED',
      },
    });
    const employee = await account();
    await prisma.vendorUser.create({
      data: {
        userId: employee.userId,
        vendorId: vendor.id,
        role: 'BRANCH_EMPLOYEE',
        branchId: branch.id,
      },
    });
    return { vendor, branch, owner, employee };
  }
  type Store = Awaited<ReturnType<typeof store>>;

  async function canonical(status: 'PUBLISHED' | 'DRAFT' = 'PUBLISHED') {
    const brand = await prisma.brand.create({
      data: { name: unique('Brand'), normalizedName: unique('b') },
    });
    const category = await prisma.category.create({
      data: { nameAr: unique('فئة'), nameEn: unique('C') },
    });
    return prisma.canonicalProduct.create({
      data: {
        brandId: brand.id,
        categoryId: category.id,
        modelName: unique('M'),
        canonicalNameAr: 'منتج',
        status,
      },
    });
  }

  async function offer(
    s: Store,
    scope: { category: string; audience: ProductAudience },
    canonicalProductId: string | null = null,
  ) {
    const o = await prisma.vendorOffer.create({
      data: {
        vendorId: s.vendor.id,
        titleAr: unique('قطعة'),
        titleEn: 'Item',
        status: 'ACTIVE',
        canonicalProductId,
        taxonomyVersion: 1,
        requiresTaxonomy: true,
      },
    });
    await prisma.vendorOfferAudience.create({
      data: {
        vendorId: s.vendor.id,
        vendorOfferId: o.id,
        audience: scope.audience,
      },
    });
    await prisma.vendorOfferCategory.create({
      data: {
        vendorId: s.vendor.id,
        vendorOfferId: o.id,
        categoryCode: scope.category,
      },
    });
    const v = await prisma.offerVariant.create({
      data: {
        vendorId: s.vendor.id,
        vendorOfferId: o.id,
        sellerSku: unique('sku'),
        storeInventoryBarcode: unique('sib'),
        basePrice: 50,
        // A classified offer only takes colour/size combinations.
        isCombination: true,
        colorCode: 'BLACK',
      },
    });
    return { offerId: o.id, variantId: v.id };
  }

  /** One order line, written directly (the lifecycle itself is covered elsewhere). */
  async function sale(
    s: Store,
    o: { variantId: string },
    buyer: { customerId: string },
    opts: {
      quantity?: number;
      soldAt?: Date | null;
      status?: 'COMPLETED' | 'DELIVERED' | 'REFUNDED';
    } = {},
  ) {
    const co = await prisma.customerOrder.create({
      data: { customerId: buyer.customerId },
    });
    const bo = await prisma.branchOrder.create({
      data: {
        customerOrderId: co.id,
        vendorId: s.vendor.id,
        branchId: s.branch.id,
        fulfilmentMethod: 'PICKUP',
        paymentMethod: 'COD',
        status: opts.status ?? 'COMPLETED',
        subtotal: 50,
        total: 50,
        pickupCode: String(100000 + (counter += 1)),
        pickedUpAt: opts.soldAt === undefined ? daysAgo(1) : opts.soldAt,
      },
    });
    return prisma.branchOrderItem.create({
      data: {
        vendorId: s.vendor.id,
        branchOrderId: bo.id,
        offerVariantId: o.variantId,
        quantity: opts.quantity ?? 1,
        unitPrice: 50,
      },
    });
  }

  /** `n` buyers, each buying one unit. */
  async function soldTo(s: Store, o: { variantId: string }, n: number) {
    const buyers: Account[] = [];
    for (let i = 0; i < n; i++) {
      const b = await account();
      buyers.push(b);
      await sale(s, o, b);
    }
    return buyers;
  }

  const rebuild = () => salesRank.rebuild({ trigger: 'SCHEDULED' });
  const entry = (where: {
    scope: 'OFFER' | 'CANONICAL';
    vendorOfferId?: string;
    canonicalProductId?: string;
    categoryCode: string;
  }) => prisma.salesRankSnapshot.findFirst({ where });

  it('counts only completed, kept, recent sales by real customers', async () => {
    const s = await store();
    const scope = { category: 'TROUSERS', audience: 'MEN' as ProductAudience };
    const o = await offer(s, scope);
    const c = await account();
    // Counted: 2 + 1 units.
    await sale(s, o, c, { quantity: 2 });
    const rejected = await sale(s, o, await account());
    await prisma.return.create({
      data: {
        vendorId: s.vendor.id,
        branchOrderItemId: rejected.id,
        reason: 'DAMAGED',
        status: 'REJECTED',
        vendorReviewDueAt: new Date(),
      },
    });
    // Not counted.
    const cancelled = await sale(s, o, await account());
    await prisma.branchOrderItem.update({
      where: { id: cancelled.id },
      data: { cancelledAt: new Date() },
    });
    const refunded = await sale(s, o, await account());
    await prisma.branchOrderRefund.create({
      data: {
        branchOrderId: refunded.branchOrderId,
        branchOrderItemId: refunded.id,
        amount: 50,
        reason: 'PLATFORM_ADMIN_MANUAL',
        initiatedBy: 'PLATFORM_ADMIN',
        method: 'COD_CASH',
      },
    });
    for (const status of [
      'REQUESTED',
      'RECEIVED',
      'REFUNDED',
      'EXCHANGED',
    ] as const) {
      const item = await sale(s, o, await account());
      await prisma.return.create({
        data: {
          vendorId: s.vendor.id,
          branchOrderItemId: item.id,
          reason: 'DAMAGED',
          status,
          vendorReviewDueAt: new Date(),
          ...(status === 'EXCHANGED'
            ? {
                desiredOutcome: 'EXCHANGE' as const,
                replacementOfferVariantId: o.variantId,
                replacementBranchId: s.branch.id,
                replacementUnitPriceSnapshot: 50,
              }
            : {}),
        },
      });
    }
    await sale(s, o, await account(), { status: 'DELIVERED' });
    await sale(s, o, await account(), { status: 'REFUNDED' });
    await sale(s, o, await account(), { soldAt: null }); // no sale date
    await sale(s, o, await account(), { soldAt: daysAgo(31) });
    // The store's own people buying from it (QA / staff purchases).
    await sale(s, o, s.owner, { quantity: 5 });
    await sale(s, o, s.employee, { quantity: 5 });

    await rebuild();
    const e = await entry({
      scope: 'OFFER',
      vendorOfferId: o.offerId,
      categoryCode: scope.category,
    });
    expect(e).toMatchObject({ units: 3, customers: 2, qualified: false });
    expect(e!.audience).toBe('MEN');

    // A late return removes the unit on the next rebuild.
    const late = await prisma.branchOrderItem.findFirstOrThrow({
      where: { branchOrder: { customerOrder: { customerId: c.customerId } } },
    });
    await prisma.return.create({
      data: {
        vendorId: s.vendor.id,
        branchOrderItemId: late.id,
        reason: 'DAMAGED',
        vendorReviewDueAt: new Date(),
      },
    });
    await rebuild();
    expect(
      await entry({
        scope: 'OFFER',
        vendorOfferId: o.offerId,
        categoryCode: scope.category,
      }),
    ).toMatchObject({ units: 1, customers: 1 });
  });

  it('qualifies the top entries only with >= 5 units, >= 3 customers and >= 3 OTHER qualifying entries', async () => {
    const scope = { category: 'COATS', audience: 'WOMEN' as ProductAudience };
    const s = await store();
    const a = await offer(s, scope);
    const b = await offer(s, scope);
    const oneBuyer = await offer(s, scope);
    await soldTo(s, a, 6);
    await soldTo(s, b, 5);
    // 20 units, one customer: ranks first but never qualifies.
    await sale(s, oneBuyer, await account(), { quantity: 20 });

    await rebuild();
    const row = (id: string) =>
      entry({
        scope: 'OFFER',
        vendorOfferId: id,
        categoryCode: scope.category,
      });
    expect(await row(oneBuyer.offerId)).toMatchObject({
      rank: 1,
      qualified: false,
    });
    // Only two pass the thresholds: nobody is marked yet.
    expect(await row(a.offerId)).toMatchObject({
      rank: 2,
      qualified: false,
      qualifiedRank: null,
    });
    expect((await row(b.offerId))!.qualified).toBe(false);

    // Three passing entries: each has only 2 qualifying competitors.
    const c = await offer(s, scope);
    await soldTo(s, c, 5);
    await rebuild();
    expect((await row(c.offerId))!.qualified).toBe(false);
    expect((await row(a.offerId))!.qualified).toBe(false);
    // A fourth: every passing entry now has 3 qualifying competitors.
    const d = await offer(s, scope);
    await soldTo(s, d, 5);
    await rebuild();
    expect(await row(d.offerId)).toMatchObject({ qualified: true });
    expect(await row(a.offerId)).toMatchObject({
      qualified: true,
      qualifiedRank: 1,
    });
    expect(await row(b.offerId)).toMatchObject({ qualified: true });
    expect(await row(c.offerId)).toMatchObject({ qualified: true });
    expect(await row(oneBuyer.offerId)).toMatchObject({ qualified: false });
  });

  it('canonical scope sums every store (archived listings too); offer scope only lists what a shopper can see; merges follow the survivor; suspended stores and unpublished products are left out', async () => {
    const scope = { category: 'BLAZERS', audience: 'MEN' as ProductAudience };
    const s1 = await store();
    const s2 = await store();
    const p = await canonical();
    const o1 = await offer(s1, scope, p.id);
    const o2 = await offer(s2, scope, p.id);
    await soldTo(s1, o1, 3);
    await soldTo(s2, o2, 2);
    await prisma.vendorOffer.update({
      where: { id: o2.offerId },
      data: { status: 'ARCHIVED' },
    });
    // A merged-away product still pointed to by an offer -> the survivor.
    const survivor = await canonical();
    const loser = await canonical();
    await prisma.canonicalProduct.update({
      where: { id: loser.id },
      data: { status: 'MERGED', mergedIntoId: survivor.id },
    });
    const o3 = await offer(s1, scope, loser.id);
    await soldTo(s1, o3, 2);
    // Not published -> no canonical entry; suspended store -> nothing at all.
    const draft = await canonical('DRAFT');
    const o4 = await offer(s1, scope, draft.id);
    await soldTo(s1, o4, 2);
    const suspended = await store();
    const o5 = await offer(suspended, scope, p.id);
    await soldTo(suspended, o5, 4);
    await prisma.vendor.update({
      where: { id: suspended.vendor.id },
      data: { status: 'SUSPENDED' },
    });

    await rebuild();
    const cat = scope.category;
    expect(
      await entry({
        scope: 'CANONICAL',
        canonicalProductId: p.id,
        categoryCode: cat,
      }),
    ).toMatchObject({ units: 5, customers: 5 });
    expect(
      await entry({
        scope: 'OFFER',
        vendorOfferId: o1.offerId,
        categoryCode: cat,
      }),
    ).toMatchObject({ units: 3 });
    expect(
      await entry({
        scope: 'OFFER',
        vendorOfferId: o2.offerId,
        categoryCode: cat,
      }),
    ).toBeNull();
    expect(
      await entry({
        scope: 'CANONICAL',
        canonicalProductId: survivor.id,
        categoryCode: cat,
      }),
    ).toMatchObject({ units: 2 });
    expect(
      await entry({
        scope: 'CANONICAL',
        canonicalProductId: loser.id,
        categoryCode: cat,
      }),
    ).toBeNull();
    expect(
      await entry({
        scope: 'CANONICAL',
        canonicalProductId: draft.id,
        categoryCode: cat,
      }),
    ).toBeNull();
    expect(
      await entry({
        scope: 'OFFER',
        vendorOfferId: o4.offerId,
        categoryCode: cat,
      }),
    ).toMatchObject({ units: 2 });
    expect(
      await entry({
        scope: 'OFFER',
        vendorOfferId: o5.offerId,
        categoryCode: cat,
      }),
    ).toBeNull();
    // An unclassified offer has no scope and is not ranked.
    const plain = await prisma.vendorOffer.create({
      data: {
        vendorId: s1.vendor.id,
        titleAr: 'عادي',
        titleEn: 'Plain',
        status: 'ACTIVE',
      },
    });
    const pv = await prisma.offerVariant.create({
      data: {
        vendorId: s1.vendor.id,
        vendorOfferId: plain.id,
        sellerSku: unique('sku'),
        storeInventoryBarcode: unique('sib'),
        basePrice: 10,
      },
    });
    await soldTo(s1, { variantId: pv.id }, 6);
    await rebuild();
    expect(
      await prisma.salesRankSnapshot.count({
        where: { vendorOfferId: plain.id },
      }),
    ).toBe(0);
  });

  it('rebuilding is idempotent, concurrent rebuilds serialise, and the hourly job skips while one runs', async () => {
    const scope = { category: 'KNITWEAR', audience: 'KIDS' as ProductAudience };
    const s = await store();
    await soldTo(s, await offer(s, scope), 4);
    await soldTo(s, await offer(s, scope), 2);

    const shape = async () =>
      (
        await prisma.salesRankSnapshot.findMany({
          select: {
            scope: true,
            vendorOfferId: true,
            canonicalProductId: true,
            categoryCode: true,
            audience: true,
            units: true,
            customers: true,
            rank: true,
            qualified: true,
          },
        })
      )
        .map((r) => JSON.stringify(r))
        .sort();
    const first = await rebuild();
    const once = await shape();
    await rebuild();
    expect(await shape()).toEqual(once);

    const runsBefore = await prisma.salesRankRun.count();
    const results = await Promise.all([rebuild(), rebuild(), rebuild()]);
    expect(results.every((r) => r && r.row_count === first!.row_count)).toBe(
      true,
    );
    expect(await shape()).toEqual(once);
    expect(await prisma.salesRankRun.count()).toBe(runsBefore + 3);
    // Only the latest run's rows remain.
    const latest = await prisma.salesRankRun.findFirstOrThrow({
      orderBy: { computedAt: 'desc' },
    });
    expect(
      await prisma.salesRankSnapshot.count({
        where: { runId: { not: latest.id } },
      }),
    ).toBe(0);

    // While another transaction holds the lock, the scheduled tick skips.
    let skipped: unknown = 'not run';
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('finalpro:sales_rank'))`;
      skipped = await app.get(SalesRankSweepService).sweepOnce();
    });
    expect(skipped).toBeNull();
  });

  it('only a platform administrator can read the numbers or recompute; nothing reaches a store, an employee, a customer or the public', async () => {
    const scope = { category: 'JACKETS', audience: 'WOMEN' as ProductAudience };
    const s = await store();
    const o = await offer(s, scope);
    await soldTo(s, o, 2);
    const admin = await account('PLATFORM_ADMIN');
    const customer = await account();

    // Recompute: admin only, audited, needs an Idempotency-Key.
    for (const who of [s.owner, s.employee, customer]) {
      await call('post', '/admin/sales-rank/recompute', who.token).expect(403);
      await call('get', '/admin/sales-rank', who.token).expect(403);
    }
    await call('get', '/admin/sales-rank', null).expect(401);
    await call(
      'post',
      '/admin/sales-rank/recompute',
      admin.token,
      false,
    ).expect(422);
    const run = await call(
      'post',
      '/admin/sales-rank/recompute',
      admin.token,
    ).expect(200);
    expect(run.body).toMatchObject({ trigger: 'ADMIN' });
    expect(
      await prisma.auditLog.count({
        where: {
          action: 'sales_rank.recomputed',
          entityId: run.body.id,
          actorId: admin.userId,
        },
      }),
    ).toBe(1);

    const view = await call(
      'get',
      `/admin/sales-rank?scope=OFFER&category=${scope.category}&audience=WOMEN`,
      admin.token,
    ).expect(200);
    expect(view.body.run.id).toBe(run.body.id);
    expect(view.body.entries).toEqual([
      expect.objectContaining({
        units: 2,
        customers: 2,
        rank: 1,
        qualified: false,
        offer: expect.objectContaining({
          id: o.offerId,
          store_slug: s.vendor.slug,
        }),
      }),
    ]);
    await call('get', '/admin/sales-rank?take=500', admin.token).expect(400);
    await call('get', '/admin/sales-rank?scope=NOPE', admin.token).expect(400);

    // The public product page carries no rank or sales numbers.
    const detail = await call(
      'get',
      `/storefronts/${s.vendor.slug}/offers/${o.offerId}`,
      null,
    ).expect(200);
    // PD-5.3 adds a `bestseller` field, null while the flag is off
    // (the default) - and never a rank or a count.
    expect(detail.body.bestseller).toBeNull();
    expect(JSON.stringify(detail.body)).not.toMatch(
      /sales_rank|"units"|"customers"|qualified_rank/,
    );
  });
});
