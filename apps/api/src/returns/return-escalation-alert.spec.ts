import { enqueueReturnEscalationAlert } from './return-escalation-alert';

// TB-14: the escalation alert goes to whoever TB-12.2's resolver names
// for RETURN_ESCALATION - its subscribers, or (FALLBACK) every active
// administrator - one outbox row each, with the return id and the
// fixed reason only. The resolver's own policy is tested in
// tb12-alert-recipients.e2e-spec.ts; this pins how the alert uses it.
describe('enqueueReturnEscalationAlert', () => {
  const tx = {} as never;

  async function run(mode: 'SUBSCRIBED' | 'FALLBACK', userIds: string[]) {
    const enqueue = jest.fn().mockResolvedValue({});
    const resolve = jest.fn().mockResolvedValue({ userIds, mode });
    await enqueueReturnEscalationAlert(
      tx,
      { enqueue } as never,
      { resolve } as never,
      'ret-1',
      'CUSTOMER_DISPUTE',
    );
    expect(resolve).toHaveBeenCalledWith(tx, 'RETURN_ESCALATION');
    return enqueue;
  }

  it.each(['SUBSCRIBED', 'FALLBACK'] as const)(
    '%s: one row per resolved recipient, the return id and the reason only',
    async (mode) => {
      const enqueue = await run(mode, ['a1', 'a2']);
      expect(enqueue.mock.calls).toEqual([
        [
          {
            eventType: 'return.escalation_alert',
            audience: 'PLATFORM',
            payload: {
              return_id: 'ret-1',
              reason: 'CUSTOMER_DISPUTE',
              recipient_user_id: 'a1',
            },
          },
          tx,
        ],
        [
          {
            eventType: 'return.escalation_alert',
            audience: 'PLATFORM',
            payload: {
              return_id: 'ret-1',
              reason: 'CUSTOMER_DISPUTE',
              recipient_user_id: 'a2',
            },
          },
          tx,
        ],
      ]);
    },
  );

  it('nobody to tell (no active administrator at all): no row', async () => {
    expect(await run('FALLBACK', [])).not.toHaveBeenCalled();
  });
});
