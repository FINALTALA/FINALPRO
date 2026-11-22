import {
  isReturnStoreEventType,
  RETURN_STORE_EVENT_TYPES,
  StoreMemberCandidate,
  storeReturnRecipients,
  storeReturnSafeData,
} from './return-store-events';

const BRANCH = 'branch-a';
const member = (
  userId: string,
  over: Partial<StoreMemberCandidate> = {},
): StoreMemberCandidate => ({
  userId,
  role: 'BRANCH_EMPLOYEE',
  status: 'ACTIVE',
  branchId: BRANCH,
  userDeactivated: false,
  ...over,
});

describe('TB-15 store return events (pure)', () => {
  it('maps exactly the three transitions to the three new types', () => {
    expect(RETURN_STORE_EVENT_TYPES).toEqual({
      'return.platform_approved_for_store': 'RETURN_PLATFORM_APPROVED',
      'return.platform_rejected_for_store': 'RETURN_PLATFORM_REJECTED',
      'return.cancelled_for_store': 'RETURN_CANCELLED_BY_CUSTOMER',
    });
    expect(isReturnStoreEventType('return.cancelled_for_store')).toBe(true);
    // The customer-side and TB-14 types are NOT handled by this path.
    for (const t of ['return.approved', 'return.requested', 'toString']) {
      expect(isReturnStoreEventType(t)).toBe(false);
    }
  });

  it('recipients: active owners and active employees of the order branch only', () => {
    const got = storeReturnRecipients(
      [
        member('owner', { role: 'OWNER', branchId: null }),
        member('emp-same'),
        member('emp-other', { branchId: 'branch-b' }),
        member('emp-suspended', { status: 'SUSPENDED' }),
        member('owner-suspended', { role: 'OWNER', status: 'SUSPENDED' }),
        member('emp-deactivated', { userDeactivated: true }),
        member('owner-deactivated', { role: 'OWNER', userDeactivated: true }),
        member('emp-no-branch', { branchId: null }),
      ],
      BRANCH,
      null,
      false,
    );
    expect(got).toEqual(['emp-same', 'owner']);
  });

  it('a SUSPENDED store: active owners only - no employee at all, and still no suspended or deactivated member', () => {
    const got = storeReturnRecipients(
      [
        member('owner', { role: 'OWNER', branchId: null }),
        member('emp-same'),
        member('emp-other', { branchId: 'branch-b' }),
        member('emp-suspended', { status: 'SUSPENDED' }),
        member('owner-suspended', { role: 'OWNER', status: 'SUSPENDED' }),
        member('owner-deactivated', { role: 'OWNER', userDeactivated: true }),
      ],
      BRANCH,
      null,
      true,
    );
    expect(got).toEqual(['owner']);
    // ...and the person who made the change is still left out.
    expect(
      storeReturnRecipients(
        [
          member('owner', { role: 'OWNER' }),
          member('owner2', { role: 'OWNER' }),
        ],
        BRANCH,
        'owner2',
        true,
      ),
    ).toEqual(['owner']);
  });

  it('the person who made the change is left out', () => {
    expect(
      storeReturnRecipients(
        [member('owner', { role: 'OWNER' }), member('emp-same')],
        BRANCH,
        'emp-same',
        false,
      ),
    ).toEqual(['owner']);
  });

  it('a user listed as owner and as employee of the same branch is notified once', () => {
    expect(
      storeReturnRecipients(
        [member('u1', { role: 'OWNER' }), member('u1'), member('u1')],
        BRANCH,
        null,
        false,
      ),
    ).toEqual(['u1']);
  });

  it('data: only the outcome code on an approval, nothing anywhere else', () => {
    expect(
      storeReturnSafeData('return.platform_approved_for_store', 'RETURN'),
    ).toEqual({ outcome: 'RETURN' });
    expect(
      storeReturnSafeData('return.platform_approved_for_store', 'EXCHANGE'),
    ).toEqual({ outcome: 'EXCHANGE' });
    expect(
      storeReturnSafeData('return.platform_approved_for_store', 'free text'),
    ).toEqual({});
    expect(
      storeReturnSafeData('return.platform_rejected_for_store', 'RETURN'),
    ).toEqual({});
    expect(storeReturnSafeData('return.cancelled_for_store', 'RETURN')).toEqual(
      {},
    );
  });
});
