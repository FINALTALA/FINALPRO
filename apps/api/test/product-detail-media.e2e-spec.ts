import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { uniqueTestPhone } from './helpers/test-phone';

// PD-1 (docs/srs/10-product-detail-enhancement-roadmap.md): the public
// offer detail returns each variant's OWN ordered media (+ colour/size),
// so the product page gallery follows the chosen colour/size; the
// flattened `images` stays for older clients. Seller media stays
// owner-only and per-variant.
let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

describe('PD-1 variant media on the product detail (e2e)', () => {
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

  async function member(
    vendorId: string,
    role: 'OWNER' | 'BRANCH_EMPLOYEE',
    branchId?: string,
  ) {
    const phone = uniqueTestPhone();
    const user = await prisma.user.create({
      data: { phone, passwordHash: 'not-used', phoneVerifiedAt: new Date() },
    });
    await prisma.vendorUser.create({
      data: { userId: user.id, vendorId, role, branchId: branchId ?? null },
    });
    return app.get(SessionService).create({
      userId: user.id,
      phone,
      phoneVerifiedAt: user.phoneVerifiedAt!.toISOString(),
      sessionVersion: user.sessionVersion,
    });
  }

  /**
   * One published store with:
   *  - a classified offer: BLACK/M + BLACK/L (each its own images, stored
   *    out of order) and WHITE/M (video only);
   *  - an older, unclassified offer with one image.
   */
  async function world() {
    const vendor = await prisma.vendor.create({
      data: {
        slug: unique('pd1-store'),
        legalName: unique('Legal'),
        displayName: 'متجر الصور',
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
    const offer = await prisma.vendorOffer.create({
      data: {
        vendorId: vendor.id,
        titleAr: 'فستان',
        titleEn: 'Dress',
        status: 'DRAFT',
        taxonomyVersion: 1,
        requiresTaxonomy: true,
      },
    });
    await prisma.vendorOfferAudience.create({
      data: { vendorId: vendor.id, vendorOfferId: offer.id, audience: 'WOMEN' },
    });
    await prisma.vendorOfferCategory.create({
      data: {
        vendorId: vendor.id,
        vendorOfferId: offer.id,
        categoryCode: 'DRESSES_WOMEN',
      },
    });
    const variant = async (color: string, size: string) => {
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
        },
      });
      await prisma.branchStock.create({
        data: {
          vendorId: vendor.id,
          branchId: branch.id,
          offerVariantId: v.id,
          quantity: 3,
        },
      });
      return v;
    };
    const blackM = await variant('BLACK', 'M');
    const blackL = await variant('BLACK', 'L');
    const whiteM = await variant('WHITE', 'M');
    const media = (
      offerVariantId: string,
      url: string,
      sortOrder: number,
      extra: object = {},
    ) =>
      prisma.offerVariantMedia.create({
        data: {
          vendorId: vendor.id,
          offerVariantId,
          url,
          sortOrder,
          mediaType: 'IMAGE',
          ...extra,
        },
      });
    // Stored out of order on purpose; the PRIMARY is not the lowest sortOrder.
    await media(blackM.id, 'https://cdn.example.com/black-m-2.jpg', 2);
    await media(blackM.id, 'https://cdn.example.com/black-m-0.jpg', 0, {
      altTextAr: 'أسود من الأمام',
      altTextEn: 'Black front',
    });
    await media(blackM.id, 'https://cdn.example.com/black-m-primary.jpg', 5, {
      kind: 'PRIMARY',
    });
    await media(blackL.id, 'https://cdn.example.com/black-l-1.jpg', 1);
    await media(blackL.id, 'https://cdn.example.com/black-l-primary.jpg', 0, {
      kind: 'PRIMARY',
    });
    await media(whiteM.id, 'https://cdn.example.com/white-m.mp4', 0, {
      mediaType: 'VIDEO',
    });
    await prisma.vendorOffer.update({
      where: { id: offer.id },
      data: { status: 'ACTIVE' },
    });

    const legacy = await prisma.vendorOffer.create({
      data: {
        vendorId: vendor.id,
        titleAr: 'قديم',
        titleEn: 'Legacy',
        status: 'ACTIVE',
      },
    });
    const legacyVariant = await prisma.offerVariant.create({
      data: {
        vendorId: vendor.id,
        vendorOfferId: legacy.id,
        sellerSku: unique('sku'),
        storeInventoryBarcode: unique('sib'),
        basePrice: 50,
      },
    });
    await media(legacyVariant.id, 'https://cdn.example.com/legacy.jpg', 0, {
      kind: 'PRIMARY',
    });

    return {
      vendor,
      branch,
      offer,
      legacy,
      blackM,
      blackL,
      whiteM,
      owner: await member(vendor.id, 'OWNER'),
      employee: await member(vendor.id, 'BRANCH_EMPLOYEE', branch.id),
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const detail = (w: World, offerId = w.offer.id) =>
    request(http())
      .get(`/api/v1/storefronts/${w.vendor.slug}/offers/${offerId}`)
      .expect(200);
  const byId = (body: { variants: { id: string }[] }, id: string) =>
    body.variants.find((v) => v.id === id) as unknown as Record<
      string,
      unknown
    > & {
      media: Record<string, unknown>[];
    };

  it('each variant carries its own ordered media and colour/size; no cross-variant leakage', async () => {
    const w = await world();
    const res = await detail(w);
    const blackM = byId(res.body, w.blackM.id);
    expect(blackM).toMatchObject({
      color_code: 'BLACK',
      color_label: 'أسود',
      size_code: 'M',
      size_label: 'M',
    });
    // PRIMARY first, then the owner's order.
    expect(blackM.media.map((m) => m.url)).toEqual([
      'https://cdn.example.com/black-m-primary.jpg',
      'https://cdn.example.com/black-m-0.jpg',
      'https://cdn.example.com/black-m-2.jpg',
    ]);
    expect(blackM.media[1]).toEqual({
      url: 'https://cdn.example.com/black-m-0.jpg',
      kind: 'ADDITIONAL',
      media_type: 'IMAGE',
      alt_text_ar: 'أسود من الأمام',
      alt_text_en: 'Black front',
      sort_order: 0,
    });
    // Another size of the same colour is another variant with its own gallery.
    const blackL = byId(res.body, w.blackL.id);
    expect(blackL.media.map((m) => m.url)).toEqual([
      'https://cdn.example.com/black-l-primary.jpg',
      'https://cdn.example.com/black-l-1.jpg',
    ]);
    expect(JSON.stringify(blackL.media)).not.toContain('black-m');
    // A video-only variant reports exactly that (the page then falls back).
    const whiteM = byId(res.body, w.whiteM.id);
    expect(whiteM.media).toEqual([
      expect.objectContaining({
        url: 'https://cdn.example.com/white-m.mp4',
        media_type: 'VIDEO',
      }),
    ]);
  });

  it('the selected combination resolves to a variant whose media differs', async () => {
    const w = await world();
    const options = await request(http())
      .get(`/api/v1/storefronts/${w.vendor.slug}/offers/${w.offer.id}/options`)
      .expect(200);
    const res = await detail(w);
    const mediaFor = (color: string, size: string) => {
      const combo = options.body.combinations.find(
        (c: { color_code: string; size_code: string }) =>
          c.color_code === color && c.size_code === size,
      );
      return byId(res.body, combo.variant_id).media.map((m) => m.url);
    };
    expect(mediaFor('BLACK', 'M')[0]).toBe(
      'https://cdn.example.com/black-m-primary.jpg',
    );
    expect(mediaFor('BLACK', 'L')[0]).toBe(
      'https://cdn.example.com/black-l-primary.jpg',
    );
    expect(mediaFor('BLACK', 'M')).not.toEqual(mediaFor('BLACK', 'L'));
    expect(mediaFor('WHITE', 'M')).toEqual([
      'https://cdn.example.com/white-m.mp4',
    ]);
  });

  it('the flattened legacy `images` list is unchanged, and unclassified offers still work', async () => {
    const w = await world();
    const res = await detail(w);
    expect(res.body.images).toEqual(
      expect.arrayContaining([
        'https://cdn.example.com/black-m-primary.jpg',
        'https://cdn.example.com/black-l-primary.jpg',
        'https://cdn.example.com/black-m-0.jpg',
      ]),
    );
    expect(new Set(res.body.images).size).toBe(res.body.images.length);
    const legacy = await detail(w, w.legacy.id);
    expect(legacy.body.images).toEqual(['https://cdn.example.com/legacy.jpg']);
    expect(legacy.body.variants[0]).toMatchObject({
      color_code: null,
      color_label: null,
      size_code: null,
      size_label: null,
    });
    expect(legacy.body.variants[0].media).toHaveLength(1);
  });

  it('seller media: owner-only, per variant, ordered, validated, safely deleted', async () => {
    const w = await world();
    const base = (variantId: string) =>
      `/api/v1/vendors/${w.vendor.id}/offers/${w.offer.id}/variants/${variantId}/media`;
    const add = (token: string, variantId: string, body: object) =>
      request(http())
        .post(base(variantId))
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', unique('m'))
        .send(body);

    // A branch employee cannot add, list, reorder or delete media.
    expect(
      (
        await add(w.employee, w.blackM.id, {
          url: 'https://cdn.example.com/x.jpg',
          media_type: 'IMAGE',
        })
      ).status,
    ).toBe(403);
    await request(http())
      .get(base(w.blackM.id))
      .set('Authorization', `Bearer ${w.employee}`)
      .expect(403);

    // Validation: a video can't be PRIMARY; alt text is bounded.
    const video = await add(w.owner, w.blackM.id, {
      url: 'https://cdn.example.com/v.mp4',
      media_type: 'VIDEO',
      kind: 'PRIMARY',
    });
    expect(video.status).toBe(400);
    expect(video.body.error.code).toBe('PRIMARY_MUST_BE_IMAGE');
    expect(
      (
        await add(w.owner, w.blackM.id, {
          url: 'https://cdn.example.com/a.jpg',
          media_type: 'IMAGE',
          alt_text_ar: 'ا'.repeat(251),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await add(w.owner, w.blackM.id, {
          url: 'not a url',
          media_type: 'IMAGE',
        })
      ).status,
    ).toBe(400);

    // The owner adds to BLACK/L; it appears only there, at the end.
    const added = await add(w.owner, w.blackL.id, {
      url: 'https://cdn.example.com/black-l-new.jpg',
      media_type: 'IMAGE',
      alt_text_ar: 'جديد',
    });
    expect(added.status).toBe(201);
    let res = await detail(w);
    expect(
      byId(res.body, w.blackL.id)
        .media.map((m) => m.url)
        .at(-1),
    ).toBe('https://cdn.example.com/black-l-new.jpg');
    expect(JSON.stringify(byId(res.body, w.blackM.id).media)).not.toContain(
      'black-l-new',
    );

    // Reordering one variant changes only that variant's order.
    const own = await request(http())
      .get(base(w.blackL.id))
      .set('Authorization', `Bearer ${w.owner}`)
      .expect(200);
    const ids = own.body.map((m: { id: string }) => m.id).reverse();
    await request(http())
      .put(`${base(w.blackL.id)}/reorder`)
      .set('Authorization', `Bearer ${w.owner}`)
      .send({ media_ids: ids })
      .expect(200);
    // Another variant's ids are refused.
    const blackMMedia = await request(http())
      .get(base(w.blackM.id))
      .set('Authorization', `Bearer ${w.owner}`)
      .expect(200);
    await request(http())
      .put(`${base(w.blackL.id)}/reorder`)
      .set('Authorization', `Bearer ${w.owner}`)
      .send({ media_ids: [...ids.slice(1), blackMMedia.body[0].id] })
      .expect(403);
    res = await detail(w);
    // PRIMARY still first; the additional images follow the new order.
    expect(byId(res.body, w.blackL.id).media.map((m) => m.url)).toEqual([
      'https://cdn.example.com/black-l-primary.jpg',
      'https://cdn.example.com/black-l-new.jpg',
      'https://cdn.example.com/black-l-1.jpg',
    ]);

    // Deleting BLACK/M's media through BLACK/L's URL is refused; nothing goes.
    await request(http())
      .delete(`${base(w.blackL.id)}/${blackMMedia.body[0].id}`)
      .set('Authorization', `Bearer ${w.owner}`)
      .expect(404);
    expect(
      await prisma.offerVariantMedia.count({
        where: { offerVariantId: w.blackM.id },
      }),
    ).toBe(3);
    await request(http())
      .delete(`${base(w.blackL.id)}/${added.body.id}`)
      .set('Authorization', `Bearer ${w.employee}`)
      .expect(403);
    await request(http())
      .delete(`${base(w.blackL.id)}/${added.body.id}`)
      .set('Authorization', `Bearer ${w.owner}`)
      .expect(204);
    res = await detail(w);
    expect(byId(res.body, w.blackL.id).media).toHaveLength(2);
    expect(byId(res.body, w.blackM.id).media).toHaveLength(3);
  });
});
