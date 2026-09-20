import { generateVendorSlug } from './slug.util';

describe('slug.util', () => {
  // Review-round fix (Sprint 7 round 2): an earlier version truncated the
  // id-derived suffix to the first 6 hex characters (24 bits) before
  // claiming that alone guaranteed uniqueness - it didn't, the exact same
  // mistake already caught once for barcode.util.ts. These two ids
  // deliberately share that exact prefix and differ only later in the
  // string, to prove the fix no longer depends on just the first 6
  // characters.
  const idA = '11111111-1111-1111-1111-111111111111';
  const idB = '11111111-1111-2222-3333-444444444444';

  it('does not collide for two ids sharing the same first 6 hex characters', () => {
    expect(generateVendorSlug('Some Store', idA)).not.toBe(
      generateVendorSlug('Some Store', idB),
    );
  });

  it('derives the slug from the FULL id (dashes stripped), not a truncated prefix', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(generateVendorSlug('My Store', id)).toBe(
      'my-store-aaaaaaaabbbbccccddddeeeeeeeeeeee',
    );
  });

  // Matches migration 20260922100000's SQL backfill exactly: a legalName
  // that collapses to nothing under the slugify regexes (entirely
  // non-ASCII, e.g. purely Arabic) must fall back to the bare full id
  // alone, no leading/stray dash - not NULL (the bug this test guards
  // against) and not a lone "-" prefix.
  it('falls back to the bare full id, with no leading dash, for a legalName that collapses to nothing (e.g. purely Arabic)', () => {
    const id = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    const slug = generateVendorSlug('متجر الأمل', id);
    expect(slug).toBe('bbbbbbbbccccddddeeeeffffffffffff');
    expect(slug.startsWith('-')).toBe(false);
    expect(slug).toMatch(/^[a-z0-9-]+$/);
  });

  it('is deterministic - the same inputs always derive the same slug', () => {
    const id = '22222222-2222-2222-2222-222222222222';
    expect(generateVendorSlug('Repeat Store', id)).toBe(
      generateVendorSlug('Repeat Store', id),
    );
  });
});
