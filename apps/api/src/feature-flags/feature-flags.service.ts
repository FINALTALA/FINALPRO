import { BadRequestException, Injectable } from '@nestjs/common';
import { AuditLogService } from '../audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  FEATURE_FLAG_REGISTRY,
  FeatureFlagKey,
  isKnownFeatureFlag,
} from './feature-flags.registry';

export interface FeatureFlagListItem {
  key: string;
  enabled: boolean;
  description: string;
}

/**
 * Sprint 25 (FR-ADMIN-004). Absence of a `FeatureFlag` row for a known
 * key means `enabled: false` - the registry's own, only default -
 * everywhere this is read, never distinguished from an explicit
 * `enabled: false` row. A row is created lazily, only on the first
 * write that actually moves the effective value away from that
 * default.
 */
@Injectable()
export class FeatureFlagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  /** Read-only gate check for other services/controllers - never
   * throws, the `FeatureFlagKey` union already rules out a typo'd key
   * at compile time. */
  async isEnabled(key: FeatureFlagKey): Promise<boolean> {
    const row = await this.prisma.featureFlag.findUnique({ where: { key } });
    return row?.enabled ?? false;
  }

  /** Every registry key, always - including one with no DB row yet
   * (shown as `enabled: false`) - so an admin can see and toggle a
   * flag the very first time, never "a key that doesn't exist yet." */
  async list(): Promise<FeatureFlagListItem[]> {
    const keys = Object.keys(FEATURE_FLAG_REGISTRY);
    const rows = await this.prisma.featureFlag.findMany({
      where: { key: { in: keys } },
    });
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return Object.entries(FEATURE_FLAG_REGISTRY).map(([key, def]) => ({
      key,
      enabled: byKey.get(key)?.enabled ?? false,
      description: def.description,
    }));
  }

  /**
   * Review-round fix (lock-before-create race): `pg_advisory_xact_lock`
   * on this key, same convention `stock-lock.util.ts` already
   * established (`'finalpro:<resource>:' || naturalKey`), taken BEFORE
   * the row is even looked up - a plain `SELECT ... FOR UPDATE` locks
   * nothing when the row doesn't exist yet, so two concurrent first
   * writes to the same never-configured key could otherwise both reach
   * `create()` and collide on the unique `key` constraint.
   *
   * Review-round fix (absent-row semantics): the registry's default is
   * `enabled: false`, full stop - a PUT that merely confirms that
   * default (no row, `enabled: false` requested) is a genuine no-op:
   * no row is created, no AuditLog row is written, because nothing
   * about the effective state actually changed. Only a PUT that moves
   * the effective value away from `false` ever creates a row - and
   * when it does, `beforeState` is `{enabled: false}` (the real
   * previous effective value), never a fabricated `null`.
   */
  async setFlag(
    key: string,
    enabled: boolean,
    actorId: string,
    correlationId: string,
  ): Promise<{ key: string; enabled: boolean }> {
    if (!isKnownFeatureFlag(key)) {
      throw new BadRequestException({
        code: 'UNKNOWN_FEATURE_FLAG',
        message: `"${key}" is not a supported feature flag`,
      });
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('finalpro:feature_flag:' || ${key}))`;
      const existing = await tx.featureFlag.findUnique({ where: { key } });

      if (!existing) {
        if (!enabled) {
          return { key, enabled: false };
        }
        await tx.featureFlag.create({
          data: {
            key,
            enabled: true,
            description:
              FEATURE_FLAG_REGISTRY[key as FeatureFlagKey].description,
          },
        });
        await this.auditLog.record(
          {
            actorId,
            correlationId,
            action: 'feature_flag.changed',
            entityType: 'FeatureFlag',
            entityId: key,
            beforeState: { enabled: false },
            afterState: { enabled: true },
          },
          tx,
        );
        return { key, enabled: true };
      }

      if (existing.enabled === enabled) {
        return { key, enabled: existing.enabled };
      }
      await tx.featureFlag.update({ where: { key }, data: { enabled } });
      await this.auditLog.record(
        {
          actorId,
          correlationId,
          action: 'feature_flag.changed',
          entityType: 'FeatureFlag',
          entityId: key,
          beforeState: { enabled: existing.enabled },
          afterState: { enabled },
        },
        tx,
      );
      return { key, enabled };
    });
  }
}
