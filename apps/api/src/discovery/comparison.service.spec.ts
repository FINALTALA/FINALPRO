import { ComparisonService, EligibleOffer } from './comparison.service';

function offer(overrides: Partial<EligibleOffer>): EligibleOffer {
  return {
    offerVariantId: 'variant-1',
    offerId: 'offer-1',
    canonicalVariantId: 'cv-1',
    structuralAttributes: {},
    vendorId: 'vendor-1',
    vendorSlug: 'vendor-1-slug',
    vendorDisplayName: 'Vendor One',
    vendorLogoUrl: null,
    vendorCreatedAt: new Date('2026-01-01T00:00:00Z'),
    price: 100,
    availability: 'available',
    ...overrides,
  };
}

describe('ComparisonService', () => {
  // PrismaService is never touched by compareOffersByPrice()/buildCard()
  // - both are pure functions over already-fetched data - so an
  // undefined stand-in is fine for these unit tests. findEligibleOffers()
  // itself (the only method that touches the DB) is covered by the
  // Sprint 8 e2e spec instead.
  const service = new ComparisonService(undefined as never);

  describe('compareOffersByPrice', () => {
    it('sorts strictly by price first', () => {
      const cheap = offer({ offerVariantId: 'a', price: 50 });
      const expensive = offer({ offerVariantId: 'b', price: 150 });
      expect(service.compareOffersByPrice(cheap, expensive)).toBeLessThan(0);
      expect(service.compareOffersByPrice(expensive, cheap)).toBeGreaterThan(0);
    });

    it('breaks a price tie by the older vendor (earlier createdAt) first', () => {
      const older = offer({
        offerVariantId: 'a',
        price: 100,
        vendorCreatedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const newer = offer({
        offerVariantId: 'b',
        price: 100,
        vendorCreatedAt: new Date('2026-06-01T00:00:00Z'),
      });
      expect(service.compareOffersByPrice(older, newer)).toBeLessThan(0);
    });

    it('breaks a full tie (same price, same vendor createdAt) by offerVariantId, deterministically', () => {
      const a = offer({
        offerVariantId: 'aaa',
        price: 100,
        vendorCreatedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const b = offer({
        offerVariantId: 'bbb',
        price: 100,
        vendorCreatedAt: new Date('2026-01-01T00:00:00Z'),
      });
      expect(service.compareOffersByPrice(a, b)).toBeLessThan(0);
      expect(service.compareOffersByPrice(b, a)).toBeGreaterThan(0);
    });
  });

  describe('buildCard', () => {
    const product = {
      id: 'product-1',
      canonicalNameAr: 'منتج',
      canonicalNameEn: 'Product',
    };

    it('returns null when there are no eligible offers at all', () => {
      expect(service.buildCard(product, [])).toBeNull();
    });

    it('picks the single cheapest offer as cheapestOffer and lowestPrice', () => {
      const offers = [
        offer({ offerVariantId: 'a', vendorId: 'v1', price: 300 }),
        offer({ offerVariantId: 'b', vendorId: 'v2', price: 100 }),
        offer({ offerVariantId: 'c', vendorId: 'v3', price: 200 }),
      ];
      const card = service.buildCard(product, offers);
      expect(card?.lowestPrice).toBe(100);
      expect(card?.cheapestOffer.vendorId).toBe('v2');
    });

    it("caps store logos at 5, one entry per vendor (that vendor's own cheapest), cheapest-first", () => {
      const offers = Array.from({ length: 7 }, (_, i) =>
        offer({
          offerVariantId: `v-${i}`,
          vendorId: `vendor-${i}`,
          price: (i + 1) * 100,
        }),
      );
      const card = service.buildCard(product, offers);
      expect(card?.storeLogos).toHaveLength(5);
      expect(card?.storeLogos.map((l) => l.price)).toEqual([
        100, 200, 300, 400, 500,
      ]);
    });

    it("dedupes logos to one per vendor, using that vendor's cheapest offer even if a pricier one from the same vendor exists", () => {
      const offers = [
        offer({ offerVariantId: 'a', vendorId: 'v1', price: 100 }),
        offer({ offerVariantId: 'b', vendorId: 'v1', price: 50 }),
        offer({ offerVariantId: 'c', vendorId: 'v2', price: 80 }),
      ];
      const card = service.buildCard(product, offers);
      expect(card?.storeLogos).toHaveLength(2);
      const v1Logo = card?.storeLogos.find((l) => l.vendorId === 'v1');
      expect(v1Logo?.price).toBe(50);
    });

    it('prefers a pricier AVAILABLE offer over a cheaper sold-out one for lowestPrice', () => {
      const offers = [
        offer({
          offerVariantId: 'a',
          vendorId: 'v1',
          price: 50,
          availability: 'sold_out',
        }),
        offer({
          offerVariantId: 'b',
          vendorId: 'v2',
          price: 80,
          availability: 'available',
        }),
      ];
      const card = service.buildCard(product, offers);
      expect(card?.lowestPrice).toBe(80);
      expect(card?.lowestPriceAvailability).toBe('available');
    });

    it('falls back to the lowest price among ALL eligible offers when every one is sold out', () => {
      const offers = [
        offer({
          offerVariantId: 'a',
          vendorId: 'v1',
          price: 120,
          availability: 'sold_out',
        }),
        offer({
          offerVariantId: 'b',
          vendorId: 'v2',
          price: 90,
          availability: 'sold_out',
        }),
      ];
      const card = service.buildCard(product, offers);
      expect(card?.lowestPrice).toBe(90);
      expect(card?.lowestPriceAvailability).toBe('sold_out');
    });
  });
});
