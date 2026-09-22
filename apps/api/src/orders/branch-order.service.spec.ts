import { ConflictException, NotFoundException } from '@nestjs/common';
import { BranchOrderService } from './branch-order.service';

describe('BranchOrderService.transition', () => {
  let tx: {
    $queryRaw: jest.Mock;
    branchOrder: { update: jest.Mock };
  };
  let auditLog: { record: jest.Mock };
  let service: BranchOrderService;

  beforeEach(() => {
    tx = {
      $queryRaw: jest.fn(),
      branchOrder: { update: jest.fn() },
    };
    auditLog = { record: jest.fn().mockResolvedValue(undefined) };
    service = new BranchOrderService(auditLog as never);
  });

  it('locks the row, applies a legal transition, and audits before/after status', async () => {
    tx.$queryRaw.mockResolvedValue([
      { id: 'bo-1', status: 'PLACED', fulfilmentMethod: 'DELIVERY' },
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
      { id: 'bo-1', status: 'SENT', fulfilmentMethod: 'DELIVERY' },
    ]);

    await expect(
      service.transition(tx as never, 'bo-1', 'CANCELLED', 'user-1', 'corr-1'),
    ).rejects.toThrow(ConflictException);
    expect(tx.branchOrder.update).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('is fulfilment-method-aware: SENT is illegal for a PICKUP order even from PREPARING', async () => {
    tx.$queryRaw.mockResolvedValue([
      { id: 'bo-1', status: 'PREPARING', fulfilmentMethod: 'PICKUP' },
    ]);

    await expect(
      service.transition(tx as never, 'bo-1', 'SENT', 'user-1', 'corr-1'),
    ).rejects.toThrow(ConflictException);
  });
});
