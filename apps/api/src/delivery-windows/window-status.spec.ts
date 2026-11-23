import { BranchOrderStatus } from '../../generated/prisma/client';
import {
  ACTIVE_BRANCH_ORDER_STATUSES,
  TERMINAL_BRANCH_ORDER_STATUSES,
} from '../orders/branch-order-state-machine';
import { windowStartInstant } from '../checkout/delivery-calendar.util';
import { slotStatus, type SlotFacts } from './window-status';

// «نوافذ التوصيل v1»: the one window-state rule, pinned clock.
const DATE = new Date('2026-12-10T00:00:00.000Z'); // a Thursday
const START = 10 * 60; // 10:00 Palestine time
const END = 12 * 60;
const startInstant = windowStartInstant(DATE, START);
const before = (minutes: number) =>
  new Date(startInstant.getTime() - minutes * 60_000);

function facts(over: Partial<SlotFacts> = {}): SlotFacts {
  return {
    date: DATE,
    window: {
      startMinute: START,
      endMinute: END,
      capacity: 3,
      pausedAt: null,
      pausedReason: null,
    },
    exception: null,
    closures: [],
    activeOrders: 0,
    activeHolds: 0,
    leadMinutes: 60,
    now: before(24 * 60),
    ...over,
  };
}

describe('window-status (delivery windows v1)', () => {
  it('ACTIVE + TERMINAL are exactly the BranchOrderStatus enum, with no overlap', () => {
    const all = Object.values(BranchOrderStatus).sort();
    const union = [
      ...ACTIVE_BRANCH_ORDER_STATUSES,
      ...TERMINAL_BRANCH_ORDER_STATUSES,
    ].sort();
    expect(union).toEqual(all);
    expect(
      ACTIVE_BRANCH_ORDER_STATUSES.filter((s) =>
        TERMINAL_BRANCH_ORDER_STATUSES.includes(s),
      ),
    ).toEqual([]);
  });

  it('OPEN, with remaining = capacity - orders - holds and the booking deadline', () => {
    const r = slotStatus(facts({ activeOrders: 1, activeHolds: 1 }));
    expect(r.status).toBe('OPEN');
    expect(r.remaining).toBe(1);
    expect(r.bookingDeadline.toISOString()).toBe(before(60).toISOString());
  });

  it('FULL when orders + holds reach the capacity', () => {
    expect(slotStatus(facts({ activeOrders: 2, activeHolds: 1 })).status).toBe(
      'FULL',
    );
  });

  it('CUTOFF_PASSED inside the lead time, and once the window started', () => {
    expect(slotStatus(facts({ now: before(30) })).status).toBe('CUTOFF_PASSED');
    expect(slotStatus(facts({ now: before(-5) })).status).toBe('CUTOFF_PASSED');
  });

  it('PAST once the window ended', () => {
    const after = new Date(windowStartInstant(DATE, END).getTime() + 1000);
    expect(slotStatus(facts({ now: after })).status).toBe('PAST');
  });

  it('priority: PAST > CLOSED > PAUSED > BOOKING_STOPPED > CUTOFF_PASSED > FULL > OPEN', () => {
    const everything = facts({
      window: {
        startMinute: START,
        endMinute: END,
        capacity: 1,
        pausedAt: new Date(),
        pausedReason: 'p',
      },
      exception: {
        isClosed: false,
        bookingStopped: true,
        capacityOverride: null,
        reason: 's',
      },
      closures: [{ startsAt: before(120), endsAt: before(-30), reason: 'eid' }],
      activeOrders: 1,
      now: before(30),
    });
    expect(slotStatus(everything)).toMatchObject({
      status: 'CLOSED',
      closedSource: 'BRANCH_CLOSURE',
      reason: 'eid',
    });
    expect(slotStatus({ ...everything, closures: [] })).toMatchObject({
      status: 'PAUSED',
      reason: 'p',
    });
    expect(
      slotStatus({
        ...everything,
        closures: [],
        window: { ...everything.window, pausedAt: null },
      }),
    ).toMatchObject({ status: 'BOOKING_STOPPED', reason: 's' });
    expect(
      slotStatus({
        ...everything,
        closures: [],
        exception: null,
        window: { ...everything.window, pausedAt: null },
      }).status,
    ).toBe('CUTOFF_PASSED');
    expect(
      slotStatus({
        ...everything,
        closures: [],
        exception: null,
        now: before(24 * 60),
        window: { ...everything.window, pausedAt: null },
      }).status,
    ).toBe('FULL');
    const closedDate = facts({
      exception: {
        isClosed: true,
        bookingStopped: false,
        capacityOverride: null,
        reason: 'x',
      },
    });
    expect(slotStatus(closedDate)).toMatchObject({
      status: 'CLOSED',
      closedSource: 'DATE',
    });
  });

  it('a planned branch closure counts only when it overlaps the window time (half-open)', () => {
    const endInstant = windowStartInstant(DATE, END);
    const touchingBefore = facts({
      closures: [{ startsAt: before(300), endsAt: startInstant, reason: null }],
    });
    const touchingAfter = facts({
      closures: [
        {
          startsAt: endInstant,
          endsAt: new Date(endInstant.getTime() + 3_600_000),
          reason: null,
        },
      ],
    });
    const overlapping = facts({
      closures: [{ startsAt: before(10), endsAt: before(-10), reason: null }],
    });
    expect(slotStatus(touchingBefore).status).toBe('OPEN');
    expect(slotStatus(touchingAfter).status).toBe('OPEN');
    expect(slotStatus(overlapping).status).toBe('CLOSED');
  });
});
