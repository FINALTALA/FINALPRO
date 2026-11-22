import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { uniqueTestPhone } from './helpers/test-phone';

// TB-25.2: three additive fields so the web can show data in the
// interface language - every existing field stays exactly as it was.
//  - comparison/discovery cards: `category_name_en` (the catalogue
//    category's English name) and `color_codes` (the eligible offers'
//    distinct taxonomy colour codes; never null, never duplicated);
//  - the customer's order lines: `color_code` / `size_code` (the
//    purchase snapshot's codes) beside the unchanged labels.
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

describe('TB-25.2 language fields (e2e)', () => {
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
    await app.close();
  });

  const http = () => app.getHttpServer();

  async function customerSession() {
    const phone = uniqueTestPhone();
    const user = await prisma.user.create({
      data: { phone, passwordHash: 'not-used', phoneVerifiedAt: new Date() },
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
    return { token, customerId: profile.id };
  }

  /** A published store selling one matched product in RED/S, RED/M,
   * BLUE/S and a size-only L (no colour code). */
  async function world() {
    const tag = unique('tb25');
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('tb25-store'),
        legalName: unique('Legal'),
        displayName: 'متجر',
        status: 'ACTIVE',
        subscriptionStatus: 'ACTIVE',
        storefrontPublished: true,
      },
    });
    const branch = await prisma.storeBranch.create({
      data: {
        vendorId: vendor.id,
        name: 'الفرع',
        verificationStatus: 'APPROVED',
      },
    });
    const brand = await prisma.brand.create({
      data: { name: unique('Brand'), normalizedName: unique('brand') },
    });
    const category = await prisma.category.create({
      data: { nameAr: `فئة ${tag}`, nameEn: `Category ${tag}` },
    });
    const product = await prisma.canonicalProduct.create({
      data: {
        brandId: brand.id,
        categoryId: category.id,
        modelName: unique('model'),
        canonicalNameAr: `فستان ${tag}`,
        canonicalNameEn: `Dress ${tag}`,
        status: 'PUBLISHED',
      },
    });
    const offer = await prisma.vendorOffer.create({
      data: {
        vendorId: vendor.id,
        titleAr: `فستان ${tag}`,
        titleEn: `Dress ${tag}`,
        status: 'ACTIVE',
        canonicalProductId: product.id,
        taxonomyVersion: 1,
        requiresTaxonomy: true,
      },
    });
    const variant = async (color: string | null, size: string | null) => {
      const cv = await prisma.canonicalProductVariant.create({
        data: {
          canonicalProductId: product.id,
          structuralAttributes: { color: color ?? 'none', size: size ?? '' },
          platformProductBarcode: unique('pb'),
        },
      });
      const v = await prisma.offerVariant.create({
        data: {
          vendorId: vendor.id,
          vendorOfferId: offer.id,
          sellerSku: unique('sku'),
          storeInventoryBarcode: unique('sib'),
          basePrice: 100,
          isCombination: true,
          colorCode: color,
          sizeCode: size,
          canonicalVariantId: cv.id,
        },
      });
      await prisma.branchStock.create({
        data: {
          vendorId: vendor.id,
          branchId: branch.id,
          offerVariantId: v.id,
          quantity: 4,
        },
      });
      return v;
    };
    const redS = await variant('RED', 'S');
    await variant('RED', 'M');
    await variant('BLUE', 'S');
    await variant(null, 'L'); // a size-only combination: no colour code
    return { tag, vendor, branch, category, product, redS };
  }

  it('the comparison card adds category_name_en and color_codes; every other field unchanged', async () => {
    const w = await world();
    const res = await request(http())
      .get(`/api/v1/canonical-products/${w.product.id}/comparison-card`)
      .expect(200);
    expect(res.body.category_name).toBe(w.category.nameAr);
    expect(res.body.category_name_en).toBe(w.category.nameEn);
    expect([...res.body.color_codes].sort()).toEqual(['BLUE', 'RED']);
    // No null code, no duplicate (RED is sold in two sizes).
    expect(res.body.color_codes).toHaveLength(2);
    // The existing fields are still there, as before.
    expect(res.body.canonical_name_ar).toBe(`فستان ${w.tag}`);
    expect(res.body.canonical_name_en).toBe(`Dress ${w.tag}`);
    expect(Array.isArray(res.body.colors)).toBe(true);
    expect(Array.isArray(res.body.sizes)).toBe(true);
  });

  it('discovery cards carry the same two fields', async () => {
    const w = await world();
    const res = await request(http())
      .get(`/api/v1/discovery/all?q=${encodeURIComponent(w.tag)}`)
      .expect(200);
    const card = res.body.items.find(
      (c: { canonical_product_id: string }) => c.canonical_product_id === w.product.id,
    );
    expect(card).toBeDefined();
    expect(card.category_name_en).toBe(w.category.nameEn);
    expect([...card.color_codes].sort()).toEqual(['BLUE', 'RED']);
  });

  it('a category without an English name gives category_name_en null-or-empty, never a crash', async () => {
    const w = await world();
    await prisma.category.update({
      where: { id: w.category.id },
      data: { nameEn: '' },
    });
    const res = await request(http())
      .get(`/api/v1/canonical-products/${w.product.id}/comparison-card`)
      .expect(200);
    expect(res.body.category_name).toBe(w.category.nameAr);
    expect(['', null]).toContain(res.body.category_name_en);
  });

  it("the customer's order lines add color_code and size_code beside the unchanged labels", async () => {
    const w = await world();
    const { token, customerId } = await customerSession();
    const customerOrder = await prisma.customerOrder.create({
      data: { customerId },
    });
    const order = await prisma.branchOrder.create({
      data: {
        customerOrderId: customerOrder.id,
        vendorId: w.vendor.id,
        branchId: w.branch.id,
        fulfilmentMethod: 'PICKUP',
        paymentMethod: 'COD',
        status: 'COMPLETED',
        subtotal: 100,
        total: 100,
        pickupCode: String(100000 + (counter % 899999)),
      },
    });
    await prisma.branchOrderItem.create({
      data: {
        vendorId: w.vendor.id,
        branchOrderId: order.id,
        offerVariantId: w.redS.id,
        quantity: 1,
        unitPrice: 100,
        colorCodeSnapshot: 'RED',
        colorLabelSnapshot: 'أحمر',
        sizeCodeSnapshot: 'S',
        sizeLabelSnapshot: 'S',
      },
    });
    const res = await request(http())
      .get('/api/v1/customers/me/orders')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const mine = res.body.find((o: { id: string }) => o.id === order.id);
    expect(mine).toBeDefined();
    expect(mine.items[0]).toMatchObject({
      color_label: 'أحمر',
      size_label: 'S',
      color_code: 'RED',
      size_code: 'S',
    });
  });

  it('an order line from before the snapshot has null codes (and null labels), as before', async () => {
    const w = await world();
    const { token, customerId } = await customerSession();
    const customerOrder = await prisma.customerOrder.create({
      data: { customerId },
    });
    const order = await prisma.branchOrder.create({
      data: {
        customerOrderId: customerOrder.id,
        vendorId: w.vendor.id,
        branchId: w.branch.id,
        fulfilmentMethod: 'PICKUP',
        paymentMethod: 'COD',
        status: 'PLACED',
        subtotal: 100,
        total: 100,
        pickupCode: String(200000 + (counter % 799999)),
      },
    });
    await prisma.branchOrderItem.create({
      data: {
        vendorId: w.vendor.id,
        branchOrderId: order.id,
        offerVariantId: w.redS.id,
        quantity: 1,
        unitPrice: 100,
      },
    });
    const res = await request(http())
      .get('/api/v1/customers/me/orders')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const mine = res.body.find((o: { id: string }) => o.id === order.id);
    expect(mine.items[0]).toMatchObject({
      color_label: null,
      size_label: null,
      color_code: null,
      size_code: null,
    });
  });
});
