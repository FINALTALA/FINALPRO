import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PeriodicTask } from '../common/periodic-task.util';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { OfferDraftsService } from './offer-drafts.service';

const SWEEP_INTERVAL_MS = 60 * 60_000;

/**
 * Hourly clean-up of product-entry drafts, behind the
 * `offer_draft_cleanup_enabled` flag (off by default): an OPEN draft left
 * untouched for 90 days is closed as ABANDONED, and every closed draft's
 * images that nothing else uses are deleted (OfferDraftsService.sweepOnce /
 * cleanUploads - never an image of a product, a storefront, a branch or an
 * open draft). Discarding or creating a draft already cleans its images at
 * once; this catches abandoned drafts and any clean-up that was cut short.
 */
@Injectable()
export class DraftUploadSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DraftUploadSweepService.name);
  private readonly task = new PeriodicTask(
    SWEEP_INTERVAL_MS,
    async () => {
      await this.runOnce();
    },
    (err) => this.logger.error('Draft clean-up sweep failed', err as Error),
    'DraftUploadSweep',
  );

  constructor(
    private readonly drafts: OfferDraftsService,
    private readonly flags: FeatureFlagsService,
  ) {}

  onModuleInit() {
    this.task.start();
  }

  onModuleDestroy() {
    this.task.stop();
  }

  async runOnce(now = new Date()) {
    if (!(await this.flags.isEnabled('offer_draft_cleanup_enabled'))) {
      return { disabled: true, abandoned: 0, cleaned: 0, removed: 0 };
    }
    const r = await this.drafts.sweepOnce(now);
    if (r.abandoned || r.removed) {
      this.logger.log(
        `Draft clean-up: ${r.abandoned} abandoned, ${r.removed} unused images removed`,
      );
    }
    return { disabled: false, ...r };
  }
}
