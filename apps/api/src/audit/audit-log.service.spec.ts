import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from './audit-log.service';

describe('AuditLogService', () => {
  let service: AuditLogService;
  let prisma: { auditLog: { create: jest.Mock } };

  beforeEach(async () => {
    prisma = {
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditLogService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(AuditLogService);
  });

  it('writes an audit row with the given actor, correlation id, action, and entity', async () => {
    await service.record({
      actorId: 'user-1',
      correlationId: 'corr-1',
      action: 'vendor.suspended',
      entityType: 'Vendor',
      entityId: 'vendor-1',
      beforeState: { status: 'Active' },
      afterState: { status: 'Suspended' },
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'user-1',
        correlationId: 'corr-1',
        action: 'vendor.suspended',
        entityType: 'Vendor',
        entityId: 'vendor-1',
      }),
    });
  });

  it('defaults actorId to null for a System actor, but still requires correlationId', async () => {
    await service.record({
      correlationId: 'corr-2',
      action: 'outbox.reconciled',
      entityType: 'OutboxEvent',
      entityId: 'event-1',
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actorId: null, correlationId: 'corr-2' }),
    });
  });

  it('uses the passed transaction client instead of the default one when provided', async () => {
    const tx = {
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-2' }) },
    };

    await service.record(
      {
        correlationId: 'corr-3',
        action: 'test.tx',
        entityType: 'Test',
        entityId: 't1',
      },
      tx as never,
    );

    expect(tx.auditLog.create).toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
