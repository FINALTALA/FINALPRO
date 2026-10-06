import { Module } from '@nestjs/common';
import { NotificationChannelService } from './notification-channel.service';
import { OutboxEventService } from './outbox-event.service';
import { OutboxRelayService } from './outbox-relay.service';

@Module({
  providers: [
    OutboxEventService,
    OutboxRelayService,
    NotificationChannelService,
  ],
  exports: [OutboxEventService, OutboxRelayService, NotificationChannelService],
})
export class OutboxModule {}
