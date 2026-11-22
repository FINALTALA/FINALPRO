import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PeriodicTask } from '../common/periodic-task.util';
import { SalesRankService } from './sales-rank.service';

const SWEEP_INTERVAL_MS = 60 * 60_000;

/**
 * PD-5.2: rebuilds the sales rank once an hour (and once shortly after
 * boot). A tick that finds another rebuild running skips - the rebuild
 * is a full, idempotent replacement, so a skipped tick loses nothing.
 * Not started under tests (PeriodicTask); tests call rebuild() directly.
 */
@Injectable()
export class SalesRankSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SalesRankSweepService.name);
  private readonly task = new PeriodicTask(
    SWEEP_INTERVAL_MS,
    () => this.sweepOnce().then(() => undefined),
    (err) => this.logger.error('Sales rank rebuild failed', err as Error),
    SalesRankSweepService.name,
  );
  private bootTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly salesRank: SalesRankService) {}

  onModuleInit() {
    this.task.start();
    if (process.env.NODE_ENV !== 'test') {
      this.bootTimer = setTimeout(() => {
        this.sweepOnce().catch((err) =>
          this.logger.error('Sales rank rebuild failed', err as Error),
        );
      }, 30_000);
      this.bootTimer.unref?.();
    }
  }

  onModuleDestroy() {
    this.task.stop();
    if (this.bootTimer) clearTimeout(this.bootTimer);
  }

  sweepOnce() {
    return this.salesRank.rebuild({ trigger: 'SCHEDULED', skipIfBusy: true });
  }
}
