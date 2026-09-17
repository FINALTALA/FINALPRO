import { Module } from '@nestjs/common';
import { IdempotencyCompletionService } from './idempotency-completion.service';

@Module({
  providers: [IdempotencyCompletionService],
  exports: [IdempotencyCompletionService],
})
export class IdempotencyModule {}
