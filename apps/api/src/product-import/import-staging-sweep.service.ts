import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { readdir, rm, stat, unlink } from 'fs/promises';
import * as path from 'path';
import { PeriodicTask } from '../common/periodic-task.util';
import { OfferDraftsService } from '../offer-drafts/offer-drafts.service';
import { PrismaService } from '../prisma/prisma.service';
import { ownUploadUrl, uploadsDir } from '../uploads/uploads.util';
import { importStagingRoot, incomingDir, stagingDirOf } from './import-images';

const SWEEP_INTERVAL_MS = 10 * 60_000;
/** A confirm that has not finished after this long was interrupted. */
export const CONFIRM_STUCK_MINUTES = 15;
/** A staging folder or an upload left on disk without a check after this long is removed. */
export const ORPHAN_AFTER_MINUTES = 90;

/**
 * Images in bulk (2026-11-18): the import's private staging is cleaned
 * every 10 minutes and when the API starts - a security clean-up, NOT
 * behind the draft clean-up flag:
 *  - an unconfirmed check that expired: EXPIRED, its staged images removed;
 *  - an interrupted confirm (CONFIRMING for 15 minutes): the public copies
 *    it planned are removed unless something uses them, then EXPIRED;
 *  - a staging folder whose check is gone or closed, and uploads left in
 *    the incoming folder (a request cut short): removed.
 */
@Injectable()
export class ImportStagingSweepService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ImportStagingSweepService.name);
  private readonly task = new PeriodicTask(
    SWEEP_INTERVAL_MS,
    () => this.runOnce().then(() => undefined),
    (err) => this.logger.error('Import staging clean-up failed', err as Error),
    ImportStagingSweepService.name,
  );
  private startup: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly drafts: OfferDraftsService,
  ) {}

  onModuleInit() {
    this.task.start();
    if (process.env.NODE_ENV !== 'test') {
      this.startup = setTimeout(() => {
        this.runOnce().catch((err) =>
          this.logger.error('Import staging clean-up failed', err as Error),
        );
      }, 30_000);
      this.startup.unref?.();
    }
  }

  onModuleDestroy() {
    this.task.stop();
    if (this.startup) clearTimeout(this.startup);
  }

  async runOnce(now = new Date()) {
    let expired = 0;
    let undone = 0;
    let removedFiles = 0;
    let removedFolders = 0;

    // 1) checks never confirmed in time
    const stale = await this.prisma.importBatch.findMany({
      where: {
        kind: 'PRODUCT_DRAFTS',
        status: 'CHECKED',
        expiresAt: { lt: now },
      },
      select: { id: true, vendorId: true },
      take: 200,
    });
    for (const b of stale) {
      const r = await this.prisma.importBatch.updateMany({
        where: { id: b.id, status: 'CHECKED' },
        data: { status: 'EXPIRED' },
      });
      expired += r.count;
      await rm(stagingDirOf(b.vendorId, b.id), {
        recursive: true,
        force: true,
      });
      removedFolders += 1;
    }

    // 2) confirms that never finished: undo their public copies
    const stuck = await this.prisma.importBatch.findMany({
      where: {
        kind: 'PRODUCT_DRAFTS',
        status: 'CONFIRMING',
        confirmStartedAt: {
          lt: new Date(now.getTime() - CONFIRM_STUCK_MINUTES * 60_000),
        },
      },
      select: { id: true, vendorId: true, plannedUploads: true },
      take: 50,
    });
    for (const b of stuck) {
      const files = Array.isArray(b.plannedUploads)
        ? (b.plannedUploads as unknown[]).filter(
            (f): f is string =>
              typeof f === 'string' && /^[0-9a-f]{32}\.(jpg|png|webp)$/.test(f),
          )
        : [];
      for (const f of files) {
        const url = ownUploadUrl(b.vendorId, f);
        if (await this.drafts.isUploadInUse(url, f, '')) continue;
        try {
          await unlink(path.join(uploadsDir(), 'vendors', b.vendorId, f));
          removedFiles += 1;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
      const r = await this.prisma.importBatch.updateMany({
        where: { id: b.id, status: 'CONFIRMING' },
        data: { status: 'EXPIRED' },
      });
      undone += r.count;
      await rm(stagingDirOf(b.vendorId, b.id), {
        recursive: true,
        force: true,
      });
      removedFolders += 1;
    }

    // 3) staging folders without a live check, and cut-short uploads
    const old = now.getTime() - ORPHAN_AFTER_MINUTES * 60_000;
    const batchesRoot = path.join(importStagingRoot(), 'batches');
    for (const vendorId of await list(batchesRoot)) {
      const vendorDir = path.join(batchesRoot, vendorId);
      for (const batchId of await list(vendorDir)) {
        const dir = path.join(vendorDir, batchId);
        const b = /^[0-9a-f-]{36}$/.test(batchId)
          ? await this.prisma.importBatch.findUnique({
              where: { id: batchId },
              select: { status: true },
            })
          : null;
        const live = b && (b.status === 'CHECKED' || b.status === 'CONFIRMING');
        // no row yet: a check may still be reading its ZIP - only an old folder goes
        if (live || (!b && (await mtime(dir)) > old)) continue;
        await rm(dir, { recursive: true, force: true });
        removedFolders += 1;
      }
    }
    for (const f of await list(incomingDir())) {
      const file = path.join(incomingDir(), f);
      if ((await mtime(file)) > old) continue;
      await rm(file, { force: true });
      removedFiles += 1;
    }
    if (expired || undone || removedFiles || removedFolders)
      this.logger.log(
        `Import staging clean-up: ${expired} expired, ${undone} interrupted confirms undone, ${removedFolders} folders and ${removedFiles} files removed`,
      );
    return { expired, undone, removedFiles, removedFolders };
  }
}

async function list(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function mtime(p: string): Promise<number> {
  try {
    return (await stat(p)).mtimeMs;
  } catch {
    return 0;
  }
}
