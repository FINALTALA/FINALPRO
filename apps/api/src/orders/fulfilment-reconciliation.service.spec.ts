import { FulfilmentReconciliationService } from './fulfilment-reconciliation.service';

describe('FulfilmentReconciliationService.reconcileOne', () => {
  let tx: {
    $queryRaw: jest.Mock;
    branchOrder: { update: jest.Mock };
    customerOrder: { findUniqueOrThrow: jest.Mock };
  };
  let branchOrderService: { transition: jest.Mock };
  let outbox: { enqueue: jest.Mock };
  let service: FulfilmentReconciliationService;

  function deliveredRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'bo-1',
      vendorId: 'vendor-1',
      branchId: 'branch-1',
      customerOrderId: 'co-1',
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
    service = new FulfilmentReconciliationService(
      { $transaction: jest.fn() } as never,
      branchOrderService as never,
      outbox as never,
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
});
