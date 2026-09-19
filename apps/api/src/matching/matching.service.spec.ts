import { MatchingService } from './matching.service';

describe('MatchingService', () => {
  let prisma: {
    canonicalProductVariant: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
    };
  };
  let service: MatchingService;

  beforeEach(() => {
    prisma = {
      canonicalProductVariant: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
    };
    service = new MatchingService(prisma as never);
  });

  describe('GTIN/EAN/UPC/ISBN (globally unique lookup)', () => {
    it('auto-links when exactly one canonical variant has this gtin (BR-001)', async () => {
      prisma.canonicalProductVariant.findUnique.mockResolvedValue({
        id: 'variant-1',
        canonicalProductId: 'product-1',
      });

      const result = await service.findExactMatch('GTIN', '0194253000001');

      expect(result).toEqual({
        canonicalVariantId: 'variant-1',
        canonicalProductId: 'product-1',
      });
      expect(prisma.canonicalProductVariant.findUnique).toHaveBeenCalledWith({
        where: { gtin: '0194253000001' },
        select: { id: true, canonicalProductId: true },
      });
    });

    it('leaves it unmatched when no canonical variant has this gtin (FR-MATCH-009)', async () => {
      prisma.canonicalProductVariant.findUnique.mockResolvedValue(null);

      const result = await service.findExactMatch('EAN', 'no-such-code');

      expect(result).toEqual({
        canonicalVariantId: null,
        canonicalProductId: null,
      });
    });
  });

  describe('MPN (unique only within a canonical product per Part 3)', () => {
    it('auto-links when exactly one canonical variant has this mpn', async () => {
      prisma.canonicalProductVariant.findMany.mockResolvedValue([
        { id: 'variant-1', canonicalProductId: 'product-1' },
      ]);

      const result = await service.findExactMatch('MPN', 'MPN-123');

      expect(result).toEqual({
        canonicalVariantId: 'variant-1',
        canonicalProductId: 'product-1',
      });
    });

    it('leaves it unmatched (not arbitrarily linked) when the mpn is ambiguous across products', async () => {
      // A bare MPN isn't globally unique (Part 3) - two unrelated
      // products could each have a variant with this same MPN. BR-001's
      // auto-link path only ever applies to an unambiguous exact match,
      // so this must not silently pick one of the two candidates.
      prisma.canonicalProductVariant.findMany.mockResolvedValue([
        { id: 'variant-1', canonicalProductId: 'product-1' },
        { id: 'variant-2', canonicalProductId: 'product-2' },
      ]);

      const result = await service.findExactMatch('MPN', 'AMBIGUOUS-MPN');

      expect(result).toEqual({
        canonicalVariantId: null,
        canonicalProductId: null,
      });
    });

    it('leaves it unmatched when no canonical variant has this mpn', async () => {
      prisma.canonicalProductVariant.findMany.mockResolvedValue([]);

      const result = await service.findExactMatch('MPN', 'NO-SUCH-MPN');

      expect(result).toEqual({
        canonicalVariantId: null,
        canonicalProductId: null,
      });
    });
  });
});
