import {
  BranchOrderPaymentMethod,
  BranchOrderStatus,
  FulfilmentMethod,
} from '../../generated/prisma/client';
import { allowedNextStates } from './branch-order-state-machine';
import { branchOrderIntegrityIssue } from './branch-order-integrity.service';

const STATUSES = Object.values(BranchOrderStatus);
const METHODS = Object.values(FulfilmentMethod);
const PAYMENTS = Object.values(BranchOrderPaymentMethod);

/** Every status the state machine can reach for this method, from
 * PLACED, over every payment method and delivery-attempt count. */
function reachable(method: FulfilmentMethod): Set<BranchOrderStatus> {
  const seen = new Set<BranchOrderStatus>(['PLACED']);
  const queue: BranchOrderStatus[] = ['PLACED'];
  while (queue.length) {
    const from = queue.shift()!;
    for (const payment of PAYMENTS) {
      for (const attempts of [0, 1, 2, 3]) {
        for (const to of allowedNextStates(from, method, payment, attempts)) {
          if (!seen.has(to)) {
            seen.add(to);
            queue.push(to);
          }
        }
      }
    }
  }
  return seen;
}

describe('branchOrderIntegrityIssue (TB-9)', () => {
  for (const method of METHODS) {
    const ok = reachable(method);
    for (const status of STATUSES) {
      const deliveredAt = status === 'DELIVERED' ? new Date() : null;
      it(`${method} in ${status}: ${ok.has(status) ? 'valid' : 'flagged'} - matches the state machine`, () => {
        const issue = branchOrderIntegrityIssue({
          fulfilmentMethod: method,
          status,
          deliveredAt,
        });
        expect(issue === null).toBe(ok.has(status));
      });
    }
  }

  it('a PICKUP order never reaches DELIVERED; a DELIVERY order never reaches PICKED_UP', () => {
    expect(reachable('PICKUP').has('DELIVERED')).toBe(false);
    expect(reachable('DELIVERY').has('PICKED_UP')).toBe(false);
    expect(
      branchOrderIntegrityIssue({
        fulfilmentMethod: 'PICKUP',
        status: 'DELIVERED',
        deliveredAt: new Date(),
      }),
    ).toBe('PICKUP_IN_DELIVERY_STATUS');
    expect(
      branchOrderIntegrityIssue({
        fulfilmentMethod: 'DELIVERY',
        status: 'PICKED_UP',
        deliveredAt: null,
      }),
    ).toBe('DELIVERY_IN_PICKUP_STATUS');
  });

  it('a DELIVERY order in DELIVERED with no deliveredAt is flagged', () => {
    expect(
      branchOrderIntegrityIssue({
        fulfilmentMethod: 'DELIVERY',
        status: 'DELIVERED',
        deliveredAt: null,
      }),
    ).toBe('DELIVERED_WITHOUT_DELIVERED_AT');
  });
});
