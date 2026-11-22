import { FulfilmentReconciliationService } from './fulfilment-reconciliation.service';

describe('FulfilmentReconciliationService.reconcileOne', () => {
  let tx: {
    $queryRaw: jest.Mock;
    branchOrder: { update: jest.Mock };
    customerOrder: { findUniqueOrThrow: jest.Mock };
  };
  let branchOrderService: { transition: jest.Mock };
  let outbox: { enqueue: jest.Mock };
  let integrity: { flagOnce: jest.Mock };
  let prisma: { $transaction: jest.Mock };
  let service: FulfilmentReconciliationService;

  function deliveredRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'bo-1',
      vendorId: 'vendor-1',
      branchId: 'branch-1',
      customerOrderId: 'co-1',
      fulfilmentMethod: 'DELIVERY',
      status: 'DELIVERED',
      deliveredAt: new Date(),
      confirmReminderSentAt: null,
      notReceivedReportedAt: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    tx = {
      $queryRaw: jest.fn(),
      branchOrder: { update: jest.fn() },
      customerOrder: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ customer: { userId: 'user-1' } }),
      },
    };
    branchOrderService = { transition: jest.fn().mockResolvedValue({}) };
    outbox = { enqueue: jest.fn().mockResolvedValue({}) };
    integrity = { flagOnce: jest.fn().mockResolvedValue(true) };
    prisma = { $transaction: jest.fn() };
    service = new FulfilmentReconciliationService(
      prisma as never,
      branchOrderService as never,
      outbox as never,
      integrity as never,
    );
  });

  it('does nothing when the order is not DELIVERED', async () => {
    tx.$queryRaw.mockResolvedValue([deliveredRow({ status: 'SENT' })]);
    await service.reconcileOne(tx as never, 'bo-1', 'corr-1');
    expect(branchOrderService.transition).not.toHaveBeenCalled();
    expect(tx.branchOrder.update).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('does nothing when the order no longer exists', async () => {
    tx.$queryRaw.mockResolvedValue([]);
    await service.reconcileOne(tx as never, 'missing', 'corr-1');
    expect(branchOrderService.transition).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('freezes the clock entirely while a "not received" report is open', async () => {
    tx.$queryRaw.mockResolvedValue([
      deliveredRow({
        deliveredAt: new Date(Date.now() - 100 * 60 * 60 * 1000), // 100h ago
        notReceivedReportedAt: new Date(),
      }),
    ]);
    await service.reconcileOne(tx as never, 'bo-1', 'corr-1');
    expect(branchOrderService.transition).not.toHaveBeenCalled();
    expect(tx.branchOrder.update).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('does nothing before 48 hours have elapsed', async () => {
    tx.$queryRaw.mockResolvedValue([
      deliveredRow({ deliveredAt: new Date(Date.now() - 10 * 60 * 60 * 1000) }),
    ]);
    await service.reconcileOne(tx as never, 'bo-1', 'corr-1');
    expect(tx.branchOrder.update).not.toHaveBeenCalled();
    expect(branchOrderService.transition).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('sends the 48h reminder exactly once, setting confirmReminderSentAt and enqueuing one outbox event', async () => {
    tx.$queryRaw.mockResolvedValue([
      deliveredRow({ deliveredAt: new Date(Date.now() - 50 * 60 * 60 * 1000) }),
    ]);
    await service.reconcileOne(tx as never, 'bo-1', 'corr-1');

    expect(tx.branchOrder.update).toHaveBeenCalledWith({
      where: { id: 'bo-1' },
      data: { confirmReminderSentAt: expect.any(Date) },
    });
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    expect(outbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'branch_order.confirm_reminder_48h',
        payload: expect.objectContaining({
          branch_order_id: 'bo-1',
          recipient_user_id: 'user-1',
        }),
      }),
      tx,
    );
    expect(branchOrderService.transition).not.toHaveBeenCalled();
  });

  it('never re-sends the reminder once confirmReminderSentAt is already set', async () => {
    tx.$queryRaw.mockResolvedValue([
      deliveredRow({
        deliveredAt: new Date(Date.now() - 50 * 60 * 60 * 1000),
        confirmReminderSentAt: new Date(),
      }),
    ]);
    await service.reconcileOne(tx as never, 'bo-1', 'corr-1');
    expect(tx.branchOrder.update).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('auto-confirms at 72 hours with a null (system) actor, and enqueues the auto-confirm notification', async () => {
    tx.$queryRaw.mockResolvedValue([
      deliveredRow({ deliveredAt: new Date(Date.now() - 80 * 60 * 60 * 1000) }),
    ]);
    await service.reconcileOne(tx as never, 'bo-1', 'corr-1');

    expect(branchOrderService.transition).toHaveBeenCalledWith(
      tx,
      'bo-1',
      'COMPLETED',
      null,
      'corr-1',
    );
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    expect(outbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'branch_order.auto_confirmed_72h',
        payload: expect.objectContaining({
          branch_order_id: 'bo-1',
          recipient_user_id: 'user-1',
        }),
      }),
      tx,
    );
  });

  it('prioritizes auto-confirm over a never-sent reminder once both thresholds are crossed (never sends both)', async () => {
    tx.$queryRaw.mockResolvedValue([
      deliveredRow({ deliveredAt: new Date(Date.now() - 90 * 60 * 60 * 1000) }),
    ]);
    await service.reconcileOne(tx as never, 'bo-1', 'corr-1');

    expect(branchOrderService.transition).toHaveBeenCalledTimes(1);
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    expect(outbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'branch_order.auto_confirmed_72h' }),
      tx,
    );
  });

  // TB-9: the reminder and the auto-confirm are DELIVERY-only.
  it.each([
    [
      'a PICKUP order in DELIVERED',
      { fulfilmentMethod: 'PICKUP' },
      'PICKUP_IN_DELIVERY_STATUS',
    ],
    [
      'a DELIVERED order with no deliveredAt',
      { deliveredAt: null },
      'DELIVERED_WITHOUT_DELIVERED_AT',
    ],
  ])(
    'never reminds, auto-confirms or notifies the customer for %s - flags it instead',
    async (_label, overrides, issue) => {
      const row = deliveredRow({
        deliveredAt: new Date(Date.now() - 100 * 60 * 60 * 1000),
        ...overrides,
      });
      tx.$queryRaw.mockResolvedValue([row]);
      await service.reconcileOne(tx as never, 'bo-1', 'corr-1');

      expect(branchOrderService.transition).not.toHaveBeenCalled();
      expect(tx.branchOrder.update).not.toHaveBeenCalled();
      expect(outbox.enqueue).not.toHaveBeenCalled();
      expect(integrity.flagOnce).toHaveBeenCalledWith(tx, row, issue, 'corr-1');
    },
  );

  it('a valid DELIVERY order is never flagged', async () => {
    tx.$queryRaw.mockResolvedValue([
      deliveredRow({ deliveredAt: new Date(Date.now() - 80 * 60 * 60 * 1000) }),
    ]);
    await service.reconcileOne(tx as never, 'bo-1', 'corr-1');
    expect(integrity.flagOnce).not.toHaveBeenCalled();
    expect(branchOrderService.transition).toHaveBeenCalledTimes(1);
  });
});

describe('FulfilmentReconciliationService.reconcileMany (TB-9 isolation)', () => {
  it('one order that throws is logged and skipped; every other order is still reconciled', async () => {
    const reached: string[] = [];
    const prisma = {
      $transaction: jest.fn((fn: (tx: unknown) => Promise<void>) => fn({})),
    };
    const service = new FulfilmentReconciliationService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(service, 'reconcileOne').mockImplementation(async (_tx, id) => {
      reached.push(id);
      if (id === 'bad')
        throw new Error(
          'Cannot move a PICKUP branch order from DELIVERED to COMPLETED',
        );
    });
    const logged = jest
      .spyOn(
        (service as unknown as { logger: { error: () => void } }).logger,
        'error',
      )
      .mockImplementation(() => undefined);

    const result = await service.reconcileMany(
      ['bad', 'ok-1', 'ok-2'],
      'corr-1',
    );

    expect(reached).toEqual(['bad', 'ok-1', 'ok-2']);
    expect(result).toEqual({ reconciled: 2, failed: 1 });
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String((logged.mock.calls[0] as unknown[])[0])).toContain('bad');
  });
});
