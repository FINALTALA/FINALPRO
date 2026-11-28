import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  PayloadTooLargeException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { createWriteStream, promises as fs } from 'fs';
import * as path from 'path';
import type { Request } from 'express';
import {
  MediaCategory,
  MediaStatus,
  PlatformMediaKind,
  Prisma,
} from '../../generated/prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { PeriodicTask } from '../common/periodic-task.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertSeparateFromUploads,
  keyPath,
  mediaRoot,
  mediaTmpDir,
  previewQuery,
  storageKey,
} from './media-storage';
import { UPLOAD_HARD_CAP, validateMediaFile } from './media-validate';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const busboy = require('busboy') as (cfg: {
  headers: Request['headers'];
  limits: Record<string, number>;
}) => NodeJS.WritableStream & {
  on(event: string, cb: (...args: never[]) => void): unknown;
};

/**
 * VIA phase 5 - the platform Media Library (PLATFORM_ADMIN).
 *
 * Upload: the multipart file is streamed (busboy) into <root>/.tmp under a
 * generated name, hashed (SHA-256) and capped at 100 MiB while it streams;
 * an interrupted or over-size upload is deleted at once. The real bytes are
 * then validated (media-validate.ts). Valid: a PENDING row, the file moved
 * to its generated key, the row marked VALID - a crash in between leaves a
 * PENDING row the sweeper removes with its file. Invalid: the temporary
 * file is deleted and nothing is stored.
 *
 * Usage (MediaUsage, written by Phase 6): any reference - draft, scheduled,
 * published or a restorable revision - blocks archive and purge. Purge:
 * only an unreferenced asset archived 30+ days ago; the row turns PURGING,
 * the file is deleted (retried by the sweeper until it succeeds), then the
 * row goes.
 */

export const PURGE_AFTER_DAYS = 30;
const STALE_MS = 60 * 60 * 1000; // temp files / PENDING rows older than 1 h
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const PAGE_MAX = 60;
const CATEGORIES = Object.values(MediaCategory);

function bad(code: string, message: string): never {
  throw new BadRequestException({ code, message });
}

/** A display label only (never used on disk): trimmed, control characters removed. */
export function cleanName(raw: string | undefined, fallback: string): string {
  const base = (raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, ' ')
    .trim();
  const name = (base || fallback).slice(0, 200).trim();
  return name || fallback;
}

@Injectable()
export class MediaLibraryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MediaLibraryService.name);
  private readonly sweeper = new PeriodicTask(
    SWEEP_INTERVAL_MS,
    () => this.sweepOnce().then(() => undefined),
    (err) => this.logger.error('Platform media sweep failed', err as Error),
    'PlatformMediaSweep',
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async onModuleInit() {
    assertSeparateFromUploads();
    await fs.mkdir(mediaTmpDir(), { recursive: true });
    this.sweeper.start();
  }

  onModuleDestroy() {
    this.sweeper.stop();
  }

  // ------------------------------------------------------------------
  // Upload

  /** Streams the single multipart "file" to a temporary file under the hard cap. */
  private receive(
    req: Request,
  ): Promise<{ tmp: string; size: number; sha256: string; filename: string }> {
    return new Promise((resolve, reject) => {
      const tmp = path.join(mediaTmpDir(), `${randomUUID()}.part`);
      let settled = false;
      let gotFile = false;
      let size = 0;
      let truncated = false;
      let filename = '';
      const hash = createHash('sha256');
      let out: ReturnType<typeof createWriteStream> | null = null;

      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        // Delete only once the write stream has really closed (an open
        // handle blocks the delete on Windows); retried a few times.
        const remove = async () => {
          for (let i = 0; i < 5; i++) {
            try {
              await fs.rm(tmp, { force: true });
              return;
            } catch {
              await new Promise((r) => setTimeout(r, 100));
            }
          }
        };
        const w = out;
        if (w && !w.closed) {
          w.once('close', () => void remove().finally(() => reject(err)));
          w.destroy();
        } else {
          void remove().finally(() => reject(err));
        }
      };

      let bb: ReturnType<typeof busboy>;
      try {
        bb = busboy({
          headers: req.headers,
          limits: { files: 1, fileSize: UPLOAD_HARD_CAP, fields: 4, parts: 6 },
        });
      } catch {
        return reject(
          new BadRequestException({
            code: 'MEDIA_MULTIPART_REQUIRED',
            message: 'Send the file as multipart/form-data',
          }),
        );
      }

      bb.on('file', ((
        field: string,
        stream: NodeJS.ReadableStream & { truncated?: boolean },
        info: { filename?: string },
      ) => {
        if (field !== 'file' || gotFile) {
          stream.resume();
          return;
        }
        gotFile = true;
        filename = info?.filename ?? '';
        out = createWriteStream(tmp, { flags: 'wx' });
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length;
          hash.update(chunk);
        });
        stream.on('limit', () => {
          truncated = true;
          fail(
            new PayloadTooLargeException({
              code: 'MEDIA_TOO_LARGE',
              message: 'A file is at most 100 MiB',
            }),
          );
          stream.resume();
        });
        out.on('error', fail);
        stream.pipe(out);
      }) as never);
      bb.on('error', fail as never);
      bb.on('close', (() => {
        if (settled) return;
        if (!gotFile || !out) {
          fail(
            new BadRequestException({
              code: 'MEDIA_FILE_REQUIRED',
              message: 'A "file" part is required',
            }),
          );
          return;
        }
        const done = () => {
          if (settled) return;
          if (truncated) return;
          settled = true;
          resolve({ tmp, size, sha256: hash.digest('hex'), filename });
        };
        if (out.writableFinished) done();
        else out.on('finish', done);
      }) as never);
      // The client went away mid-upload: nothing of it stays.
      req.on('aborted', () =>
        fail(
          new BadRequestException({
            code: 'MEDIA_UPLOAD_ABORTED',
            message: 'The upload was interrupted',
          }),
        ),
      );
      req.on('close', () => {
        if (!settled && !req.complete) {
          fail(
            new BadRequestException({
              code: 'MEDIA_UPLOAD_ABORTED',
              message: 'The upload was interrupted',
            }),
          );
        }
      });
      req.pipe(bb);
    });
  }

  async upload(
    req: Request,
    actorId: string,
    categoryRaw: string | undefined,
    nameRaw: string | undefined,
    correlationId: string | undefined,
  ) {
    const category = (categoryRaw ?? '').toUpperCase();
    if (!(CATEGORIES as string[]).includes(category)) {
      // Drain nothing: refuse before reading the body.
      bad(
        'INVALID_CATEGORY',
        `category must be one of ${CATEGORIES.join(', ')}`,
      );
    }
    const received = await this.receive(req);
    let movedTo: string | null = null;
    let createdId: string | null = null;
    try {
      const media = await validateMediaFile(received.tmp, received.size);
      const id = randomUUID();
      const key = storageKey(category, id, media.ext);
      const name = cleanName(
        nameRaw,
        cleanName(
          path.parse(received.filename).name,
          `${media.kind.toLowerCase()}-${id.slice(0, 8)}`,
        ),
      );
      // 1) PENDING row (a crash after this is swept), 2) move, 3) VALID.
      await this.prisma.mediaAsset.create({
        data: {
          id,
          name,
          category: category as MediaCategory,
          kind: media.kind as PlatformMediaKind,
          mimeType: media.mime,
          storageKey: key,
          sizeBytes: received.size,
          width: media.width,
          height: media.height,
          durationMs: media.durationMs,
          videoCodec: media.videoCodec,
          audioCodec: media.audioCodec,
          sha256: received.sha256,
          uploadedById: actorId,
        },
      });
      createdId = id;
      const dest = keyPath(key);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(received.tmp, dest);
      movedTo = dest;
      const asset = await this.prisma.$transaction(async (tx) => {
        const a = await tx.mediaAsset.update({
          where: { id },
          data: { validationState: 'VALID' },
        });
        await this.auditLog.record(
          {
            actorId,
            correlationId,
            action: 'media.uploaded',
            entityType: 'MediaAsset',
            entityId: id,
            afterState: {
              category,
              kind: media.kind,
              mime: media.mime,
              size_bytes: received.size,
              width: media.width,
              height: media.height,
              duration_ms: media.durationMs,
              sha256: received.sha256,
            },
          },
          tx,
        );
        return a;
      });
      return this.dto(asset, 0);
    } catch (err) {
      await fs.rm(received.tmp, { force: true });
      if (movedTo) await fs.rm(movedTo, { force: true });
      // a PENDING row left by a failure after its insert
      if (createdId) {
        await this.prisma.mediaAsset
          .deleteMany({ where: { id: createdId, validationState: 'PENDING' } })
          .catch(() => undefined);
      }
      throw err;
    }
  }

  // ------------------------------------------------------------------
  // Reads

  private dto(a: Prisma.MediaAssetGetPayload<object>, usageCount: number) {
    const purgeEligibleAt = a.archivedAt
      ? new Date(a.archivedAt.getTime() + PURGE_AFTER_DAYS * 86_400_000)
      : null;
    return {
      id: a.id,
      name: a.name,
      category: a.category,
      kind: a.kind,
      mime_type: a.mimeType,
      size_bytes: a.sizeBytes,
      width: a.width,
      height: a.height,
      duration_ms: a.durationMs,
      video_codec: a.videoCodec,
      audio_codec: a.audioCodec,
      sha256: a.sha256,
      validation_state: a.validationState,
      status: a.status,
      uploaded_by_id: a.uploadedById,
      created_at: a.createdAt.toISOString(),
      updated_at: a.updatedAt.toISOString(),
      archived_at: a.archivedAt?.toISOString() ?? null,
      purge_eligible_at: purgeEligibleAt?.toISOString() ?? null,
      usage_count: usageCount,
      preview_url:
        a.validationState === 'VALID' && a.status !== 'PURGING'
          ? `/media/preview/${a.id}?${previewQuery(a.id)}`
          : null,
    };
  }

  async list(q: {
    q?: string;
    category?: string;
    kind?: string;
    status?: string;
    cursor?: string;
    limit?: string;
  }) {
    const limit = Math.min(
      Math.max(Number.parseInt(q.limit ?? '24', 10) || 24, 1),
      PAGE_MAX,
    );
    const and: Prisma.MediaAssetWhereInput[] = [{ validationState: 'VALID' }];
    const status = (q.status ?? 'ACTIVE').toUpperCase();
    if (status === 'ACTIVE' || status === 'ARCHIVED')
      and.push({ status: status as MediaStatus });
    else if (status !== 'ALL')
      bad('INVALID_FILTER', 'status must be ACTIVE, ARCHIVED or ALL');
    else and.push({ status: { not: 'PURGING' } });
    if (q.category && q.category !== 'all') {
      const c = q.category.toUpperCase();
      if (!(CATEGORIES as string[]).includes(c))
        bad('INVALID_FILTER', 'Unknown category');
      and.push({ category: c as MediaCategory });
    }
    if (q.kind && q.kind !== 'all') {
      const k = q.kind.toUpperCase();
      if (k !== 'IMAGE' && k !== 'VIDEO')
        bad('INVALID_FILTER', 'kind must be IMAGE or VIDEO');
      and.push({ kind: k as PlatformMediaKind });
    }
    if (q.q?.trim())
      and.push({ name: { contains: q.q.trim(), mode: 'insensitive' } });
    if (q.cursor) {
      let c: { t: string; id: string };
      try {
        c = JSON.parse(Buffer.from(q.cursor, 'base64url').toString());
        if (typeof c.t !== 'string' || typeof c.id !== 'string')
          throw new Error();
      } catch {
        bad('INVALID_CURSOR', 'Invalid cursor');
      }
      const t = new Date(c.t);
      and.push({
        OR: [{ createdAt: { lt: t } }, { createdAt: t, id: { lt: c.id } }],
      });
    }
    const rows = await this.prisma.mediaAsset.findMany({
      where: { AND: and },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: { _count: { select: { usages: true } } },
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((a) => this.dto(a, a._count.usages)),
      next_cursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({ t: last.createdAt.toISOString(), id: last.id }),
            ).toString('base64url')
          : null,
    };
  }

  async detail(id: string) {
    const a = await this.prisma.mediaAsset.findFirst({
      where: { id, validationState: 'VALID' },
      include: {
        usages: { orderBy: { createdAt: 'desc' } },
        uploadedBy: {
          select: { customerProfile: { select: { displayName: true } } },
        },
      },
    });
    if (!a)
      throw new NotFoundException({
        code: 'MEDIA_NOT_FOUND',
        message: 'Media asset not found',
      });
    const now = Date.now();
    const eligible =
      a.status === 'ARCHIVED' &&
      a.usages.length === 0 &&
      !!a.archivedAt &&
      a.archivedAt.getTime() + PURGE_AFTER_DAYS * 86_400_000 <= now;
    return {
      ...this.dto(a, a.usages.length),
      uploaded_by_name: a.uploadedBy.customerProfile?.displayName ?? null,
      usages: a.usages.map((u) => ({
        id: u.id,
        owner_type: u.ownerType,
        owner_id: u.ownerId,
        revision_id: u.revisionId || null,
        state: u.state,
        label: u.label,
        created_at: u.createdAt.toISOString(),
      })),
      public_url: a.usages.some((u) => u.state === 'PUBLISHED')
        ? this.publicPath(a)
        : null,
      actions: {
        can_archive: a.status === 'ACTIVE' && a.usages.length === 0,
        can_restore: a.status === 'ARCHIVED',
        can_purge: eligible,
      },
    };
  }

  publicPath(a: {
    id: string;
    sha256: string | null;
    storageKey: string | null;
  }) {
    const ext = a.storageKey!.split('.').pop();
    return `/media/p/${a.id}/${a.sha256!.slice(0, 16)}.${ext}`;
  }

  // ------------------------------------------------------------------
  // Archive / restore / purge (row locked, usage re-read under it)

  private async lockAsset(tx: Prisma.TransactionClient, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM media_assets WHERE id = ${id} AND "validationState" = 'VALID' FOR UPDATE`;
    if (rows.length === 0)
      throw new NotFoundException({
        code: 'MEDIA_NOT_FOUND',
        message: 'Media asset not found',
      });
    return tx.mediaAsset.findUniqueOrThrow({
      where: { id },
      include: {
        usages: { select: { ownerType: true, ownerId: true, state: true } },
      },
    });
  }

  private inUse(
    usages: { ownerType: string; ownerId: string; state: string }[],
  ): never {
    throw new ConflictException({
      code: 'MEDIA_IN_USE',
      message:
        'This asset is referenced by content (draft, scheduled, published or a restorable revision)',
      details: usages.map((u) => ({
        owner_type: u.ownerType,
        owner_id: u.ownerId,
        state: u.state,
      })),
    });
  }

  async archive(id: string, actorId: string, correlationId?: string) {
    return this.prisma.$transaction(async (tx) => {
      const a = await this.lockAsset(tx, id);
      if (a.status !== 'ACTIVE')
        throw new ConflictException({
          code: 'MEDIA_NOT_ACTIVE',
          message: 'Only an active asset can be archived',
        });
      if (a.usages.length > 0) this.inUse(a.usages);
      await tx.mediaAsset.update({
        where: { id },
        data: {
          status: 'ARCHIVED',
          archivedAt: new Date(),
          archivedById: actorId,
        },
      });
      await this.auditLog.record(
        {
          actorId,
          correlationId,
          action: 'media.archived',
          entityType: 'MediaAsset',
          entityId: id,
        },
        tx,
      );
      return { id, status: 'ARCHIVED' as const };
    });
  }

  async restore(id: string, actorId: string, correlationId?: string) {
    return this.prisma.$transaction(async (tx) => {
      const a = await this.lockAsset(tx, id);
      if (a.status !== 'ARCHIVED')
        throw new ConflictException({
          code: 'MEDIA_NOT_ARCHIVED',
          message: 'Only an archived asset can be restored',
        });
      await tx.mediaAsset.update({
        where: { id },
        data: { status: 'ACTIVE', archivedAt: null, archivedById: null },
      });
      await this.auditLog.record(
        {
          actorId,
          correlationId,
          action: 'media.restored',
          entityType: 'MediaAsset',
          entityId: id,
        },
        tx,
      );
      return { id, status: 'ACTIVE' as const };
    });
  }

  async purge(id: string, actorId: string, correlationId?: string) {
    const key = await this.prisma.$transaction(async (tx) => {
      const a = await this.lockAsset(tx, id);
      if (a.status !== 'ARCHIVED')
        throw new ConflictException({
          code: 'MEDIA_NOT_ARCHIVED',
          message: 'Only an archived asset can be purged',
        });
      if (a.usages.length > 0) this.inUse(a.usages);
      if (
        !a.archivedAt ||
        a.archivedAt.getTime() + PURGE_AFTER_DAYS * 86_400_000 > Date.now()
      ) {
        throw new ConflictException({
          code: 'MEDIA_PURGE_TOO_EARLY',
          message: `An asset can be purged ${PURGE_AFTER_DAYS} days after it was archived`,
        });
      }
      await tx.mediaAsset.update({
        where: { id },
        data: { status: 'PURGING', purgeRequestedAt: new Date() },
      });
      await this.auditLog.record(
        {
          actorId,
          correlationId,
          action: 'media.purge_requested',
          entityType: 'MediaAsset',
          entityId: id,
          beforeState: {
            name: a.name,
            storage_key: a.storageKey,
            sha256: a.sha256,
            size_bytes: a.sizeBytes,
          },
        },
        tx,
      );
      return a.storageKey!;
    });
    const done = await this.finishPurge(id, key);
    return { id, purged: done, status: done ? 'PURGED' : 'PURGING' };
  }

  /** Deletes the file, then the row. Safe to repeat; a failure leaves PURGING for the sweeper. */
  async finishPurge(id: string, key: string): Promise<boolean> {
    try {
      await fs.rm(keyPath(key), { force: true });
      await this.prisma.$transaction(async (tx) => {
        await tx.mediaAsset.deleteMany({ where: { id, status: 'PURGING' } });
        await this.auditLog.record(
          {
            actorId: null,
            correlationId: randomUUID(),
            action: 'media.purged',
            entityType: 'MediaAsset',
            entityId: id,
          },
          tx,
        );
      });
      return true;
    } catch (err) {
      this.logger.warn(
        `Media ${id}: physical purge not finished, retried later: ${(err as Error).message}`,
      );
      return false;
    }
  }

  // ------------------------------------------------------------------
  // Sweep: stale temp files, stale PENDING rows, unfinished purges.

  async sweepOnce(now = Date.now()) {
    const result = { tmp_removed: 0, pending_removed: 0, purges_finished: 0 };
    try {
      for (const f of await fs.readdir(mediaTmpDir())) {
        const p = path.join(mediaTmpDir(), f);
        const st = await fs.stat(p).catch(() => null);
        if (st && now - st.mtimeMs > STALE_MS) {
          await fs.rm(p, { force: true });
          result.tmp_removed++;
        }
      }
    } catch {
      // no temp dir yet
    }
    const pending = await this.prisma.mediaAsset.findMany({
      where: {
        validationState: 'PENDING',
        createdAt: { lt: new Date(now - STALE_MS) },
      },
      select: { id: true, storageKey: true },
    });
    for (const p of pending) {
      if (p.storageKey)
        await fs
          .rm(keyPath(p.storageKey), { force: true })
          .catch(() => undefined);
      await this.prisma.mediaAsset.deleteMany({
        where: { id: p.id, validationState: 'PENDING' },
      });
      result.pending_removed++;
    }
    const purging = await this.prisma.mediaAsset.findMany({
      where: { status: 'PURGING' },
      select: { id: true, storageKey: true },
    });
    for (const p of purging) {
      if (p.storageKey && (await this.finishPurge(p.id, p.storageKey)))
        result.purges_finished++;
    }
    return result;
  }

  /** For the backup manifest: every stored asset and its hash. */
  async manifest() {
    const rows = await this.prisma.mediaAsset.findMany({
      where: { validationState: 'VALID', status: { not: 'PURGING' } },
      orderBy: { id: 'asc' },
      select: { id: true, storageKey: true, sha256: true, sizeBytes: true },
    });
    return { root: mediaRoot(), assets: rows };
  }
}
