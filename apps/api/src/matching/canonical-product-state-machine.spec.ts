import {
  allowedNextCanonicalProductStatuses,
  canTransitionCanonicalProduct,
} from './canonical-product-state-machine';
import { CanonicalProductStatus } from '../../generated/prisma/client';

const ALL_STATUSES: CanonicalProductStatus[] = [
  'DRAFT',
  'PENDING_REVIEW',
  'PUBLISHED',
  'ARCHIVED',
  'MERGED',
];

const VALID_TRANSITIONS: [CanonicalProductStatus, CanonicalProductStatus][] = [
  ['DRAFT', 'PENDING_REVIEW'],
  ['DRAFT', 'ARCHIVED'],
  ['PENDING_REVIEW', 'PUBLISHED'],
  ['PENDING_REVIEW', 'DRAFT'],
  ['PUBLISHED', 'ARCHIVED'],
  ['ARCHIVED', 'PUBLISHED'],
];

describe('canonical-product-state-machine', () => {
  it('allows exactly the documented valid transitions', () => {
    for (const [from, to] of VALID_TRANSITIONS) {
      expect(canTransitionCanonicalProduct(from, to)).toBe(true);
    }
  });

  it('rejects every transition not explicitly listed as valid, for every state pair', () => {
    const validSet = new Set(VALID_TRANSITIONS.map(([f, t]) => `${f}->${t}`));
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const expected = validSet.has(`${from}->${to}`);
        expect(canTransitionCanonicalProduct(from, to)).toBe(expected);
      }
    }
  });

  it('rejects re-entering the same state (no-op transitions)', () => {
    for (const s of ALL_STATUSES) {
      expect(canTransitionCanonicalProduct(s, s)).toBe(false);
    }
  });

  it('MERGED has no outgoing transitions and is never a valid target', () => {
    expect(allowedNextCanonicalProductStatuses('MERGED')).toEqual([]);
    for (const from of ALL_STATUSES) {
      expect(canTransitionCanonicalProduct(from, 'MERGED')).toBe(false);
    }
  });

  it('PUBLISHED cannot go directly back to DRAFT or PENDING_REVIEW', () => {
    expect(canTransitionCanonicalProduct('PUBLISHED', 'DRAFT')).toBe(false);
    expect(canTransitionCanonicalProduct('PUBLISHED', 'PENDING_REVIEW')).toBe(
      false,
    );
  });

  it('ARCHIVED cannot go directly to DRAFT or PENDING_REVIEW', () => {
    expect(canTransitionCanonicalProduct('ARCHIVED', 'DRAFT')).toBe(false);
    expect(canTransitionCanonicalProduct('ARCHIVED', 'PENDING_REVIEW')).toBe(
      false,
    );
  });

  it('allowedNextCanonicalProductStatuses matches canTransition exactly', () => {
    for (const from of ALL_STATUSES) {
      const allowed = allowedNextCanonicalProductStatuses(from);
      for (const to of ALL_STATUSES) {
        expect(allowed.includes(to)).toBe(
          canTransitionCanonicalProduct(from, to),
        );
      }
    }
  });
});
