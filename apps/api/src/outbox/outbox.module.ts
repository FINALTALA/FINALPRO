import { Module } from '@nestjs/common';
import { OutboxEventService } from './outbox-event.service';

@Module({
  providers: [OutboxEventService],
  exports: [OutboxEventService],
})
export class OutboxModule {}
