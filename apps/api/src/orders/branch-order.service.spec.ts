import { ConflictException, NotFoundException } from '@nestjs/common';
import { BranchOrderService } from './branch-order.service';

describe('BranchOrderService.transition', () => {
  let tx: {
    $queryRaw: jest.Mock;
    branchOrder: { update: jest.Mock };
    customerOrder: { findUnique: jest.Mock };
  };
  let auditLog: { record: jest.Mock };
  let outbox: { enqueue: jest.Mock };
  let service: BranchOrderService;

  beforeEach(() => {
    tx = {
      $queryRaw: jest.fn(),
      branchOrder: { update: jest.fn() },
      customerOrder: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ customer: { userId: 'customer-user' } }),
      },
    };
    auditLog = { record: jest.fn().mockResolvedValue(undefined) };
    outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
    service = new BranchOrderService(auditLog as never, outbox as never);
  });

  it('locks the row, applies a legal transition, and audits before/after status', async () => {
    tx.$queryRaw.mockResolvedValue([
      {
        id: 'bo-1',
        status: 'PLACED',
        fulfilmentMethod: 'DELIVERY',
        paymentMethod: 'ONLINE',
      },
    ]);
    tx.branchOrder.update.mockResolvedValue({
      id: 'bo-1',
      status: 'PREPARING',
    });

    const result = await service.transition(
      tx as never,
      'bo-1',
      'PREPARING',
      'user-1',
      'corr-1',
    );

    expect(result).toEqual({ id: 'bo-1', status: 'PREPARING' });
    expect(tx.branchOrder.update).toHaveBeenCalledWith({
      where: { id: 'bo-1' },
      data: { status: 'PREPARING' },
    });
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'user-1',
        correlationId: 'corr-1',
        action: 'branch_order.status_changed',
        entityType: 'BranchOrder',
        entityId: 'bo-1',
        beforeState: { status: 'PLACED' },
        afterState: { status: 'PREPARING' },
      }),
      tx,
    );
  });

  it('throws NotFoundException when the branch order does not exist, and never writes anything', async () => {
    tx.$queryRaw.mockResolvedValue([]);

    await expect(
      service.transition(
        tx as never,
        'missing',
        'PREPARING',
        'user-1',
        'corr-1',
      ),
    ).rejects.toThrow(NotFoundException);
    expect(tx.branchOrder.update).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('throws ConflictException for an illegal transition, and never writes anything', async () => {
    tx.$queryRaw.mockResolvedValue([
      {
        id: 'bo-1',
        status: 'SENT',
        fulfilmentMethod: 'DELIVERY',
        paymentMethod: 'ONLINE',
      },
    ]);

    await expect(
      service.transition(tx as never, 'bo-1', 'CANCELLED', 'user-1', 'corr-1'),
    ).rejects.toThrow(ConflictException);
    expect(tx.branchOrder.update).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('is fulfilment-method-aware: SENT is illegal for a PICKUP order even from PREPARING', async () => {
    tx.$queryRaw.mockResolvedValue([
      {
        id: 'bo-1',
        status: 'PREPARING',
        fulfilmentMethod: 'PICKUP',
        paymentMethod: 'ONLINE',
      },
    ]);

    await expect(
      service.transition(tx as never, 'bo-1', 'SENT', 'user-1', 'corr-1'),
    ).rejects.toThrow(ConflictException);
  });

  it('is payment-method-aware: REFUNDED is illegal for a COD order even from PLACED (PDR-025 - nothing was charged online to refund)', async () => {
    tx.$queryRaw.mockResolvedValue([
      {
        id: 'bo-1',
        status: 'PLACED',
        fulfilmentMethod: 'PICKUP',
        paymentMethod: 'COD',
      },
    ]);

    await expect(
      service.transition(tx as never, 'bo-1', 'REFUNDED', 'user-1', 'corr-1'),
    ).rejects.toThrow(ConflictException);
    expect(tx.branchOrder.update).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('merges extraData into the same atomic update() call as the status write (Sprint 11)', async () => {
    tx.$queryRaw.mockResolvedValue([
      {
        id: 'bo-1',
        status: 'SENT',
        fulfilmentMethod: 'DELIVERY',
        paymentMethod: 'ONLINE',
      },
    ]);
    const deliveredAt = new Date('2026-09-26T12:00:00.000Z');
    tx.branchOrder.update.mockResolvedValue({
      id: 'bo-1',
      status: 'DELIVERED',
      deliveredAt,
    });

    await service.transition(
      tx as never,
      'bo-1',
      'DELIVERED',
      'user-1',
      'corr-1',
      { deliveredAt },
    );

    expect(tx.branchOrder.update).toHaveBeenCalledWith({
      where: { id: 'bo-1' },
      data: { deliveredAt, status: 'DELIVERED' },
    });
  });

  it('accepts a null actorId for a system-triggered transition (Sprint 11 auto-confirm)', async () => {
    tx.$queryRaw.mockResolvedValue([
      {
        id: 'bo-1',
        status: 'DELIVERED',
        fulfilmentMethod: 'DELIVERY',
        paymentMethod: 'ONLINE',
      },
    ]);
    tx.branchOrder.update.mockResolvedValue({
      id: 'bo-1',
      status: 'COMPLETED',
    });

    await service.transition(tx as never, 'bo-1', 'COMPLETED', null, 'corr-1');

    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: null }),
      tx,
    );
  });

  it('PD-3: reaching COMPLETED invites the customer to review, in the same transaction', async () => {
    tx.$queryRaw.mockResolvedValue([
      {
        id: 'bo-1',
        status: 'DELIVERED',
        fulfilmentMethod: 'DELIVERY',
        paymentMethod: 'ONLINE',
      },
    ]);
    tx.branchOrder.update.mockResolvedValue({
      id: 'bo-1',
      status: 'COMPLETED',
      customerOrderId: 'co-1',
      vendorId: 'v-1',
      branchId: 'b-1',
    });

    await service.transition(tx as never, 'bo-1', 'COMPLETED', 'u', 'corr-1');

    expect(outbox.enqueue).toHaveBeenCalledWith(
      {
        eventType: 'branch_order.review_invitation',
        audience: 'CUSTOMER',
        payload: {
          branch_order_id: 'bo-1',
          vendor_id: 'v-1',
          branch_id: 'b-1',
          recipient_user_id: 'customer-user',
        },
      },
      tx,
    );
  });

  it('PD-3: any other transition sends no review invitation', async () => {
    tx.$queryRaw.mockResolvedValue([
      {
        id: 'bo-1',
        status: 'PLACED',
        fulfilmentMethod: 'DELIVERY',
        paymentMethod: 'ONLINE',
      },
    ]);
    tx.branchOrder.update.mockResolvedValue({
      id: 'bo-1',
      status: 'PREPARING',
    });
    await service.transition(tx as never, 'bo-1', 'PREPARING', 'u', 'corr-1');
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('allows REFUNDED for an ONLINE order from PLACED', async () => {
    tx.$queryRaw.mockResolvedValue([
      {
        id: 'bo-1',
        status: 'PLACED',
        fulfilmentMethod: 'PICKUP',
        paymentMethod: 'ONLINE',
      },
    ]);
    tx.branchOrder.update.mockResolvedValue({ id: 'bo-1', status: 'REFUNDED' });

    const result = await service.transition(
      tx as never,
      'bo-1',
      'REFUNDED',
      'user-1',
      'corr-1',
    );
    expect(result.status).toBe('REFUNDED');
  });
});
