/**
 * Deterministic, collision-free test phone numbers shared across every
 * e2e spec file that needs one (Sprint 17 review round, item 5
 * follow-up).
 *
 * The prior scheme gave each file its own `let phoneSeq =
 * randomInt(0, 900_000) + <hand-picked offset>`. crypto.randomInt()
 * only *reduces* the probability that two files' generated ranges
 * overlap - it never eliminates it, and it is not "determinism": two
 * files running as separate parallel Jest worker processes could
 * still draw numbers landing in the same region. Worse, several of
 * the hand-picked offsets were themselves too close together (or, in
 * two cases, identical) once each lane's own 900,000-wide random draw
 * is accounted for, so the actual collision risk was never as low as
 * the offsets alone suggested.
 *
 * This replaces that with a single, auditable table: every file gets
 * a fixed index into a partition of the 7-digit national-number
 * space, so no two files' ranges can overlap *by construction* -
 * true for any number of parallel workers, any timing, every run -
 * not by probability. Numbers are handed out by a plain incrementing
 * counter, no randomness at all.
 *
 * Scope: this guarantees no collision *within a single test run*.
 * This project's own standing practice is a fresh throwaway database
 * for every clean-room/CI run (never a stale persistent one reused
 * across runs), so cross-run reuse is not a property this table needs
 * to provide - unlike the original Date.now()-seeded scheme it
 * replaced, which specifically had to survive being re-run against a
 * persistent dev database.
 */

const LANE_WIDTH = 500_000; // usable numbers per lane: base .. base + LANE_WIDTH - 1

// Order is arbitrary but stable - reordering shifts every later lane's
// numbers. That's harmless (no test asserts a literal phone value) but
// avoid it anyway for review-diff hygiene: append new lanes, don't
// reorder existing ones.
const LANES = [
  'auth',
  'sprint3-catalog',
  'sprint4-roles',
  'sprint5-store-inventory',
  'sprint6-inventory-matching',
  'sprint7-canonical-import-storefront',
  'sprint8-storefront-discovery-comparison',
  'sprint9-branch-orders-calendar',
  'sprint10-checkout-payment-pickup',
  'sprint11-orders-fulfilment-notifications',
  'sprint13-following-discovery',
  'sprint14-delivery-checkout',
  'sprint15-vendor-onboarding',
  'sprint16-moderation-concurrency',
  'sprint16-vendor-suspension',
  'sprint16-platform-verification',
  'sprint17-owner-catalog',
  'vendor-verification-owner-authorization',
] as const;

export type PhoneLane = (typeof LANES)[number];

const LANE_INDEX: Record<PhoneLane, number> = Object.fromEntries(
  LANES.map((name, i) => [name, i]),
) as Record<PhoneLane, number>;

// 18 lanes * 500_000 = 9,000,000, comfortably inside the 10,000,000-wide
// (0000000-9999999) 7-digit space this leaves per prefix, with room for
// more lanes later. Fails loudly at module load, not silently at some
// far-off runtime call, if that ever stops being true.
if (LANES.length * LANE_WIDTH > 10_000_000) {
  throw new Error(
    'e2e-phone-lanes: LANES no longer fit the 7-digit space at this LANE_WIDTH - widen the space (use both prefixes for one file) or shrink LANE_WIDTH before adding more lanes.',
  );
}

/**
 * Returns a synchronous generator handing out unique
 * `+970${prefix}XXXXXXX` numbers for one test file (or, for the
 * Sprint 16 fixtures helper, one *caller* of it - see
 * sprint16-fixtures.ts), drawn from that file's own fixed, disjoint
 * lane. `prefix` must be '56' or '59' per this project's standing
 * convention (never '57'/'58' - those parse as well-formed but are
 * not valid PS mobile numbers under the validation bundle in use).
 */
export function createUniquePhone(
  lane: PhoneLane,
  prefix: '56' | '59' = '56',
): () => string {
  const base = LANE_INDEX[lane] * LANE_WIDTH;
  let n = 0;
  return () => {
    n += 1;
    if (n >= LANE_WIDTH) {
      throw new Error(
        `e2e-phone-lanes: lane "${lane}" exhausted its ${LANE_WIDTH}-wide budget in a single run - widen LANE_WIDTH.`,
      );
    }
    return `+970${prefix}${(base + n).toString().padStart(7, '0')}`;
  };
}
