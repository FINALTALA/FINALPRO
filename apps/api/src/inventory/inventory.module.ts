import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { OutboxModule } from '../outbox/outbox.module';
import { InventoryController } from './inventory.controller';
import { StockBoardService } from './stock-board.service';

@Module({
  imports: [AuditModule, AuthModule, IdempotencyModule, OutboxModule],
  controllers: [InventoryController],
  // «إدارة مخزون الفرع v1» (2026-11-22): the board / line / log reads
  providers: [StockBoardService],
})
export class InventoryModule {}
