/** Additive local fixtures. Stable IDs make reruns preserve user experiments. */
import { createHash } from 'crypto';
import { writeFileSync } from 'fs';
import * as bcrypt from 'bcryptjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { requireLocalDatabase } from './local-db-guard';

const id = (key: string) => {
  const h = createHash('sha256')
    .update(`finalpro-scenarios-v1:${key}`)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const now = new Date();
const days = (n: number) => new Date(now.getTime() + n * 86400000);
const cases: { kind: string; name: string; id: string; url?: string }[] = [];
const accounts: { role: string; phone: string; password: string }[] = [
  { role: 'صاحب المتاجر', phone: '+970560000001', password: 'DemoOwner#2026' },
  {
    role: 'موظف الفرع الرئيسي',
    phone: '+970560000002',
    password: 'DemoEmployee#2026',
  },
  { role: 'زبون', phone: '+970560000003', password: 'DemoCustomer#2026' },
];

async function main() {
  const url = process.env.DATABASE_URL!;
  requireLocalDatabase(url);
  const prisma = new PrismaClient({ adapter: new PrismaPg(url) });
  try {
    const passwordHash = await bcrypt.hash('DemoTest#2026', 10);
    await prisma.$transaction(
      async (tx) => {
        const add = async (model: string, key: string, data: any) => {
          const rowId = id(key);
          return (tx as any)[model].upsert({
            where: { id: rowId },
            create: { id: rowId, ...data },
            update: {},
          });
        };
        const owner = await tx.user.findUniqueOrThrow({
          where: { phone: accounts[0].phone },
        });
        const customer = await tx.customerProfile.findFirstOrThrow({
          where: { user: { phone: accounts[2].phone } },
        });
        const vendor = await tx.vendor.findUniqueOrThrow({
          where: { slug: 'demo-fashion-house' },
        });
        const branch = await tx.storeBranch.findFirstOrThrow({
          where: { vendorId: vendor.id, name: 'الفرع الرئيسي' },
        });
        const base = await tx.canonicalProduct.findFirstOrThrow({
          where: { modelName: { contains: 'Demo' } },
        });
        const address = await tx.address.findFirstOrThrow({
          where: { customerId: customer.id },
        });
        const window = await tx.deliveryWindow.findFirstOrThrow({
          where: { branchId: branch.id },
        });
        for (const [role, phone, label] of [
          ['PLATFORM_ADMIN', '+970560000004', 'مدير المنصة'],
          ['VERIFICATION_REVIEWER', '+970560000005', 'مراجع التحقق'],
          [null, '+970560000006', 'زبون بسلة فارغة'],
        ] as const) {
          const user = await add('user', phone, {
            phone,
            passwordHash,
            phoneVerifiedAt: now,
            platformRole: role,
          });
          await add('customerProfile', `profile:${phone}`, {
            userId: user.id,
            displayName: label,
          });
          accounts.push({ role: label, phone, password: 'DemoTest#2026' });
        }
        const productCases = [
          [
            'regular',
            'قميص متوفر بالسعر العادي',
            {},
            40,
            'ACTIVE',
            'CONFIRMED',
          ],
          [
            'sale',
            'بنطال بسعر تنزيلات',
            { salePrice: 75 },
            30,
            'ACTIVE',
            'CONFIRMED',
          ],
          [
            'discount-active',
            'فستان بخصم فعال',
            {
              discountPercent: 25,
              discountStartAt: days(-1),
              discountEndAt: days(7),
            },
            20,
            'ACTIVE',
            'CONFIRMED',
          ],
          [
            'discount-future',
            'حقيبة بخصم مستقبلي',
            {
              discountPercent: 20,
              discountStartAt: days(1),
              discountEndAt: days(7),
            },
            15,
            'ACTIVE',
            'CONFIRMED',
          ],
          [
            'discount-expired',
            'جاكيت بخصم منتهي',
            {
              discountPercent: 15,
              discountStartAt: days(-7),
              discountEndAt: days(-1),
            },
            12,
            'ACTIVE',
            'CONFIRMED',
          ],
          ['out-of-stock', 'حذاء نافد المخزون', {}, 0, 'ACTIVE', 'CONFIRMED'],
          ['low-stock', 'بلوزة بمخزون منخفض', {}, 2, 'ACTIVE', 'CONFIRMED'],
          [
            'reserved',
            'قميص مخزونه محجوز بالكامل',
            {},
            5,
            'ACTIVE',
            'CONFIRMED',
          ],
          ['draft', 'منتج مسودة غير منشور', {}, 10, 'DRAFT', 'CONFIRMED'],
          ['inactive', 'منتج متوقف مؤقتا', {}, 10, 'INACTIVE', 'CONFIRMED'],
          ['archived', 'منتج مؤرشف', {}, 10, 'ARCHIVED', 'CONFIRMED'],
          [
            'match-pending',
            'منتج ينتظر تأكيد المطابقة',
            {},
            10,
            'ACTIVE',
            'PENDING',
          ],
          [
            'match-rejected',
            'منتج مرفوض المطابقة',
            {},
            10,
            'ACTIVE',
            'REJECTED',
          ],
          ['unmatched', 'منتج فريد بلا مطابقة', {}, 10, 'ACTIVE', 'NONE'],
        ] as const;
        const variants: any[] = [];
        for (const [
          key,
          title,
          price,
          quantity,
          status,
          match,
        ] of productCases) {
          const product = await add('canonicalProduct', `product:${key}`, {
            brandId: base.brandId,
            categoryId: base.categoryId,
            modelName: `QA ${key}`,
            status: 'PUBLISHED',
            canonicalNameAr: title,
            canonicalNameEn: `Test ${key}`,
          });
          const canonical = await add(
            'canonicalProductVariant',
            `canonical:${key}`,
            {
              canonicalProductId: product.id,
              structuralAttributes: { size: 'M', colour: 'white' },
              platformProductBarcode: `PPB-QA-${key}`,
            },
          );
          const offer = await add('vendorOffer', `offer:${key}`, {
            vendorId: vendor.id,
            canonicalProductId: match === 'CONFIRMED' ? product.id : null,
            titleAr: title,
            titleEn: `Test ${key}`,
            status,
            archivedAt: status === 'ARCHIVED' ? now : null,
            firstPublishedAt: status === 'ACTIVE' ? now : null,
          });
          const variant = await add('offerVariant', `variant:${key}`, {
            vendorId: vendor.id,
            vendorOfferId: offer.id,
            canonicalVariantId: match === 'CONFIRMED' ? canonical.id : null,
            proposedCanonicalVariantId:
              match === 'PENDING' ? canonical.id : null,
            matchProposalStatus: match,
            sellerSku: `QA-${key}`,
            storeInventoryBarcode: `SIB-QA-${key}`,
            basePrice: 100,
            colour: 'أبيض',
            size: 'M',
            ...price,
          });
          variants.push(variant);
          await add('branchStock', `stock:${key}`, {
            vendorId: vendor.id,
            branchId: branch.id,
            offerVariantId: variant.id,
            quantity,
            reservedQuantity: 0,
            safetyStockThreshold: 3,
          });
          await add('offerVariantMedia', `media:${key}`, {
            vendorId: vendor.id,
            offerVariantId: variant.id,
            url: '/demo-assets/product-shirt-white.svg',
            kind: 'PRIMARY',
            mediaType: 'IMAGE',
          });
          await add('priceHistory', `price:${key}`, {
            vendorId: vendor.id,
            offerVariantId: variant.id,
            basePrice: 100,
            salePrice: (price as any).salePrice ?? null,
            discountPercent: (price as any).discountPercent ?? null,
            discountStartAt: (price as any).discountStartAt ?? null,
            discountEndAt: (price as any).discountEndAt ?? null,
            effectivePriceAtChange:
              (price as any).salePrice ??
              (key === 'discount-active' ? 75 : 100),
            reason: 'MIGRATED_BASELINE',
          });
          if (match === 'PENDING')
            await add('matchReviewCandidate', `match:${key}`, {
              vendorId: vendor.id,
              offerVariantId: variant.id,
              canonicalVariantId: canonical.id,
              score: 0.85,
              status: 'PENDING',
            });
          cases.push({
            kind: 'منتج',
            name: title,
            id: variant.id,
            url: `/store/${vendor.slug}`,
          });
        }
        // Each operational store state is a separate fixture, not a change to a live store.
        for (const [key, status, subscription, published, type] of [
          ['applied', 'APPLIED', 'NONE', false, 'PHYSICAL'],
          ['review', 'UNDER_REVIEW', 'NONE', false, 'PHYSICAL'],
          ['rejected', 'REJECTED', 'NONE', false, 'PHYSICAL'],
          ['approved', 'APPROVED', 'NONE', false, 'PHYSICAL'],
          ['suspended', 'SUSPENDED', 'ACTIVE', true, 'PHYSICAL'],
          ['cancelled', 'CANCELLED', 'NONE', false, 'PHYSICAL'],
          ['expired', 'ACTIVE', 'EXPIRED', true, 'PHYSICAL'],
          ['unpublished', 'ACTIVE', 'ACTIVE', false, 'PHYSICAL'],
          ['online', 'ACTIVE', 'ACTIVE', true, 'ONLINE_ONLY'],
          ['hybrid', 'ACTIVE', 'ACTIVE', true, 'HYBRID'],
        ] as const) {
          const store = await add('vendor', `store:${key}`, {
            slug: `qa-${key}`,
            legalName: `متجر اختبار ${key}`,
            displayName: `متجر اختبار ${key}`,
            status,
            subscriptionStatus: subscription,
            storefrontPublished: published,
            storeType: type,
          });
          await add('vendorUser', `owner:${key}`, {
            vendorId: store.id,
            userId: owner.id,
            role: 'OWNER',
            status: 'ACTIVE',
          });
          await add('vendorSubscription', `subscription:${key}`, {
            vendorId: store.id,
            status: subscription,
            periodEnd: subscription === 'EXPIRED' ? days(-1) : days(30),
          });
          await add('storeBranch', `branch:${key}`, {
            vendorId: store.id,
            name: `فرع اختبار ${key}`,
            isPhysical: type !== 'ONLINE_ONLY',
            lat: 31.9,
            lng: 35.2,
            verificationStatus:
              status === 'ACTIVE' || status === 'SUSPENDED'
                ? 'APPROVED'
                : status === 'REJECTED'
                  ? 'REJECTED'
                  : 'PENDING',
          });
          if (type !== 'PHYSICAL') {
            await add('warehouse', `warehouse:${key}`, {
              vendorId: store.id,
              lat: 31.9,
              lng: 35.2,
              addressNote: 'مستودع اختبار',
            });
            await add('pickupPoint', `pickup:${key}`, {
              vendorId: store.id,
              name: 'نقطة استلام تجريبية',
              lat: 31.9,
              lng: 35.2,
              isActive: true,
            });
          }
          cases.push({
            kind: 'متجر',
            name: `${key}: ${status} / ${subscription}`,
            id: store.id,
            url: `/store/${store.slug}`,
          });
        }
        for (const status of [
          'PENDING',
          'REJECTED',
          'RESUBMISSION_REQUESTED',
          'APPROVED',
        ]) {
          const b = await add('storeBranch', `verification:${status}`, {
            vendorId: vendor.id,
            name: `اختبار التحقق ${status}`,
            lat: 31.9,
            lng: 35.2,
            verificationPhotoUrl: '/demo-assets/store-fashion-house-cover.svg',
            verificationStatus: status,
            evidenceRevision: 1,
            evidenceSubmittedAt: now,
          });
          cases.push({ kind: 'تحقق فرع', name: status, id: b.id });
        }
        for (let day = 0; day < 7; day++)
          await add('branchOperatingHours', `hours:${day}`, {
            vendorId: vendor.id,
            branchId: branch.id,
            dayOfWeek: day,
            openMinute: 480,
            closeMinute: 1320,
          });
        for (const category of ['MEN', 'KIDS', 'ACCESSORIES'])
          await add('vendorApplicableCategory', `segment:${category}`, {
            vendorId: vendor.id,
            category,
          });
        const heldVariant = variants[7];
        const holdId = id('stock-hold');
        if (
          !(await tx.checkoutReservation.findUnique({ where: { id: holdId } }))
        ) {
          const hold = await add('checkoutReservation', 'stock-hold', {
            customerId: customer.id,
            expiresAt: new Date(now.getTime() + 10 * 60000),
          });
          await add('checkoutReservationItem', 'held-item', {
            reservationId: hold.id,
            vendorId: vendor.id,
            branchId: branch.id,
            offerVariantId: heldVariant.id,
            quantity: 5,
            unitPriceAtReserve: 100,
            fulfilmentMethod: 'PICKUP',
            paymentMethod: 'COD',
          });
          await tx.branchStock.update({
            where: { id: id('stock:reserved') },
            data: { reservedQuantity: 5 },
          });
        }
        for (const [key, expiry] of [
          ['valid', days(7)],
          ['expired', days(-1)],
        ] as const)
          await add('staffInvite', `invite:${key}`, {
            vendorId: vendor.id,
            branchId: branch.id,
            phone: key === 'valid' ? '+970560000007' : '+970560000008',
            invitedById: owner.id,
            expiresAt: expiry,
            status: 'PENDING',
          });
        const closed = await add('storeBranch', 'closed-branch', {
          vendorId: vendor.id,
          name: 'فرع مغلق مؤقتا',
          lat: 31.9,
          lng: 35.2,
          verificationStatus: 'APPROVED',
        });
        await add('branchClosure', 'closure', {
          vendorId: vendor.id,
          branchId: closed.id,
          startsAt: days(-1),
          endsAt: days(2),
          reason: 'إغلاق تجريبي للصيانة',
          createdBy: owner.id,
        });
        const archived = await add('storeBranch', 'archived-branch', {
          vendorId: vendor.id,
          name: 'فرع مؤرشف',
          lat: 31.9,
          lng: 35.2,
          verificationStatus: 'APPROVED',
          archivedAt: now,
        });
        cases.push(
          { kind: 'فرع', name: 'مغلق مؤقتا', id: closed.id },
          { kind: 'فرع', name: 'مؤرشف', id: archived.id },
        );
        await add('storeFollow', 'follow', {
          userId: customer.userId,
          vendorId: vendor.id,
        });
        await add('cartItem', 'cart', {
          customerId: customer.id,
          vendorId: vendor.id,
          offerVariantId: variants[0].id,
          quantity: 1,
        });
        let index = 0;
        for (const method of ['DELIVERY', 'PICKUP'])
          for (const payment of ['COD', 'ONLINE']) {
            const states =
              method === 'DELIVERY'
                ? [
                    'PLACED',
                    'PREPARING',
                    'SENT',
                    'DELIVERED',
                    'COMPLETED',
                    'CANCELLED',
                  ]
                : [
                    'PLACED',
                    'PREPARING',
                    'PICKED_UP',
                    'COMPLETED',
                    'CANCELLED',
                  ];
            if (payment === 'ONLINE') states.push('REFUNDED');
            for (const status of states) {
              const key = `${method}:${payment}:${status}`;
              const order = await add('customerOrder', `checkout:${key}`, {
                customerId: customer.id,
              });
              const charge =
                payment === 'ONLINE'
                  ? await add('paymentTransaction', `payment:${key}`, {
                      customerOrderId: order.id,
                      amount: method === 'DELIVERY' ? 110 : 100,
                      status: 'SUCCEEDED',
                      sandboxReference: `QA-${key}`,
                    })
                  : null;
              const date = days(2);
              while (date.getUTCDay() !== window.dayOfWeek)
                date.setUTCDate(date.getUTCDate() + 1);
              const branchOrder = await add('branchOrder', `order:${key}`, {
                customerOrderId: order.id,
                vendorId: vendor.id,
                branchId: branch.id,
                fulfilmentMethod: method,
                paymentMethod: payment,
                status,
                subtotal: 100,
                deliveryFee: method === 'DELIVERY' ? 10 : null,
                total: method === 'DELIVERY' ? 110 : 100,
                addressId: method === 'DELIVERY' ? address.id : null,
                deliveryWindowId: method === 'DELIVERY' ? window.id : null,
                scheduledDate: method === 'DELIVERY' ? date : null,
                pickupCode: method === 'PICKUP' ? String(800000 + index) : null,
                paymentTransactionId: charge?.id ?? null,
                deliveredAt:
                  method === 'DELIVERY' &&
                  ['DELIVERED', 'COMPLETED'].includes(status)
                    ? now
                    : null,
              });
              await add('branchOrderItem', `item:${key}`, {
                vendorId: vendor.id,
                branchOrderId: branchOrder.id,
                offerVariantId: variants[0].id,
                quantity: 1,
                unitPrice: 100,
              });
              cases.push({
                kind: 'طلب',
                name: key,
                id: branchOrder.id,
                url: '/orders',
              });
              index++;
            }
          }
        // A paid failure has no fulfilment order: the checkout was not confirmed.
        const failed = await add('customerOrder', 'failed-checkout', {
          customerId: customer.id,
        });
        await add('paymentTransaction', 'failed-payment', {
          customerOrderId: failed.id,
          amount: 100,
          status: 'FAILED',
          sandboxReference: 'QA-FAILED',
        });
      },
      { timeout: 60000 },
    );
    writeFileSync(
      'docs/demo-scenarios.json',
      JSON.stringify({ generatedAt: now, accounts, cases }, null, 2),
    );
    console.log(
      `Created/verified ${cases.length} named scenarios. Accounts and IDs: docs/demo-scenarios.json`,
    );
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
