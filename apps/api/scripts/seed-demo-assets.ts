/**
 * Sprint 13: attaches the original demo artwork (apps/web/public/
 * demo-assets) to the two demo stores and their demo products, so the
 * demo storefronts render real logos/covers/images instead of letter
 * placeholders. Data only - no schema change, no upload backend.
 *
 * Safe by construction:
 *  - same local-database guard as seed-demo.ts (host + database name);
 *  - never overwrites a value that is already set (only fills logoUrl,
 *    coverImageUrl, coverColor, bio when null, and adds a PRIMARY image
 *    only to a demo variant that has no media at all);
 *  - never deletes anything;
 *  - runs in one transaction;
 *  - re-running is a no-op.
 *
 * Run AFTER scripts/seed-demo.ts (it only decorates existing demo rows):
 *   npx ts-node scripts/seed-demo-assets.ts
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import {
  OFFER_ONE_SELLER_SKU,
  OFFER_TWO_SELLER_SKU,
  VENDOR_ONE,
  VENDOR_TWO,
} from './seed-demo.constants';
import { requireLocalDatabase } from './local-db-guard';

const STORE_ASSETS = [
  {
    slug: VENDOR_ONE.slug,
    logoUrl: '/demo-assets/store-fashion-house-logo.svg',
    coverImageUrl: '/demo-assets/store-fashion-house-cover.svg',
    coverColor: '#12233f',
    bio: 'متجر تجريبي للأزياء النسائية الأنيقة - بيانات عرض فقط.',
    sellerSku: OFFER_ONE_SELLER_SKU,
  },
  {
    slug: VENDOR_TWO.slug,
    logoUrl: '/demo-assets/store-style-corner-logo.svg',
    coverImageUrl: '/demo-assets/store-style-corner-cover.svg',
    coverColor: '#bfd8d2',
    bio: 'ركن تجريبي للقطع اليومية العملية - بيانات عرض فقط.',
    sellerSku: OFFER_TWO_SELLER_SKU,
  },
] as const;

const PRODUCT_IMAGE = '/demo-assets/product-shirt-white.svg';

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  requireLocalDatabase(connectionString);
  const prisma = new PrismaClient({ adapter: new PrismaPg(connectionString) });

  try {
    await prisma.$transaction(async (tx) => {
      for (const asset of STORE_ASSETS) {
        const vendor = await tx.vendor.findUnique({
          where: { slug: asset.slug },
        });
        if (!vendor) {
          console.log(
            `  ${asset.slug}: not found - run scripts/seed-demo.ts first, skipped.`,
          );
          continue;
        }

        const fill: {
          logoUrl?: string;
          coverImageUrl?: string;
          coverColor?: string;
          bio?: string;
        } = {};
        if (vendor.logoUrl === null) fill.logoUrl = asset.logoUrl;
        if (vendor.coverImageUrl === null)
          fill.coverImageUrl = asset.coverImageUrl;
        if (vendor.coverColor === null) fill.coverColor = asset.coverColor;
        if (vendor.bio === null) fill.bio = asset.bio;
        if (Object.keys(fill).length > 0) {
          await tx.vendor.update({ where: { id: vendor.id }, data: fill });
          console.log(
            `  ${asset.slug}: filled ${Object.keys(fill).join(', ')}.`,
          );
        } else {
          console.log(`  ${asset.slug}: store assets already set - untouched.`);
        }

        const variant = await tx.offerVariant.findUnique({
          where: {
            vendorId_sellerSku: {
              vendorId: vendor.id,
              sellerSku: asset.sellerSku,
            },
          },
          include: { media: { select: { id: true } } },
        });
        if (!variant) {
          console.log(`  ${asset.slug}: demo variant not found - skipped.`);
        } else if (variant.media.length === 0) {
          await tx.offerVariantMedia.create({
            data: {
              vendorId: vendor.id,
              offerVariantId: variant.id,
              url: PRODUCT_IMAGE,
              kind: 'PRIMARY',
            },
          });
          console.log(`  ${asset.slug}: demo product image added.`);
        } else {
          console.log(
            `  ${asset.slug}: product media already present - untouched.`,
          );
        }
      }
    });
    console.log('Demo assets done.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
